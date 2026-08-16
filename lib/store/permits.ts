/**
 * The trigger layer (`permit_records`) and the replay staging table.
 *
 * Hard rule #1: a permit record starts every fulfilment workflow. This table is
 * where that record lands, and it keeps four things about every permit:
 *
 * - `raw`         the Socrata row exactly as the agency published it, untouched.
 * - `normalized`  the coerced, typed projection the pipeline actually reads.
 * - `content_hash` a hash of the normalized projection, for snapshot diffing.
 * - `provenance`  agency, dataset, endpoint, retrieval time, replay flag.
 *
 * Keeping `raw` alongside `normalized` is not redundancy. Every DataSF value
 * arrives as a string, including costs and dates, so the normalizer makes
 * decisions (`max(revised_cost, estimated_cost)`, absent `issued_date` becoming
 * `unknown`) that must remain auditable against what the agency actually said.
 *
 * Snapshot semantics follow `core.ts`: `added | changed | not_observed`. A
 * permit that stops appearing in a query is `not_observed`, never "deleted".
 * Public datasets drop and re-add rows for reasons that have nothing to do with
 * the physical world.
 *
 * Replay staging lives here too, because it holds the same records at their
 * original timestamps, released on the accelerated demo clock. Replayed rows are
 * real SF permits, and the UI labels them as replayed (hard rule #5).
 */
import { z } from 'zod';

import {
  type Provenance,
  type SnapshotStatus,
  provenanceSchema,
  snapshotStatusSchema,
} from '@/lib/domain/schemas/core';

import {
  chunk,
  dbTimestamp,
  dbTimestampNullable,
  fetchAllPaged,
  type JsonObject,
  jsonObjectSchema,
  nowIso,
  parseRow,
  parseRows,
  requireClient,
  unwrap,
  unwrapCount,
} from './client';

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

const permitRowSchema = z.object({
  permit_number: z.string().min(1),
  record_id: z.string().nullable(),
  raw: jsonObjectSchema,
  normalized: jsonObjectSchema,
  content_hash: z.string().min(1),
  provenance: provenanceSchema,
  snapshot_status: snapshotStatusSchema,
  data_as_of: dbTimestampNullable,
  data_loaded_at: dbTimestampNullable,
  first_seen_at: dbTimestamp,
  last_seen_at: dbTimestamp,
});

export interface PermitRecord {
  permitNumber: string;
  recordId: string | null;
  /** The agency row verbatim. Never edited, only stored. */
  raw: JsonObject;
  /** Typed projection produced by the pure normalizer. */
  normalized: JsonObject;
  contentHash: string;
  provenance: Provenance;
  snapshotStatus: SnapshotStatus;
  dataAsOf: string | null;
  dataLoadedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** What the ingestion pass hands the store for one permit. */
export interface PermitRecordInput {
  permitNumber: string;
  recordId?: string | null;
  raw: JsonObject;
  normalized: JsonObject;
  contentHash: string;
  provenance: Provenance;
  snapshotStatus: SnapshotStatus;
  dataAsOf?: string | null;
  dataLoadedAt?: string | null;
  /** Override the observation time; defaults to now. */
  seenAt?: string;
}

function toPermit(row: unknown, context: string): PermitRecord {
  const parsed = parseRow(permitRowSchema, row, context);
  return {
    permitNumber: parsed.permit_number,
    recordId: parsed.record_id,
    raw: parsed.raw,
    normalized: parsed.normalized,
    contentHash: parsed.content_hash,
    provenance: parsed.provenance,
    snapshotStatus: parsed.snapshot_status,
    dataAsOf: parsed.data_as_of,
    dataLoadedAt: parsed.data_loaded_at,
    firstSeenAt: parsed.first_seen_at,
    lastSeenAt: parsed.last_seen_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Insert or refresh one permit, keyed on `permit_number`.
 *
 * `first_seen_at` is deliberately absent from the payload. PostgREST builds the
 * `ON CONFLICT DO UPDATE SET` list from the keys present in the body, so an
 * omitted column keeps its original value: the permit remembers when this system
 * first laid eyes on it, however many times it is re-observed afterwards.
 * `last_seen_at` is written on every pass and is what "still in the feed" means.
 */
export async function upsertPermitRecord(input: PermitRecordInput): Promise<PermitRecord> {
  const client = requireClient('upsertPermitRecord');
  const provenance = provenanceSchema.parse(input.provenance);

  const row = unwrap(
    await client
      .from('permit_records')
      .upsert(
        {
          permit_number: input.permitNumber,
          record_id: input.recordId ?? null,
          raw: input.raw,
          normalized: input.normalized,
          content_hash: input.contentHash,
          provenance,
          snapshot_status: input.snapshotStatus,
          data_as_of: input.dataAsOf ?? null,
          data_loaded_at: input.dataLoadedAt ?? null,
          last_seen_at: input.seenAt ?? nowIso(),
        },
        { onConflict: 'permit_number' },
      )
      .select('*')
      .single(),
    'upsertPermitRecord',
  );

  return toPermit(row, 'permit_records');
}

/** Batched form of {@link upsertPermitRecord} for a full ingestion pass. */
export async function upsertPermitRecords(
  inputs: readonly PermitRecordInput[],
): Promise<number> {
  if (inputs.length === 0) return 0;
  const client = requireClient('upsertPermitRecords');
  const seenAt = nowIso();

  const payload = inputs.map((input) => ({
    permit_number: input.permitNumber,
    record_id: input.recordId ?? null,
    raw: input.raw,
    normalized: input.normalized,
    content_hash: input.contentHash,
    provenance: provenanceSchema.parse(input.provenance),
    snapshot_status: input.snapshotStatus,
    data_as_of: input.dataAsOf ?? null,
    data_loaded_at: input.dataLoadedAt ?? null,
    last_seen_at: input.seenAt ?? seenAt,
  }));

  let written = 0;
  for (const batch of chunk(payload, 250)) {
    const rows = unwrap(
      await client
        .from('permit_records')
        .upsert(batch, { onConflict: 'permit_number' })
        .select('permit_number'),
      'upsertPermitRecords',
    );
    written += rows.length;
  }
  return written;
}

/**
 * Mark permits that this pass did not observe.
 *
 * Called with the keys the current query did NOT return. It records absence as
 * absence; it never deletes and never infers that the project ended.
 */
export async function markNotObserved(permitNumbers: readonly string[]): Promise<number> {
  if (permitNumbers.length === 0) return 0;
  const client = requireClient('markNotObserved');

  let touched = 0;
  for (const batch of chunk(permitNumbers, 250)) {
    const rows = unwrap(
      await client
        .from('permit_records')
        .update({ snapshot_status: 'not_observed' })
        .in('permit_number', batch)
        .select('permit_number'),
      'markNotObserved',
    );
    touched += rows.length;
  }
  return touched;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every stored permit's content hash, for snapshot diffing.
 *
 * Paginated on purpose: the committed extract alone is 10,880 permits, and a
 * truncated read here would make already-known permits look brand new.
 */
export async function getPermitHashes(): Promise<Map<string, string>> {
  const client = requireClient('getPermitHashes');
  const rows = await fetchAllPaged('getPermitHashes', (from, to) =>
    client
      .from('permit_records')
      .select('permit_number,content_hash')
      .order('permit_number', { ascending: true })
      .range(from, to),
  );

  const hashSchema = z.object({
    permit_number: z.string().min(1),
    content_hash: z.string().min(1),
  });

  const hashes = new Map<string, string>();
  for (const row of parseRows(hashSchema, rows, 'permit_records')) {
    hashes.set(row.permit_number, row.content_hash);
  }
  return hashes;
}

/** One permit by its agency-issued number, or `null`. */
export async function getPermit(permitNumber: string): Promise<PermitRecord | null> {
  const client = requireClient('getPermit');
  const rows = unwrap(
    await client.from('permit_records').select('*').eq('permit_number', permitNumber).limit(1),
    'getPermit',
  );
  const row = rows[0];
  return row === undefined ? null : toPermit(row, 'permit_records');
}

/** Most recently observed permits first. Drives the ingestion feed in the UI. */
export async function listRecentPermits(limit = 25): Promise<PermitRecord[]> {
  const client = requireClient('listRecentPermits');
  const rows = unwrap(
    await client
      .from('permit_records')
      .select('*')
      .order('last_seen_at', { ascending: false })
      .limit(limit),
    'listRecentPermits',
  );
  return parseRows(permitRowSchema, rows, 'permit_records').map((row) =>
    toPermit(row, 'permit_records'),
  );
}

/** Count of stored permits, for the dashboard header. */
export async function countPermits(): Promise<number> {
  const client = requireClient('countPermits');
  return unwrapCount(
    await client.from('permit_records').select('permit_number', { count: 'exact', head: true }),
    'countPermits',
  );
}

/* -------------------------------------------------------------------------- */
/* Replay staging                                                             */
/* -------------------------------------------------------------------------- */

const replayRowSchema = z.object({
  permit_number: z.string().min(1),
  raw: jsonObjectSchema,
  original_ts: dbTimestamp,
  released: z.boolean(),
  released_at: dbTimestampNullable,
});

export interface ReplayRecord {
  permitNumber: string;
  /** The real agency row, held until the accelerated clock reaches it. */
  raw: JsonObject;
  /** The timestamp the record actually carried, e.g. its `filed_date`. */
  originalTs: string;
  released: boolean;
  releasedAt: string | null;
}

export interface ReplayRecordInput {
  permitNumber: string;
  raw: JsonObject;
  originalTs: string;
}

function toReplayRecord(row: unknown, context: string): ReplayRecord {
  const parsed = parseRow(replayRowSchema, row, context);
  return {
    permitNumber: parsed.permit_number,
    raw: parsed.raw,
    originalTs: parsed.original_ts,
    released: parsed.released,
    releasedAt: parsed.released_at,
  };
}

/**
 * Load real records into the staging table.
 *
 * `ignoreDuplicates` makes this `ON CONFLICT DO NOTHING`: re-staging the extract
 * mid-demo adds whatever is new and leaves already-released rows released. A
 * plain upsert would reset `released` and replay the same permits twice.
 *
 * Returns how many rows were newly staged.
 */
export async function stageReplayRecords(
  rows: readonly ReplayRecordInput[],
): Promise<number> {
  if (rows.length === 0) return 0;
  const client = requireClient('stageReplayRecords');

  const payload = rows.map((row) => ({
    permit_number: row.permitNumber,
    raw: row.raw,
    original_ts: row.originalTs,
  }));

  let staged = 0;
  for (const batch of chunk(payload, 250)) {
    const inserted = unwrap(
      await client
        .from('replay_staging')
        .upsert(batch, { onConflict: 'permit_number', ignoreDuplicates: true })
        .select('permit_number'),
      'stageReplayRecords',
    );
    staged += inserted.length;
  }
  return staged;
}

/**
 * Claim the next batch of records whose original timestamp has been reached.
 *
 * Two steps, both necessary:
 *
 * 1. Select the oldest unreleased keys that are due, up to `limit`. PostgREST
 *    will not put a LIMIT on an UPDATE, so the window is chosen first.
 * 2. Update those keys with `released = false` still in the predicate. That
 *    guard turns the write into a compare-and-swap: a second replay tick racing
 *    the first re-evaluates the predicate after the row lock clears, sees the
 *    row already released, and skips it. Only rows this call actually flipped
 *    come back from `.select()`, so a record can never be replayed twice.
 */
export async function claimDueReplayRecords(
  now: string,
  limit = 25,
): Promise<ReplayRecord[]> {
  const client = requireClient('claimDueReplayRecords');

  const due = unwrap(
    await client
      .from('replay_staging')
      .select('permit_number')
      .eq('released', false)
      .lte('original_ts', now)
      .order('original_ts', { ascending: true })
      .limit(limit),
    'claimDueReplayRecords (select due)',
  );
  if (due.length === 0) return [];

  const keys = due.map((row) => row.permit_number);
  const claimed = unwrap(
    await client
      .from('replay_staging')
      .update({ released: true, released_at: nowIso() })
      .in('permit_number', keys)
      .eq('released', false)
      .select('*'),
    'claimDueReplayRecords (claim)',
  );

  return parseRows(replayRowSchema, claimed, 'replay_staging')
    .map((row) => toReplayRecord(row, 'replay_staging'))
    .sort((a, b) => a.originalTs.localeCompare(b.originalTs));
}

export interface ReplayProgress {
  total: number;
  released: number;
  pending: number;
  /** Original timestamp of the next record waiting, or `null` when drained. */
  nextDueAt: string | null;
}

/** How far through the staged extract the replay harness has got. */
export async function replayProgress(): Promise<ReplayProgress> {
  const client = requireClient('replayProgress');

  const total = unwrapCount(
    await client.from('replay_staging').select('permit_number', { count: 'exact', head: true }),
    'replayProgress (total)',
  );
  const released = unwrapCount(
    await client
      .from('replay_staging')
      .select('permit_number', { count: 'exact', head: true })
      .eq('released', true),
    'replayProgress (released)',
  );
  const next = unwrap(
    await client
      .from('replay_staging')
      .select('original_ts')
      .eq('released', false)
      .order('original_ts', { ascending: true })
      .limit(1),
    'replayProgress (next)',
  );

  const nextRow = next[0];
  return {
    total,
    released,
    pending: total - released,
    nextDueAt: nextRow === undefined ? null : parseRow(dbTimestamp, nextRow.original_ts, 'replay_staging.original_ts'),
  };
}
