/**
 * `npm run replay` - the replay harness.
 *
 * The demo has to show real records arriving, but San Francisco does not issue a
 * permit on cue for a five minute pitch. So the harness takes the committed real
 * extract (10,880 rows retrieved from DataSF on 2026-08-15, `data/permits.json`),
 * holds every record at the timestamp it actually carried, and releases them into
 * `permit_records` on a clock that runs faster than wall time.
 *
 * Nothing about the records is invented. This is CLAUDE.md hard rule #5 in full:
 * real records only, live or replayed, and replay is labelled. Two mechanisms
 * carry the label so the UI cannot accidentally overstate what it is showing:
 *
 *   - every released record's `provenance.replayed` is `true`, and its
 *     `retrievedAt` is the moment the extract was actually pulled, taken from
 *     `data/manifest.json` rather than from this process's clock. The provenance
 *     says "retrieved on 15 August, released later", which is the truth.
 *   - `settings.replay_active` is set while the harness is feeding the pipeline,
 *     so the header badge can honestly read "real SF records, replayed".
 *
 * Two phases, either of which can be run on its own:
 *
 *   LOAD     read the extract, collapse the duplicate address rows, and stage
 *            every permit in `replay_staging` at its original `filed_date`.
 *            Idempotent: staging is ON CONFLICT DO NOTHING, so re-running adds
 *            what is new and never un-releases what already fired.
 *   RELEASE  claim staged records whose original timestamp the accelerated clock
 *            has reached, normalize them, and upsert them into `permit_records`
 *            in original chronological order. Claiming is a compare-and-swap in
 *            the store, so a record cannot be released twice even if two
 *            harnesses race.
 *
 * Flags:
 *   --load-only    stage the extract and stop. Does not touch settings.
 *   --speed=N      wall-clock acceleration. Defaults to REPLAY_SPEED_MULTIPLIER.
 *   --until-hero   ignore the clock and release, in order, everything up to and
 *                  including permit 202603238106 (555 California St), then stop.
 *                  This is the rehearsal path: it puts the hero record in front
 *                  of the pipeline in seconds instead of waiting out the span.
 *
 * A note on --speed, because the arithmetic surprises people. The extract spans
 * roughly 180 days. At the default 60x that is about three days of wall clock,
 * which is correct behaviour and useless for a demo. The harness prints the
 * projected duration at whatever speed it is given so the number is never a
 * surprise, and --until-hero exists precisely so the demo does not depend on it.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { getSource } from '@/lib/adapters/sources/registry';
import { buildProvenance } from '@/lib/adapters/sources/source-record';
import { hasCapability, missingKeys, replaySpeedMultiplier } from '@/lib/config/deployment-env';
import {
  contentHash,
  normalizeAgencyTimestamp,
  safeNormalizePermit,
} from '@/lib/domain/permit-normalizer';
import { jsonObjectSchema, type JsonObject } from '@/lib/store/client';
import { logEvent } from '@/lib/store/events';
import {
  claimDueReplayRecords,
  getPermit,
  getPermitHashes,
  replayProgress,
  stageReplayRecords,
  upsertPermitRecords,
  type PermitRecordInput,
  type ReplayRecord,
  type ReplayRecordInput,
} from '@/lib/store/permits';
import { isKillSwitchOn, setReplayState } from '@/lib/store/settings';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Constants                                                                  */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const PERMITS_PATH = path.join(REPO_ROOT, 'data', 'permits.json');
const MANIFEST_PATH = path.join(REPO_ROOT, 'data', 'manifest.json');

const SOURCE_ID = 'datasf.building_permits';

/**
 * 555 California St, 31st floor office remodel, $8.29M, lighting and power in the
 * scope, and no electrical contractor on the permit. The record the demo turns
 * on. `--until-hero` releases up to and including this permit's filed date.
 */
const HERO_PERMIT_NUMBER = '202603238106';

/** Records claimed per release round. Matches the store's write chunk size. */
const RELEASE_BATCH = 250;

/** Wall-clock gap between ticks when nothing is due yet. */
const TICK_MS = 1_000;

/** Progress is reprinted at least this often, even when nothing is released. */
const PROGRESS_INTERVAL_MS = 15_000;

/** A timestamp no record can be later than, used to drain without a clock. */
const END_OF_TIME = '9999-12-31T00:00:00.000Z';

const USAGE = `
Usage: npm run replay [-- --load-only] [--speed=N] [--until-hero]

Stages data/permits.json into replay_staging at each record's original filed_date,
then releases records into permit_records on an accelerated clock.

  --load-only    stage only, do not release
  --skip-stage   skip the staging pass, release what is already staged
  --speed=N      wall-clock acceleration (default: REPLAY_SPEED_MULTIPLIER)
  --until-hero   release in order up to and including permit ${HERO_PERMIT_NUMBER}, then stop

Safe to run repeatedly. Staged records are never re-staged and released records
are never re-released.
`;

/* -------------------------------------------------------------------------- */
/* Local environment                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Load `.env.local` when it exists.
 *
 * `tsx` does not read dotenv files and this project has no dotenv dependency.
 * Node's own loader does NOT overwrite variables that are already set, so a real
 * deployment environment always wins over a local file.
 */
function loadLocalEnv(): void {
  if (typeof process.loadEnvFile !== 'function') return;
  const envFile = path.join(REPO_ROOT, '.env.local');
  if (!existsSync(envFile)) return;
  try {
    process.loadEnvFile(envFile);
  } catch (cause) {
    console.warn(
      `[replay] Ignoring unreadable .env.local: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Flags                                                                      */
/* -------------------------------------------------------------------------- */

interface Flags {
  readonly loadOnly: boolean;
  readonly skipStage: boolean;
  readonly untilHero: boolean;
  readonly speed: number | null;
  readonly help: boolean;
}

class UsageError extends Error {}

function parseFlags(argv: readonly string[]): Flags {
  let loadOnly = false;
  let skipStage = false;
  let untilHero = false;
  let speed: number | null = null;
  let help = false;

  for (const argument of argv) {
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    if (argument === '--load-only') {
      loadOnly = true;
      continue;
    }
    if (argument === '--skip-stage') {
      skipStage = true;
      continue;
    }
    if (argument === '--until-hero') {
      untilHero = true;
      continue;
    }

    const match = /^--speed=(.*)$/.exec(argument);
    if (match === null) throw new UsageError(`Unrecognized argument "${argument}".`);

    const parsed = Number.parseInt((match[1] ?? '').trim(), 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw new UsageError(`--speed must be an integer >= 1, received "${match[1] ?? ''}".`);
    }
    speed = parsed;
  }

  if (loadOnly && untilHero) {
    throw new UsageError('--load-only and --until-hero contradict each other.');
  }
  if (loadOnly && skipStage) {
    throw new UsageError('--load-only and --skip-stage contradict each other.');
  }

  return { loadOnly, skipStage, untilHero, speed, help };
}

/* -------------------------------------------------------------------------- */
/* Extract                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Only `retrieved_at` is read, but it matters: it becomes the `retrievedAt` on
 * every replayed record's provenance. Stamping `now()` there instead would claim
 * this process fetched the row from DataSF, which it did not.
 */
const manifestSchema = z
  .object({ retrieved_at: z.string().datetime({ offset: true }) })
  .passthrough();

const extractSchema = z.array(z.record(z.string(), z.unknown())).min(1);

interface Extract {
  readonly rows: Record<string, unknown>[];
  readonly retrievedAt: string;
}

async function loadExtract(): Promise<Extract> {
  let manifestText: string;
  let permitsText: string;
  try {
    [manifestText, permitsText] = await Promise.all([
      readFile(MANIFEST_PATH, 'utf8'),
      readFile(PERMITS_PATH, 'utf8'),
    ]);
  } catch (cause) {
    throw new Error(
      `Could not read the committed extract at ${PERMITS_PATH}. Run "npm run extract" to re-pull it. ` +
        `(${cause instanceof Error ? cause.message : String(cause)})`,
    );
  }

  const manifest = manifestSchema.parse(JSON.parse(manifestText) as unknown);
  const rows = extractSchema.parse(JSON.parse(permitsText) as unknown);
  return { rows, retrievedAt: manifest.retrieved_at };
}

/* -------------------------------------------------------------------------- */
/* Duplicate collapse                                                         */
/* -------------------------------------------------------------------------- */

/**
 * One row per permit number, chosen the same way `scripts/ingest.ts` chooses it.
 *
 * DBI publishes a row per street address when a permit covers an address range
 * (726 permit numbers in the extract are affected), and `replay_staging` is keyed
 * on the permit number. The rule is duplicated rather than shared on purpose:
 * these scripts are leaf executables and must never import one another, because
 * importing one would run it. If the rule changes, change it in both places.
 *
 * Preference: `primary_address_flag = 'Y'`, then later `data_as_of`, then greater
 * `record_id`, then greater `street_number`. Total, reproducible, no judgement.
 */
function readField(raw: Record<string, unknown>, column: string): string {
  const value = raw[column];
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function isMoreCanonical(
  candidate: Record<string, unknown>,
  incumbent: Record<string, unknown>,
): boolean {
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

/* -------------------------------------------------------------------------- */
/* Staging                                                                    */
/* -------------------------------------------------------------------------- */

interface StagingPlan {
  readonly inputs: ReplayRecordInput[];
  readonly collapsed: number;
  /** Rows dropped because they carry no `filed_date` to be released against. */
  readonly undatable: number;
  /** The hero's original timestamp, or `null` if it is not in the extract. */
  readonly heroTs: string | null;
  readonly earliestTs: string | null;
  readonly latestTs: string | null;
}

/**
 * Turn the extract into staging rows.
 *
 * `filed_date` is the original timestamp: it is the moment the project entered
 * the public record, which is exactly the moment a lead company would first have
 * been able to see it. It is populated on 100% of the extract. A row without one
 * is dropped and counted rather than given a substitute date, because a made-up
 * arrival time would make the whole replay a fiction.
 */
function planStaging(rows: readonly Record<string, unknown>[]): StagingPlan {
  const chosen = new Map<string, Record<string, unknown>>();
  let collapsed = 0;
  let undatable = 0;

  for (const row of rows) {
    const key = readField(row, 'permit_number');
    if (key.length === 0) {
      undatable += 1;
      continue;
    }
    const incumbent = chosen.get(key);
    if (incumbent === undefined) {
      chosen.set(key, row);
      continue;
    }
    collapsed += 1;
    if (isMoreCanonical(row, incumbent)) chosen.set(key, row);
  }

  const inputs: ReplayRecordInput[] = [];
  let heroTs: string | null = null;

  for (const [permitNumber, row] of chosen) {
    const originalTs = normalizeAgencyTimestamp(row.filed_date);
    if (originalTs === null) {
      undatable += 1;
      continue;
    }
    inputs.push({
      permitNumber,
      raw: jsonObjectSchema.parse(row),
      originalTs,
    });
    if (permitNumber === HERO_PERMIT_NUMBER) heroTs = originalTs;
  }

  inputs.sort((left, right) => left.originalTs.localeCompare(right.originalTs));
  const first = inputs[0];
  const last = inputs[inputs.length - 1];

  return {
    inputs,
    collapsed,
    undatable,
    heroTs,
    earliestTs: first === undefined ? null : first.originalTs,
    latestTs: last === undefined ? null : last.originalTs,
  };
}

/* -------------------------------------------------------------------------- */
/* Release                                                                    */
/* -------------------------------------------------------------------------- */

interface ReleaseOutcome {
  readonly released: number;
  readonly added: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly unnormalizable: number;
  readonly heroReleased: boolean;
}

const EMPTY_OUTCOME: ReleaseOutcome = {
  released: 0,
  added: 0,
  changed: 0,
  unchanged: 0,
  unnormalizable: 0,
  heroReleased: false,
};

function toJsonObject(value: unknown, context: string): JsonObject {
  const parsed = jsonObjectSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${context}: not storable as jsonb (${parsed.error.message})`);
  }
  return parsed.data;
}

/**
 * Normalize a claimed batch and write it into `permit_records`.
 *
 * `hashes` is the live view of what is already stored, carried across rounds so
 * the pass does not re-read the whole hash index every 250 records. A record
 * whose hash already matches is left alone: it was already ingested live, and
 * rewriting it would only move its `last_seen_at`.
 */
async function releaseBatch(
  claimed: readonly ReplayRecord[],
  hashes: Map<string, string>,
  retrievedAt: string,
): Promise<ReleaseOutcome> {
  if (claimed.length === 0) return EMPTY_OUTCOME;

  const descriptor = getSource(SOURCE_ID);
  const inputs: PermitRecordInput[] = [];
  let added = 0;
  let changed = 0;
  let unchanged = 0;
  let unnormalizable = 0;
  let heroReleased = false;

  for (const record of claimed) {
    if (record.permitNumber === HERO_PERMIT_NUMBER) heroReleased = true;

    const result = safeNormalizePermit(record.raw);
    if (!result.ok) {
      unnormalizable += 1;
      console.warn(`[replay] skipped ${record.permitNumber}: ${result.reason}`);
      continue;
    }

    const normalized = result.permit;
    const hash = contentHash(normalized);
    const stored = hashes.get(record.permitNumber);
    if (stored === hash) {
      unchanged += 1;
      continue;
    }

    const snapshotStatus = stored === undefined ? 'added' : 'changed';
    if (stored === undefined) added += 1;
    else changed += 1;

    inputs.push({
      permitNumber: normalized.permitNumber,
      recordId: normalized.recordId,
      raw: record.raw,
      normalized: toJsonObject(normalized, `permit ${record.permitNumber} normalized`),
      contentHash: hash,
      provenance: buildProvenance({
        descriptor,
        // When the extract was actually pulled, not when it was replayed.
        retrievedAt,
        dataAsOf: normalized.dataAsOf,
        dataLoadedAt: normalized.dataLoadedAt,
        replayed: true,
      }),
      snapshotStatus,
      dataAsOf: normalized.dataAsOf,
      dataLoadedAt: normalized.dataLoadedAt,
    });
    hashes.set(record.permitNumber, hash);
  }

  await upsertPermitRecords(inputs);

  return { released: claimed.length, added, changed, unchanged, unnormalizable, heroReleased };
}

/* -------------------------------------------------------------------------- */
/* Small utilities                                                            */
/* -------------------------------------------------------------------------- */

function log(message: string): void {
  console.log(`[replay] ${message}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Human-scale duration. Used for the projected-runtime line, never for storage. */
function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return 'an unknown time';
  const seconds = ms / 1_000;
  if (seconds < 90) return `${seconds.toFixed(0)} seconds`;
  const minutes = seconds / 60;
  if (minutes < 90) return `${minutes.toFixed(1)} minutes`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)} hours`;
  return `${(hours / 24).toFixed(1)} days`;
}

function accumulate(total: ReleaseOutcome, next: ReleaseOutcome): ReleaseOutcome {
  return {
    released: total.released + next.released,
    added: total.added + next.added,
    changed: total.changed + next.changed,
    unchanged: total.unchanged + next.unchanged,
    unnormalizable: total.unnormalizable + next.unnormalizable,
    heroReleased: total.heroReleased || next.heroReleased,
  };
}

/* -------------------------------------------------------------------------- */
/* Release drivers                                                            */
/* -------------------------------------------------------------------------- */

/** Set by SIGINT so a run can be stopped between rounds without losing state. */
let stopRequested = false;

/**
 * Rehearsal mode: release everything up to and including the hero's own filed
 * date, as fast as the database allows, in chronological order.
 *
 * Bounding by the hero's timestamp rather than by "stop when we see it in a
 * batch" is what makes it exact. Claiming is ordered by `original_ts`, so
 * nothing later than the hero is ever claimed, and nothing that would have
 * arrived before it is skipped.
 */
async function releaseUntilHero(
  heroTs: string,
  hashes: Map<string, string>,
  retrievedAt: string,
): Promise<ReleaseOutcome> {
  let total = EMPTY_OUTCOME;

  for (;;) {
    if (stopRequested) break;
    if (await isKillSwitchOn()) {
      log('Kill switch is ON. Stopping.');
      break;
    }

    const claimed = await claimDueReplayRecords(heroTs, RELEASE_BATCH);
    if (claimed.length === 0) break;

    total = accumulate(total, await releaseBatch(claimed, hashes, retrievedAt));
    log(`Released ${total.released} record(s) up to ${heroTs}.`);
  }

  return total;
}

/**
 * Timed mode: release on the accelerated clock.
 *
 * The virtual clock is anchored to the earliest record still waiting, not to the
 * start of the extract, so a second run resumes where the first one stopped
 * instead of sitting idle re-living time that has already been replayed.
 */
async function releaseOnClock(
  speed: number,
  epoch: string,
  hashes: Map<string, string>,
  retrievedAt: string,
  pendingAtStart: number,
): Promise<ReleaseOutcome> {
  const epochMs = Date.parse(epoch);
  if (!Number.isFinite(epochMs)) {
    throw new Error(`Replay epoch "${epoch}" is not a parseable timestamp.`);
  }

  const startedWallMs = Date.now();
  let pending = pendingAtStart;
  let total = EMPTY_OUTCOME;
  let lastPrintedAt = 0;

  while (pending > 0) {
    if (stopRequested) break;
    if (await isKillSwitchOn()) {
      log('Kill switch is ON. Stopping.');
      break;
    }

    const virtualNow = new Date(epochMs + (Date.now() - startedWallMs) * speed).toISOString();
    const claimed = await claimDueReplayRecords(virtualNow, RELEASE_BATCH);

    if (claimed.length > 0) {
      total = accumulate(total, await releaseBatch(claimed, hashes, retrievedAt));
      pending -= claimed.length;
      const latest = claimed[claimed.length - 1];
      log(
        `Released ${claimed.length} (total ${total.released}), ${pending} pending, ` +
          `clock at ${latest === undefined ? virtualNow : latest.originalTs}.`,
      );
      lastPrintedAt = Date.now();
      // More may already be due at this virtual instant; do not sleep on it.
      continue;
    }

    if (Date.now() - lastPrintedAt >= PROGRESS_INTERVAL_MS) {
      log(`Waiting. ${pending} pending, virtual clock at ${virtualNow}.`);
      lastPrintedAt = Date.now();
    }
    await sleep(TICK_MS);
  }

  return total;
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
    console.error(`[replay] ${error.message}`);
    console.error(USAGE.trim());
    return 1;
  }

  if (flags.help) {
    console.log(USAGE.trim());
    return 0;
  }

  loadLocalEnv();

  if (!hasCapability('supabase')) {
    console.error('[replay] Supabase is not configured, so there is nowhere to replay into.');
    console.error(`[replay] Missing: ${missingKeys('supabase').join(', ')}`);
    console.error('[replay] See docs/BLOCKERS.md section 1.');
    return 1;
  }

  // Hard rule #7: the harness feeds the pipeline, so a halted company must not
  // be able to start it.
  if (await isKillSwitchOn()) {
    log('Kill switch is ON. Nothing staged, nothing released.');
    return 0;
  }

  const speed = flags.speed ?? replaySpeedMultiplier();

  /* --- load --------------------------------------------------------------- */

  const extract = await loadExtract();
  log(`Extract: ${extract.rows.length} real DataSF rows, retrieved ${extract.retrievedAt}.`);

  const plan = planStaging(extract.rows);
  log(
    `Staging plan: ${plan.inputs.length} distinct permits ` +
      `(${plan.collapsed} duplicate address row(s) collapsed` +
      `${plan.undatable > 0 ? `, ${plan.undatable} undatable row(s) dropped` : ''}).`,
  );

  /*
   * Re-staging is a no-op once the extract is in, but it still pushes 10,049
   * rows through PostgREST and is the slowest and most failure-prone step in
   * the run. `--skip-stage` goes straight to releasing what is already staged.
   */
  if (flags.skipStage) {
    log('Skipping the staging pass; releasing what is already staged.');
  }
  const staged = flags.skipStage ? 0 : await stageReplayRecords(plan.inputs);
  if (!flags.skipStage) log(`Staged ${staged} new record(s); the rest were already staged.`);

  if (staged > 0) {
    await logEvent({
      agent: 'lead',
      decision: 'replay.staged',
      summary:
        `Staged ${staged} real San Francisco permit records at their original filing timestamps ` +
        `for release on the demo clock.`,
      refs: {
        source: SOURCE_ID,
        extract_retrieved_at: extract.retrievedAt,
        staged: String(staged),
      },
    });
  }

  let progress = await replayProgress();
  log(`Staging: ${progress.released} released, ${progress.pending} pending, ${progress.total} total.`);

  if (flags.loadOnly) {
    log('Load only. Nothing released.');
    return 0;
  }

  if (progress.pending === 0) {
    log('Nothing pending. The staged extract has already been released in full.');
    return 0;
  }

  /* --- release ------------------------------------------------------------ */

  // The badge is only honest while the harness is actually the feed. It is left
  // ON when the run ends: the records in the database are still replayed ones,
  // and silently dropping the label would overstate what the UI is showing.
  await setReplayState(true, speed);

  const hashes = await getPermitHashes();
  process.on('SIGINT', () => {
    stopRequested = true;
    console.log('\n[replay] Stop requested. Finishing the current round.');
  });

  let outcome: ReleaseOutcome;

  if (flags.untilHero) {
    if (plan.heroTs === null) {
      console.error(
        `[replay] Permit ${HERO_PERMIT_NUMBER} is not in ${PERMITS_PATH}. ` +
          'Re-pull the extract with "npm run extract" before rehearsing.',
      );
      return 1;
    }

    const alreadyStored = await getPermit(HERO_PERMIT_NUMBER);
    log(
      alreadyStored === null
        ? `Releasing in order up to the hero permit at ${plan.heroTs}.`
        : `Hero permit ${HERO_PERMIT_NUMBER} is already in permit_records. Draining anything still due before it.`,
    );

    outcome = await releaseUntilHero(plan.heroTs, hashes, extract.retrievedAt);

    const hero = await getPermit(HERO_PERMIT_NUMBER);
    if (hero === null) {
      console.error(
        `[replay] Released ${outcome.released} record(s) but ${HERO_PERMIT_NUMBER} did not land in permit_records.`,
      );
      return 1;
    }

    log(
      `Hero permit ${HERO_PERMIT_NUMBER} is in the pipeline ` +
        `(replayed: ${hero.provenance.replayed}, snapshot: ${hero.snapshotStatus}).`,
    );
    if (outcome.heroReleased) {
      await logEvent({
        agent: 'lead',
        decision: 'replay.hero_released',
        summary:
          'Released the 555 California St permit into the pipeline from the committed San Francisco extract.',
        refs: {
          permit: HERO_PERMIT_NUMBER,
          source: SOURCE_ID,
          original_ts: plan.heroTs,
        },
      });
    }
  } else {
    const epoch = progress.nextDueAt;
    if (epoch === null) {
      log('Nothing pending. Done.');
      return 0;
    }

    if (plan.latestTs !== null) {
      const spanMs = Date.parse(plan.latestTs) - Date.parse(epoch);
      log(
        `Speed ${speed}x. The remaining ${formatDuration(spanMs)} of record history ` +
          `takes about ${formatDuration(spanMs / speed)} of wall clock. ` +
          'Raise --speed, or use --until-hero, to compress that.',
      );
    }

    outcome = await releaseOnClock(speed, epoch, hashes, extract.retrievedAt, progress.pending);
  }

  /* --- report ------------------------------------------------------------- */

  progress = await replayProgress();
  log(
    `Released ${outcome.released} record(s): ${outcome.added} new, ${outcome.changed} changed, ` +
      `${outcome.unchanged} already current.`,
  );
  if (outcome.unnormalizable > 0) {
    log(`${outcome.unnormalizable} record(s) could not be normalized and were not stored.`);
  }
  log(`Staging now: ${progress.released} released, ${progress.pending} pending.`);

  await logEvent({
    agent: 'lead',
    decision: stopRequested ? 'replay.stopped' : 'replay.completed',
    summary:
      `Replay round released ${outcome.released} real San Francisco permit records ` +
      `(${outcome.added} new, ${outcome.changed} changed) with ${progress.pending} still staged.`,
    refs: {
      source: SOURCE_ID,
      released: String(outcome.released),
      pending: String(progress.pending),
      speed: String(speed),
      mode: flags.untilHero ? 'until-hero' : 'clock',
    },
  });

  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error('[replay] Failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
