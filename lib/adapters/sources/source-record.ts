/**
 * The raw record envelope every source adapter emits.
 *
 * Origin: envelope/provenance pattern adapted from SiteVelocity
 * (https://github.com/samshanmukh/SiteVelocity).
 *
 * Nothing enters the system as a bare JSON blob. A `RawSourceRecord` pairs the
 * untouched agency payload with the identity of where it came from, so any fact
 * later derived from it can be traced back to an agency, a dataset id, an exact
 * endpoint, and a retrieval time (CLAUDE.md hard rule #8).
 *
 * The envelope deliberately does NOT interpret the payload. Field mapping is the
 * normalizer's job; this layer only guarantees that a payload can never be
 * separated from its provenance. `raw` therefore stays `Record<string, unknown>`:
 * the whole point is that we have not decided what the columns mean yet.
 */
import { z } from 'zod';

import { provenanceSchema, type Provenance, type SourceDescriptor } from '@/lib/domain/schemas/core';

/* -------------------------------------------------------------------------- */
/* Envelope                                                                   */
/* -------------------------------------------------------------------------- */

/** Untyped-but-validated agency payload: a flat-ish JSON object, contents unknown. */
export const rawPayloadSchema = z.record(z.string(), z.unknown());
export type RawPayload = z.infer<typeof rawPayloadSchema>;

/**
 * One retrieved row plus the provenance it must never be separated from.
 *
 * - `sourceId`  registry key (`datasf.building_permits`), duplicated out of
 *               `provenance` so callers can group without reaching inside.
 * - `datasetId` agency dataset identity (Socrata 4x4), same reasoning.
 * - `key`       natural key of the row within the dataset (`permit_number` for
 *               permits, `id` for contact rows). Dedupe and snapshot diffing key
 *               off this and nothing else.
 */
export const rawSourceRecordSchema = z.object({
  sourceId: z.string().min(1),
  datasetId: z.string().min(1),
  key: z.string().min(1),
  raw: rawPayloadSchema,
  provenance: provenanceSchema,
});
export type RawSourceRecord = z.infer<typeof rawSourceRecordSchema>;

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

/** Inputs a source adapter supplies when stamping provenance onto a page of rows. */
export interface ProvenanceStamp {
  /** The registry entry the rows were pulled through. */
  readonly descriptor: SourceDescriptor;
  /** When this system performed the retrieval. ISO-8601 with offset. */
  readonly retrievedAt: string;
  /** Agency-reported currency of the row, already normalized. `null` when absent. */
  readonly dataAsOf?: string | null;
  readonly dataLoadedAt?: string | null;
  /** True only when the replay harness released the row (CLAUDE.md hard rule #5). */
  readonly replayed?: boolean;
}

/** Build a validated `Provenance` from a registry descriptor. */
export function buildProvenance(stamp: ProvenanceStamp): Provenance {
  return provenanceSchema.parse({
    sourceId: stamp.descriptor.id,
    datasetId: stamp.descriptor.datasetId,
    endpoint: stamp.descriptor.endpoint,
    retrievedAt: stamp.retrievedAt,
    dataAsOf: stamp.dataAsOf ?? null,
    dataLoadedAt: stamp.dataLoadedAt ?? null,
    replayed: stamp.replayed ?? false,
  });
}

/**
 * Wrap a single agency payload in its envelope.
 *
 * Throws when `key` is missing or blank: a row we cannot name is a row we cannot
 * dedupe, and silently inventing a key would violate the no-fabrication rule.
 */
export function buildRawSourceRecord(args: {
  readonly descriptor: SourceDescriptor;
  readonly key: string;
  readonly raw: RawPayload;
  readonly provenance: Provenance;
}): RawSourceRecord {
  return rawSourceRecordSchema.parse({
    sourceId: args.descriptor.id,
    datasetId: args.descriptor.datasetId,
    key: args.key,
    raw: args.raw,
    provenance: args.provenance,
  });
}

/**
 * Read a natural key out of a payload without trusting its JSON type.
 *
 * Socrata hands back every value as a string today, but "today" is not a
 * contract, so numbers are accepted and stringified rather than dropped.
 * Returns `null` when the column is absent or empty.
 */
export function readKeyField(raw: RawPayload, keyField: string): string | null {
  const value = raw[keyField];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return value.toString();
  return null;
}
