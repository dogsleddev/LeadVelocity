/**
 * `npm run ingest` - one live ingestion pass over the DataSF building permits.
 *
 * This is the trigger layer doing its job (CLAUDE.md hard rule #1): a permit
 * record is what starts every fulfilment workflow, and this script is how real
 * permit records get into `permit_records`. It runs once and exits, which is why
 * it is a Render cron rather than a loop; `npm run workers` owns the tick loops.
 *
 * One pass is:
 *
 *   fetch -> collapse duplicates -> normalize -> diff against stored hashes ->
 *   upsert what moved -> write one decision to the log
 *
 * Five things in here are load-bearing and are not obvious from that summary.
 *
 * 1. **The pull is incremental on the agency's own currency columns.** DataSF
 *    exposes `data_as_of` and `data_loaded_at`, and the source registry declares
 *    `data_as_of` as the cursor. `--since` narrows the pull to rows the agency
 *    republished after that point. Without it the pass re-reads the whole filed
 *    window, which is slower but never misses a row, and is therefore the safe
 *    default for an unattended cron.
 *
 * 2. **Change detection is by content hash, not by trusting the cursor.** The
 *    cursor decides what we look at; `contentHash(normalized)` decides what
 *    actually moved. Both currency columns are part of the normalized projection
 *    and therefore part of the hash, so a republished-but-unchanged row and a
 *    genuinely edited row are distinguishable. This is what makes the second run
 *    of the same pass report 0 added / 0 changed.
 *
 * 3. **`permit_number` is not unique in this dataset.** Measured on the real
 *    extract: 10,880 rows carry 10,049 distinct permit numbers, because DBI
 *    publishes one row per address when a permit covers an address range.
 *    `permit_records.permit_number` is a primary key, so the pass collapses each
 *    group to one row deterministically before it writes anything. Upserting
 *    blindly would fail outright ("ON CONFLICT DO UPDATE cannot affect row a
 *    second time").
 *
 * 4. **Absence is not reported as absence here.** The pull is a filtered window,
 *    so a stored permit that is not in the response might simply be outside the
 *    window or older than the cursor. Marking it `not_observed` would put a fact
 *    in the system that nobody observed, so `reportNotObserved` is off and
 *    `markNotObserved` is deliberately not called. Only a full-corpus pass could
 *    honestly claim absence.
 *
 * 5. **Only records that moved are written.** Unchanged permits keep their old
 *    `last_seen_at`, which keeps the ingestion feed in the UI a list of things
 *    that actually happened rather than a wall of re-timestamped noise.
 *
 * Flags:
 *   --since=ISO   resume point for the cursor column. Accepts an absolute
 *                 timestamp or the dataset's floating form. Omit for a full pass
 *                 over the filed window.
 *   --limit=N     stop after N rows. For smoke tests; a limited pass is a
 *                 partial pass and is reported as such.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createSocrataClientFor, soqlLiteral } from '@/lib/adapters/sources/socrata';
import type { RawPayload, RawSourceRecord } from '@/lib/adapters/sources/source-record';
import { hasCapability, missingKeys } from '@/lib/config/deployment-env';
import {
  contentHash,
  instantToIsoInZone,
  safeNormalizePermit,
  toFloatingTimestamp,
  type NormalizedPermit,
} from '@/lib/domain/permit-normalizer';
import { diffSnapshots, observed, summarizeDeltas } from '@/lib/research/snapshot-diff';
import type { ObservedRecord, PreviousSnapshot } from '@/lib/research/snapshot-diff';
import { jsonObjectSchema, nowIso, type JsonObject } from '@/lib/store/client';
import { logEvent } from '@/lib/store/events';
import { getPermitHashes, upsertPermitRecords, type PermitRecordInput } from '@/lib/store/permits';
import { isKillSwitchOn } from '@/lib/store/settings';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));

const SOURCE_ID = 'datasf.building_permits';

/**
 * How far back the pass looks by `filed_date`.
 *
 * 180 days is the same window the committed extract was pulled over, so the live
 * corpus and the replay corpus describe the same universe of projects. A permit
 * filed before that window is not a lead for anybody.
 */
const FILED_WINDOW_DAYS = 180;

/** Rows per SODA request. The dataset's practical page size. */
const PAGE_SIZE = 1_000;

/** Attempts per request, over the adapter's exponential backoff. */
const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 30_000;

const USAGE = `
Usage: npm run ingest [-- --since=ISO] [--limit=N]

One live pass over DataSF building permits (Socrata i98e-djp9).

  --since=ISO   only rows whose data_as_of moved past this point. Accepts
                2026-08-01T00:00:00Z or the dataset's floating 2026-08-01T00:00:00.
  --limit=N     stop after N rows (smoke test; the pass is reported as partial).

Running twice in a row reports 0 added / 0 changed the second time.
`;

/* -------------------------------------------------------------------------- */
/* Local environment                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Load `.env.local` when it exists.
 *
 * `tsx` does not read dotenv files and this project has no dotenv dependency.
 * Node's own loader does NOT overwrite variables that are already set, so the
 * Render environment always wins over a local file that happens to be lying
 * around next to it.
 */
function loadLocalEnv(): void {
  if (typeof process.loadEnvFile !== 'function') return;
  const envFile = path.join(REPO_ROOT, '.env.local');
  if (!existsSync(envFile)) return;
  try {
    process.loadEnvFile(envFile);
  } catch (cause) {
    console.warn(
      `[ingest] Ignoring unreadable .env.local: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Flags                                                                      */
/* -------------------------------------------------------------------------- */

interface Flags {
  readonly since: string | null;
  readonly limit: number | null;
  readonly help: boolean;
}

class UsageError extends Error {}

function parseFlags(argv: readonly string[]): Flags {
  let since: string | null = null;
  let limit: number | null = null;
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

    if (name === 'since') {
      // Validated with the same converter the adapter uses, so a bad value fails
      // here with a usable message instead of inside an HTTP call.
      if (toFloatingTimestamp(value) === null) {
        throw new UsageError(`--since="${value}" is not a timestamp this dataset can compare.`);
      }
      since = value;
      continue;
    }

    if (name === 'limit') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new UsageError(`--limit must be a positive integer, received "${value}".`);
      }
      limit = parsed;
      continue;
    }

    throw new UsageError(`Unrecognized flag "--${name ?? ''}".`);
  }

  return { since, limit, help };
}

/* -------------------------------------------------------------------------- */
/* Duplicate collapse                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Pick the one row that represents a permit number.
 *
 * DBI publishes a row per street address when a permit spans an address range,
 * and flags the canonical one with `primary_address_flag = 'Y'`. On the real
 * extract that flag resolves 725 of the 726 duplicated permit numbers on its
 * own; the remaining tie-breaks exist so the choice is total and reproducible,
 * never dependent on the order SODA happened to page rows in.
 *
 * Order of preference:
 *   1. `primary_address_flag = 'Y'`  the city's own designation
 *   2. later `data_as_of`            the fresher publication of the same permit
 *   3. greater `record_id`           the later DBI record
 *   4. greater `street_number`       final, arbitrary, but deterministic
 *
 * Deterministic dedupe is CLAUDE.md hard rule #2. An LLM is not involved and
 * must not be: which address is canonical is the agency's fact, not a judgement.
 */
function readField(raw: RawPayload, column: string): string {
  const value = raw[column];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function isMoreCanonical(candidate: RawPayload, incumbent: RawPayload): boolean {
  const candidatePrimary = readField(candidate, 'primary_address_flag').toUpperCase() === 'Y';
  const incumbentPrimary = readField(incumbent, 'primary_address_flag').toUpperCase() === 'Y';
  if (candidatePrimary !== incumbentPrimary) return candidatePrimary;

  for (const column of ['data_as_of', 'record_id', 'street_number']) {
    const left = readField(candidate, column);
    const right = readField(incumbent, column);
    if (left !== right) return left > right;
  }
  return false;
}

interface CollapseResult {
  readonly rows: RawSourceRecord[];
  /** Rows discarded because a sibling row represented the same permit number. */
  readonly collapsed: number;
}

/** Collapse a fetched page set to one record per permit number. */
function collapseDuplicates(records: readonly RawSourceRecord[]): CollapseResult {
  const chosen = new Map<string, RawSourceRecord>();
  let collapsed = 0;

  for (const record of records) {
    const incumbent = chosen.get(record.key);
    if (incumbent === undefined) {
      chosen.set(record.key, record);
      continue;
    }
    collapsed += 1;
    if (isMoreCanonical(record.raw, incumbent.raw)) chosen.set(record.key, record);
  }

  return { rows: [...chosen.values()], collapsed };
}

/* -------------------------------------------------------------------------- */
/* Window                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `filed_date > <floating timestamp>` for the lookback window.
 *
 * SoQL floating timestamps carry no offset and are compared as San Francisco
 * wall time, so the instant is converted into that zone before the literal is
 * built. Reading the clock is fine here: this is a script, not a pure module.
 */
function filedWindowPredicate(now: Date, days: number): string {
  const cutoffMs = now.getTime() - days * 24 * 60 * 60 * 1_000;
  const isoInZone = instantToIsoInZone(cutoffMs);
  const floating = isoInZone === null ? null : toFloatingTimestamp(isoInZone);
  if (floating === null) {
    throw new Error(`Could not build a filed_date window from ${now.toISOString()}.`);
  }
  return `filed_date > ${soqlLiteral(floating)}`;
}

/* -------------------------------------------------------------------------- */
/* Store payloads                                                             */
/* -------------------------------------------------------------------------- */

/** Validate a value on its way into a `jsonb` column. Zod at every boundary. */
function toJsonObject(value: unknown, context: string): JsonObject {
  const parsed = jsonObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${context}: not storable as jsonb (${parsed.error.message})`);
  }
  return parsed.data;
}

/* -------------------------------------------------------------------------- */
/* Pass                                                                       */
/* -------------------------------------------------------------------------- */

interface PassCounts {
  fetched: number;
  collapsed: number;
  unnormalizable: number;
  added: number;
  changed: number;
  unchanged: number;
  written: number;
  pages: number;
  skippedKeyless: number;
  truncated: boolean;
  cursor: string | null;
}

function log(message: string): void {
  console.log(`[ingest] ${message}`);
}

async function runPass(flags: Flags): Promise<PassCounts> {
  const pageSize = flags.limit === null ? PAGE_SIZE : Math.min(flags.limit, PAGE_SIZE);
  const maxPages = flags.limit === null ? undefined : Math.ceil(flags.limit / pageSize);

  const client = createSocrataClientFor(SOURCE_ID, {
    pageSize,
    maxAttempts: MAX_ATTEMPTS,
    timeoutMs: TIMEOUT_MS,
  });

  const where = filedWindowPredicate(new Date(), FILED_WINDOW_DAYS);
  log(`Source ${client.descriptor.id} (${client.descriptor.datasetId}) at ${client.descriptor.endpoint}`);
  log(`Window: ${where}${flags.since === null ? '' : ` AND ${client.cursorField} > '${flags.since}'`}`);
  log(`App token: ${client.hasAppToken ? 'present' : 'absent (anonymous rate limit)'}`);

  const fetched = await client.fetchIncremental({
    since: flags.since,
    where,
    pageSize,
    ...(maxPages === undefined ? {} : { maxPages }),
  });

  const capped =
    flags.limit === null ? fetched.records : fetched.records.slice(0, flags.limit);
  log(`Fetched ${capped.length} row(s) across ${fetched.pages} page(s).`);

  const { rows, collapsed } = collapseDuplicates(capped);
  if (collapsed > 0) {
    log(`Collapsed ${collapsed} duplicate address row(s) into their canonical permit.`);
  }

  /* --- normalize ---------------------------------------------------------- */

  interface Candidate {
    readonly record: RawSourceRecord;
    readonly normalized: NormalizedPermit;
    readonly hash: string;
  }

  const candidates = new Map<string, Candidate>();
  let unnormalizable = 0;

  for (const record of rows) {
    const result = safeNormalizePermit(record.raw);
    if (!result.ok) {
      // A row we cannot normalize is reported, never patched into shape.
      unnormalizable += 1;
      console.warn(`[ingest] skipped ${record.key}: ${result.reason}`);
      continue;
    }
    candidates.set(record.key, {
      record,
      normalized: result.permit,
      hash: contentHash(result.permit),
    });
  }

  /* --- diff --------------------------------------------------------------- */

  const storedHashes = await getPermitHashes();
  log(`Stored permits: ${storedHashes.size}.`);

  const previous: PreviousSnapshot<NormalizedPermit>[] = [...storedHashes].map(
    ([key, hash]) => ({ key, contentHash: hash }),
  );
  const current: ObservedRecord<NormalizedPermit>[] = [...candidates.values()].map((candidate) =>
    observed(candidate.normalized.permitNumber, candidate.hash, candidate.normalized),
  );

  const deltas = diffSnapshots({
    previous,
    current,
    observedAt: nowIso(),
    // See header note 4: a filtered window cannot speak to absence.
    reportNotObserved: false,
  });
  const counts = summarizeDeltas(deltas);

  /* --- write -------------------------------------------------------------- */

  const inputs: PermitRecordInput[] = [];
  for (const delta of deltas) {
    if (delta.status === 'not_observed') continue;
    const candidate = candidates.get(delta.key);
    if (candidate === undefined) continue;

    inputs.push({
      permitNumber: candidate.normalized.permitNumber,
      recordId: candidate.normalized.recordId,
      raw: toJsonObject(candidate.record.raw, `permit ${delta.key} raw`),
      normalized: toJsonObject(candidate.normalized, `permit ${delta.key} normalized`),
      contentHash: candidate.hash,
      provenance: candidate.record.provenance,
      snapshotStatus: delta.status,
      dataAsOf: candidate.normalized.dataAsOf,
      dataLoadedAt: candidate.normalized.dataLoadedAt,
      seenAt: delta.observedAt,
    });
  }

  const written = await upsertPermitRecords(inputs);

  return {
    fetched: capped.length,
    collapsed,
    unnormalizable,
    added: counts.added,
    changed: counts.changed,
    unchanged: candidates.size - counts.added - counts.changed,
    written,
    pages: fetched.pages,
    skippedKeyless: fetched.skippedKeyless,
    truncated: fetched.truncated,
    cursor: fetched.cursor,
  };
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  let flags: Flags;
  try {
    flags = parseFlags(process.argv.slice(2));
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    console.error(`[ingest] ${error.message}`);
    console.error(USAGE.trim());
    return 1;
  }

  if (flags.help) {
    console.log(USAGE.trim());
    return 0;
  }

  loadLocalEnv();

  if (!hasCapability('supabase')) {
    console.error('[ingest] Supabase is not configured, so there is nowhere to store permits.');
    console.error(`[ingest] Missing: ${missingKeys('supabase').join(', ')}`);
    console.error('[ingest] See docs/BLOCKERS.md section 1.');
    return 1;
  }

  // Hard rule #7. A halted company does not quietly keep ingesting, and it does
  // not narrate either: writing a decision on every cron tick while stopped would
  // bury the log that the kill switch demo is supposed to make legible.
  if (await isKillSwitchOn()) {
    log('Kill switch is ON. No pull, no writes.');
    return 0;
  }

  const startedAt = Date.now();
  let counts: PassCounts;
  try {
    counts = await runPass(flags);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[ingest] Pass failed: ${reason}`);
    await logEvent({
      agent: 'lead',
      decision: 'permits.ingest_failed',
      summary: `Live permit pull from DataSF did not complete: ${reason}`,
      refs: { source: SOURCE_ID },
    });
    return 1;
  }

  const elapsedMs = Date.now() - startedAt;
  const partial = flags.limit !== null || counts.truncated;

  log(
    `Result: ${counts.added} added, ${counts.changed} changed, ${counts.unchanged} unchanged ` +
      `(${counts.written} row(s) written) in ${elapsedMs} ms.`,
  );
  if (counts.unnormalizable > 0) log(`${counts.unnormalizable} row(s) could not be normalized.`);
  if (counts.skippedKeyless > 0) log(`${counts.skippedKeyless} row(s) had no permit number.`);
  if (counts.truncated) log('Page budget reached: this pass did not exhaust the window.');

  const refs: Record<string, string> = {
    source: SOURCE_ID,
    dataset: 'i98e-djp9',
    added: String(counts.added),
    changed: String(counts.changed),
    unchanged: String(counts.unchanged),
    fetched: String(counts.fetched),
    pages: String(counts.pages),
    partial: partial ? 'true' : 'false',
  };
  if (counts.cursor !== null) refs.cursor = counts.cursor;
  if (flags.since !== null) refs.since = flags.since;

  await logEvent({
    agent: 'lead',
    decision: 'permits.ingested',
    summary:
      `Read ${counts.fetched} published San Francisco permit records and found ` +
      `${counts.added} new and ${counts.changed} changed since the last pass, ` +
      `${counts.unchanged} unchanged.`,
    refs,
  });

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error('[ingest] Unexpected failure:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
