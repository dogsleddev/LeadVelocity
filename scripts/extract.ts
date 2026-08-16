/**
 * `npm run extract` - re-pull the committed real extract from DataSF into `data/`.
 *
 * `data/permits.json`, `data/contacts.json` and `data/manifest.json` are the real
 * records this project is built on. The unit tests read them, the replay harness
 * releases them, and the prospect pool is derived from them, so they are
 * committed rather than fetched at test time: the demo must not depend on a
 * public agency endpoint being up. This script is how they get refreshed.
 *
 * It reproduces the pull that produced the current files:
 *
 *   - permits from Socrata `i98e-djp9`, filtered `filed_date > <window start>`,
 *     paged 1,000 rows at a time
 *   - contacts from Socrata `3pee-9qhc`, fetched by exact `permit_number IN (...)`
 *     in chunks of 150 permits, so the join is on the key rather than on a date
 *     proxy that would drag in unrelated rows
 *   - bounded retries with exponential backoff on every request, inherited from
 *     `httpGetJson` through the Socrata adapter
 *   - a manifest recording agency, dataset id, endpoint, retrieval time and row
 *     counts, so any fact later traced back to these files can be attributed
 *
 * One deliberate difference from the original one-off pull: pages are ordered by
 * the Socrata system column `:id` (the adapter's default) rather than by
 * `permit_number`. `permit_number` is not unique in this dataset, and offset
 * paging over a non-unique sort key silently duplicates and drops rows. Row
 * ORDER in the output file therefore differs from the committed copy; row
 * CONTENT is the same universe of records.
 *
 * Nothing here touches Supabase and nothing here writes to the decision log.
 * This is a build-time data tool, not part of the running company.
 *
 * Flags:
 *   --days=N     window size in days, counted back from now. Default 180.
 *   --since=TS   explicit window start, overriding --days. Use
 *                --since=2026-02-15T00:00:00 to reproduce the committed extract.
 *   --out=DIR    output directory. Default <repo>/data.
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { getSource } from '@/lib/adapters/sources/registry';
import {
  createSocrataClientFor,
  soqlLiteral,
  type SocrataClient,
  type SocrataQuery,
} from '@/lib/adapters/sources/socrata';
import type { RawPayload } from '@/lib/adapters/sources/source-record';
import { instantToIsoInZone, toFloatingTimestamp } from '@/lib/domain/permit-normalizer';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const PERMITS_SOURCE_ID = 'datasf.building_permits';
const CONTACTS_SOURCE_ID = 'datasf.building_permit_contacts';

/** Window size when `--days` and `--since` are both absent. */
const DEFAULT_WINDOW_DAYS = 180;

/** Rows per permit page. */
const PERMIT_PAGE_SIZE = 1_000;

/**
 * Permit numbers per contacts request. 150 keys is comfortably inside SODA's
 * practical URL length for an `IN (...)` predicate; larger chunks start getting
 * rejected rather than throttled.
 */
const CONTACT_CHUNK_SIZE = 150;

/** Rows per contacts page. A 150-permit chunk has never approached this. */
const CONTACT_PAGE_SIZE = 5_000;

/** Attempts per request. The adapter backs off exponentially between them. */
const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 60_000;

/** Courtesy pause between requests so an unauthenticated pull is not abusive. */
const COURTESY_DELAY_MS = 120;

/** Hard stop on paging, so a malformed predicate cannot loop forever. */
const MAX_PAGES = 1_000;

const USAGE = `
Usage: npm run extract [-- --days=N] [--since=TS] [--out=DIR]

Re-pulls the real DataSF extract into data/permits.json, data/contacts.json and
data/manifest.json.

  --days=N     window size in days back from now (default ${DEFAULT_WINDOW_DAYS})
  --since=TS   explicit window start, overrides --days
               (--since=2026-02-15T00:00:00 reproduces the committed extract)
  --out=DIR    output directory (default <repo>/data)
`;

/* -------------------------------------------------------------------------- */
/* Local environment                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Load `.env.local` when it exists, so a configured `SODA_APP_TOKEN` is actually
 * used and the pull gets its own rate-limit bucket instead of the shared
 * anonymous one. `tsx` does not read dotenv files and this project has no dotenv
 * dependency; Node's own loader does not overwrite variables already set.
 */
function loadLocalEnv(): void {
  if (typeof process.loadEnvFile !== 'function') return;
  const envFile = path.join(REPO_ROOT, '.env.local');
  if (!existsSync(envFile)) return;
  try {
    process.loadEnvFile(envFile);
  } catch (cause) {
    console.warn(
      `[extract] Ignoring unreadable .env.local: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Flags                                                                      */
/* -------------------------------------------------------------------------- */

interface Flags {
  readonly days: number;
  readonly since: string | null;
  readonly outDir: string;
  readonly help: boolean;
}

class UsageError extends Error {}

function parseFlags(argv: readonly string[]): Flags {
  let days = DEFAULT_WINDOW_DAYS;
  let since: string | null = null;
  let outDir = path.join(REPO_ROOT, 'data');
  let help = false;

  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }

    const match = /^--([a-z-]+)=(.*)$/.exec(argument);
    if (match === null) throw new UsageError(`Unrecognized argument "${argument}".`);

    const [, name, rawValue] = match;
    const value = (rawValue ?? '').trim();

    if (name === 'days') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new UsageError(`--days must be a positive integer, received "${value}".`);
      }
      days = parsed;
      continue;
    }

    if (name === 'since') {
      if (toFloatingTimestamp(value) === null) {
        throw new UsageError(`--since="${value}" is not a timestamp this dataset can compare.`);
      }
      since = value;
      continue;
    }

    if (name === 'out') {
      if (value.length === 0) throw new UsageError('--out needs a directory.');
      outDir = path.resolve(value);
      continue;
    }

    throw new UsageError(`Unrecognized flag "--${name ?? ''}".`);
  }

  return { days, since, outDir, help };
}

/* -------------------------------------------------------------------------- */
/* Window                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The floating timestamp the `filed_date` predicate compares against.
 *
 * DataSF's timestamps carry no offset and mean San Francisco wall time, so the
 * cutoff instant is converted into that zone before the literal is built.
 */
function windowStart(flags: Flags, now: Date): string {
  const explicit = flags.since === null ? null : toFloatingTimestamp(flags.since);
  if (explicit !== null) return explicit;

  const cutoffMs = now.getTime() - flags.days * 24 * 60 * 60 * 1_000;
  const isoInZone = instantToIsoInZone(cutoffMs);
  const floating = isoInZone === null ? null : toFloatingTimestamp(isoInZone);
  if (floating === null) {
    throw new Error(`Could not build a ${flags.days} day window from ${now.toISOString()}.`);
  }
  return floating;
}

/* -------------------------------------------------------------------------- */
/* Paging                                                                     */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface PagedRows {
  readonly rows: RawPayload[];
  readonly pages: number;
  /** Rows the dataset returned without a usable key. Reported, never invented. */
  readonly skippedKeyless: number;
}

/**
 * Walk one query with explicit offsets.
 *
 * The adapter's own `fetchAll` would do the paging, but this loop exists so the
 * pull can print running progress and pause between requests. Ordering is left
 * to the adapter default (`:id`), which is the only column guaranteed unique and
 * therefore the only safe sort key for offset paging.
 */
async function fetchAllRows(
  client: SocrataClient,
  query: SocrataQuery,
  pageSize: number,
  label: string,
): Promise<PagedRows> {
  const rows: RawPayload[] = [];
  let pages = 0;
  let skippedKeyless = 0;
  let offset = 0;

  for (;;) {
    const page = await client.fetchPage({ ...query, limit: pageSize, offset });
    pages += 1;
    for (const record of page.records) rows.push(record.raw);
    skippedKeyless += page.skippedKeyless;

    process.stdout.write(`\r  ${label}: ${rows.length} row(s)`);

    if (!page.truncated) break;
    if (pages >= MAX_PAGES) {
      process.stdout.write('\n');
      throw new Error(`${label}: stopped at ${MAX_PAGES} pages. Narrow the window and retry.`);
    }
    offset += pageSize;
    await sleep(COURTESY_DELAY_MS);
  }

  process.stdout.write('\n');
  return { rows, pages, skippedKeyless };
}

/**
 * Contacts for a known set of permit numbers, in chunks.
 *
 * Fetching by exact join key rather than by date is what makes the contacts file
 * a true companion to the permits file: every contact row here belongs to a
 * permit that is in `permits.json`, and no permit is missing its contacts
 * because its contact row happened to be edited outside the date window.
 */
async function fetchContacts(
  client: SocrataClient,
  permitNumbers: readonly string[],
): Promise<PagedRows> {
  const rows: RawPayload[] = [];
  let pages = 0;
  let skippedKeyless = 0;

  for (let index = 0; index < permitNumbers.length; index += CONTACT_CHUNK_SIZE) {
    const chunk = permitNumbers.slice(index, index + CONTACT_CHUNK_SIZE);
    const list = chunk.map((permitNumber) => soqlLiteral(permitNumber)).join(',');

    let offset = 0;
    for (;;) {
      const page = await client.fetchPage({
        where: `permit_number IN (${list})`,
        limit: CONTACT_PAGE_SIZE,
        offset,
      });
      pages += 1;
      for (const record of page.records) rows.push(record.raw);
      skippedKeyless += page.skippedKeyless;
      if (!page.truncated) break;
      offset += CONTACT_PAGE_SIZE;
      await sleep(COURTESY_DELAY_MS);
    }

    const done = Math.min(index + CONTACT_CHUNK_SIZE, permitNumbers.length);
    process.stdout.write(
      `\r  contacts: ${rows.length} row(s) (${done}/${permitNumbers.length} permits)`,
    );
    await sleep(COURTESY_DELAY_MS);
  }

  process.stdout.write('\n');
  return { rows, pages, skippedKeyless };
}

/* -------------------------------------------------------------------------- */
/* Manifest                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Provenance for the whole extract, in the shape the existing `data/manifest.json`
 * already uses. Agency, dataset id, name and endpoint come from the source
 * registry rather than being retyped here, so the files on disk and the running
 * adapters can never disagree about where the data came from.
 */
function buildManifest(args: {
  readonly retrievedAt: string;
  readonly windowStart: string;
  readonly permitRows: number;
  readonly contactRows: number;
}): unknown {
  const permits = getSource(PERMITS_SOURCE_ID);
  const contacts = getSource(CONTACTS_SOURCE_ID);

  return {
    retrieved_at: args.retrievedAt,
    window: { filed_date_after: args.windowStart },
    sources: [
      {
        agency: permits.agency,
        dataset_id: permits.datasetId,
        name: permits.name,
        endpoint: permits.endpoint,
        rows: args.permitRows,
      },
      {
        agency: contacts.agency,
        dataset_id: contacts.datasetId,
        name: contacts.name,
        endpoint: contacts.endpoint,
        rows: args.contactRows,
        join_key: 'permit_number',
      },
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

function log(message: string): void {
  console.log(`[extract] ${message}`);
}

async function main(): Promise<number> {
  let flags: Flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`[extract] ${error.message}`);
    console.error(USAGE.trim());
    return 1;
  }

  if (flags.help) {
    console.log(USAGE.trim());
    return 0;
  }

  loadLocalEnv();

  // Captured before the pull starts: the manifest claims when retrieval began,
  // which is the conservative reading of how current the rows are.
  const retrievedAt = new Date().toISOString();
  const start = windowStart(flags, new Date());
  const where = `filed_date > ${soqlLiteral(start)}`;

  const permitsClient = createSocrataClientFor(PERMITS_SOURCE_ID, {
    pageSize: PERMIT_PAGE_SIZE,
    maxAttempts: MAX_ATTEMPTS,
    timeoutMs: TIMEOUT_MS,
  });
  const contactsClient = createSocrataClientFor(CONTACTS_SOURCE_ID, {
    pageSize: CONTACT_PAGE_SIZE,
    maxAttempts: MAX_ATTEMPTS,
    timeoutMs: TIMEOUT_MS,
  });

  log(`Window: ${where}`);
  log(`App token: ${permitsClient.hasAppToken ? 'present' : 'absent (anonymous rate limit)'}`);
  log(`Output: ${flags.outDir}`);

  log(`Pulling permits from ${permitsClient.descriptor.endpoint}`);
  const permits = await fetchAllRows(permitsClient, { where }, PERMIT_PAGE_SIZE, 'permits');
  if (permits.rows.length === 0) {
    console.error('[extract] The permits query returned nothing. Refusing to overwrite data/.');
    return 1;
  }

  const permitNumbers = [
    ...new Set(
      permits.rows
        .map((row) => (typeof row.permit_number === 'string' ? row.permit_number.trim() : ''))
        .filter((permitNumber) => permitNumber.length > 0),
    ),
  ];
  log(`${permits.rows.length} permit row(s) across ${permitNumbers.length} distinct permit numbers.`);

  log(`Pulling contacts by join key from ${contactsClient.descriptor.endpoint}`);
  const contacts = await fetchContacts(contactsClient, permitNumbers);

  /* --- write -------------------------------------------------------------- */

  await mkdir(flags.outDir, { recursive: true });
  await writeFile(path.join(flags.outDir, 'permits.json'), JSON.stringify(permits.rows), 'utf8');
  await writeFile(path.join(flags.outDir, 'contacts.json'), JSON.stringify(contacts.rows), 'utf8');
  await writeFile(
    path.join(flags.outDir, 'manifest.json'),
    `${JSON.stringify(
      buildManifest({
        retrievedAt,
        windowStart: start,
        permitRows: permits.rows.length,
        contactRows: contacts.rows.length,
      }),
      null,
      2,
    )}\n`,
    'utf8',
  );

  /* --- report ------------------------------------------------------------- */

  const covered = new Set(
    contacts.rows
      .map((row) => (typeof row.permit_number === 'string' ? row.permit_number : ''))
      .filter((permitNumber) => permitNumber.length > 0),
  );

  log(`permits:  ${permits.rows.length} (${permits.pages} page(s))`);
  log(`contacts: ${contacts.rows.length} (${contacts.pages} request(s))`);
  log(
    `permits with at least one contact: ${covered.size} of ${permitNumbers.length} ` +
      `(${((covered.size / permitNumbers.length) * 100).toFixed(1)}%)`,
  );
  if (permits.skippedKeyless > 0) {
    log(`${permits.skippedKeyless} permit row(s) had no permit_number and were not written.`);
  }
  if (contacts.skippedKeyless > 0) {
    log(`${contacts.skippedKeyless} contact row(s) had no id and were not written.`);
  }
  log('Wrote permits.json, contacts.json and manifest.json.');

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error('[extract] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
