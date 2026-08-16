/**
 * Snapshot diffing: what moved since the last observation.
 *
 * Origin: snapshot semantics adapted from SiteVelocity
 * (https://github.com/samshanmukh/SiteVelocity).
 *
 * The ingestion loop re-reads a public dataset on a cadence. Almost everything it
 * reads is identical to last time. This module answers the only question worth
 * asking of a fresh pull: which records are new, which ones actually changed and
 * in what fields, and which ones did not come back.
 *
 * The load-bearing rule is the third status. `not_observed` does NOT mean
 * deleted. Public datasets drop and re-add rows for reasons that have nothing to
 * do with the physical world: a re-publish window, a filter boundary, an agency
 * backfill. Treating absence as deletion would let a permit disappear from the
 * pipeline because of a publishing hiccup, and would put a fact in the system
 * that nobody observed (CLAUDE.md hard rule #3). So absence is recorded as
 * absence and the caller decides what, if anything, it means.
 *
 * This module is PURE: no network, no clock, no fs, no randomness. The
 * observation time is an explicit parameter, because a diff computed twice from
 * the same inputs must produce the same output.
 */
import {
  snapshotDeltaSchema,
  type SnapshotDelta,
  type SnapshotStatus,
} from '@/lib/domain/schemas/core';
import { canonicalJson } from '@/lib/domain/permit-normalizer';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

/** Any normalized record: a flat bag of comparable field values. */
export type DiffableFields = Readonly<Record<string, unknown>>;

/**
 * What we stored last time.
 *
 * `fields` is optional because the previous normalized body is not always at
 * hand (a hash-only index is cheaper to read). Without it a change is still
 * detected from the hash, it just cannot be attributed to named fields, and
 * `changedFields` comes back empty rather than guessed.
 */
export interface PreviousSnapshot<T extends DiffableFields = DiffableFields> {
  readonly key: string;
  readonly contentHash: string;
  readonly fields?: T | null;
}

/** What we just observed. */
export interface ObservedRecord<T extends DiffableFields = DiffableFields> {
  readonly key: string;
  readonly contentHash: string;
  readonly fields: T;
}

/** Convenience constructor so call sites read as data, not as object literals. */
export function observed<T extends DiffableFields>(
  key: string,
  contentHash: string,
  fields: T,
): ObservedRecord<T> {
  return { key, contentHash, fields };
}

export interface DiffSnapshotsArgs<T extends DiffableFields = DiffableFields> {
  /** The stored snapshot set. Duplicate keys: first occurrence wins. */
  readonly previous: readonly PreviousSnapshot<T>[];
  /** The fresh pull. Duplicate keys: first occurrence wins. */
  readonly current: readonly ObservedRecord<T>[];
  /** Observation time, ISO-8601 with offset. Explicit because this module is pure. */
  readonly observedAt: string;
  /**
   * Emit `not_observed` for stored keys the pull did not contain. Default true.
   * Set false when the pull was deliberately partial (an incremental window, a
   * filtered query), where absence carries no information at all.
   */
  readonly reportNotObserved?: boolean;
}

/* -------------------------------------------------------------------------- */
/* Field comparison                                                           */
/* -------------------------------------------------------------------------- */

const observedAtSchema = z.string().datetime({ offset: true });

/**
 * Top-level field names whose values differ, sorted for stable output.
 *
 * Values are compared by canonical JSON, so nested objects and arrays compare
 * structurally and key order never registers as a change. A field present on one
 * side and absent on the other counts as changed, since going from a value to an
 * unknown is exactly the kind of movement the pipeline must see.
 */
export function diffFields(previous: DiffableFields, current: DiffableFields): string[] {
  const names = new Set<string>([...Object.keys(previous), ...Object.keys(current)]);
  const changed: string[] = [];
  for (const name of names) {
    const before = Object.prototype.hasOwnProperty.call(previous, name)
      ? canonicalJson(previous[name])
      : undefined;
    const after = Object.prototype.hasOwnProperty.call(current, name)
      ? canonicalJson(current[name])
      : undefined;
    if (before !== after) changed.push(name);
  }
  return changed.sort();
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                       */
/* -------------------------------------------------------------------------- */

function indexFirstWins<T extends { key: string }>(rows: readonly T[]): Map<string, T> {
  const index = new Map<string, T>();
  for (const row of rows) {
    if (row.key.length === 0) continue;
    if (!index.has(row.key)) index.set(row.key, row);
  }
  return index;
}

/**
 * Diff a fresh pull against the stored snapshot set.
 *
 * Output order is deterministic: `added` and `changed` in the order the records
 * appeared in `current`, then `not_observed` in the order they appeared in
 * `previous`. Unchanged records produce no delta at all, which is what keeps the
 * decision log readable when 10,000 rows come back and four of them moved.
 */
export function diffSnapshots<T extends DiffableFields>(
  args: DiffSnapshotsArgs<T>,
): SnapshotDelta[] {
  const observedAt = observedAtSchema.parse(args.observedAt);
  const reportNotObserved = args.reportNotObserved ?? true;

  const previousIndex = indexFirstWins(args.previous);
  const seen = new Set<string>();
  const deltas: SnapshotDelta[] = [];

  for (const record of args.current) {
    if (record.key.length === 0) continue;
    if (seen.has(record.key)) continue;
    seen.add(record.key);

    const before = previousIndex.get(record.key);

    if (before === undefined) {
      deltas.push(
        makeDelta({
          key: record.key,
          status: 'added',
          changedFields: [],
          contentHash: record.contentHash,
          observedAt,
        }),
      );
      continue;
    }

    if (before.contentHash === record.contentHash) continue;

    const previousFields = before.fields ?? null;
    deltas.push(
      makeDelta({
        key: record.key,
        status: 'changed',
        // Without the previous body we know THAT it changed, not WHAT changed.
        changedFields: previousFields === null ? [] : diffFields(previousFields, record.fields),
        contentHash: record.contentHash,
        observedAt,
      }),
    );
  }

  if (reportNotObserved) {
    for (const [key, before] of previousIndex) {
      if (seen.has(key)) continue;
      deltas.push(
        makeDelta({
          key,
          status: 'not_observed',
          changedFields: [],
          // The last hash we can stand behind. Absence produced no new content.
          contentHash: before.contentHash,
          observedAt,
        }),
      );
    }
  }

  return deltas;
}

function makeDelta(delta: {
  key: string;
  status: SnapshotStatus;
  changedFields: string[];
  contentHash: string;
  observedAt: string;
}): SnapshotDelta {
  return snapshotDeltaSchema.parse(delta);
}

/* -------------------------------------------------------------------------- */
/* Readers                                                                    */
/* -------------------------------------------------------------------------- */

/** Deltas of one status, preserving diff order. */
export function deltasWithStatus(
  deltas: readonly SnapshotDelta[],
  status: SnapshotStatus,
): SnapshotDelta[] {
  return deltas.filter((delta) => delta.status === status);
}

/** Count per status, including zeros, for the decision-log summary line. */
export function summarizeDeltas(
  deltas: readonly SnapshotDelta[],
): Readonly<Record<SnapshotStatus, number>> {
  const counts: Record<SnapshotStatus, number> = { added: 0, changed: 0, not_observed: 0 };
  for (const delta of deltas) counts[delta.status] += 1;
  return counts;
}

/**
 * Keys worth pushing through the pipeline again: new records and real changes.
 *
 * `not_observed` is excluded on purpose. There is nothing new to work with, and
 * re-processing a record because a publisher skipped it would manufacture
 * activity out of a publishing artifact.
 */
export function actionableKeys(deltas: readonly SnapshotDelta[]): string[] {
  return deltas
    .filter((delta) => delta.status === 'added' || delta.status === 'changed')
    .map((delta) => delta.key);
}
