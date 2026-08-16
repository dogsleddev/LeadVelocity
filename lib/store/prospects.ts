/**
 * The Sales Agent's acquisition universe (`prospects`).
 *
 * Rows come from the CSLB public data portal: licensed contractors filtered to
 * classification C-10 in San Francisco county. Deterministic code decides
 * `qualified` (active licence, in territory) and records the reasons; the AI
 * step only decides `segment` (commercial vs residential) and always attaches
 * an evidence label to that judgement (hard rules #2 and #3).
 *
 * Identity is the migration's expression index
 * `(coalesce(license_number, ''), lower(firm_name))`. PostgREST cannot target an
 * expression index with `on_conflict`, so this module reconciles in application
 * code: read the existing universe, diff it against the incoming batch, insert
 * what is new and update only what actually changed. That keeps re-running the
 * CSLB pull idempotent, which is the property that matters.
 *
 * There is no prospect type in `core.ts` because prospects never leave the sales
 * side of the company. The shape is defined here and nowhere else.
 */
import { z } from 'zod';

import { type EvidenceLabel, evidenceLabelSchema } from '@/lib/domain/schemas/core';

import {
  chunk,
  dbTimestamp,
  dbTimestampNullable,
  fetchAllPaged,
  nowIso,
  parseRow,
  parseRows,
  requireClient,
  unwrap,
} from './client';

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export const prospectSegmentSchema = z.enum(['commercial', 'residential', 'unknown']);
export type ProspectSegment = z.infer<typeof prospectSegmentSchema>;

const prospectRowSchema = z.object({
  id: z.string().min(1),
  license_number: z.string().nullable(),
  firm_name: z.string().min(1),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zipcode: z.string().nullable(),
  classification: z.string().nullable(),
  license_status: z.string().nullable(),
  segment: prospectSegmentSchema,
  segment_evidence: evidenceLabelSchema,
  qualified: z.boolean(),
  qualify_reasons: z.array(z.string()),
  source_id: z.string().min(1),
  contacted_at: dbTimestampNullable,
  created_at: dbTimestamp,
});

export interface ProspectRecord {
  id: string;
  licenseNumber: string | null;
  firmName: string;
  city: string | null;
  state: string | null;
  zipcode: string | null;
  /** CSLB licence classification, e.g. `C10`. */
  classification: string | null;
  /** CSLB licence status text, e.g. `active`. */
  licenseStatus: string | null;
  segment: ProspectSegment;
  /** How the segment was established. `unknown` until something establishes it. */
  segmentEvidence: EvidenceLabel;
  qualified: boolean;
  /** Human-readable reasons the deterministic qualifier gave. */
  qualifyReasons: string[];
  /** Registry id of the source this row came from. */
  sourceId: string;
  contactedAt: string | null;
  createdAt: string;
}

/**
 * A prospect as the CSLB adapter produces it.
 *
 * Every optional field is genuinely optional: omitting it on a re-import means
 * "leave whatever is stored alone", while passing `null` means "clear it". That
 * distinction lets the AI classification pass write only `segment` and
 * `segmentEvidence` without touching the licence data underneath it.
 */
export interface ProspectInput {
  licenseNumber?: string | null;
  firmName: string;
  city?: string | null;
  state?: string | null;
  zipcode?: string | null;
  classification?: string | null;
  licenseStatus?: string | null;
  segment?: ProspectSegment;
  segmentEvidence?: EvidenceLabel;
  qualified?: boolean;
  qualifyReasons?: string[];
  sourceId: string;
}

function toProspect(row: unknown, context: string): ProspectRecord {
  const parsed = parseRow(prospectRowSchema, row, context);
  return {
    id: parsed.id,
    licenseNumber: parsed.license_number,
    firmName: parsed.firm_name,
    city: parsed.city,
    state: parsed.state,
    zipcode: parsed.zipcode,
    classification: parsed.classification,
    licenseStatus: parsed.license_status,
    segment: parsed.segment,
    segmentEvidence: parsed.segment_evidence,
    qualified: parsed.qualified,
    qualifyReasons: parsed.qualify_reasons,
    sourceId: parsed.source_id,
    contactedAt: parsed.contacted_at,
    createdAt: parsed.created_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Application-side twin of the `prospects_identity_idx` expression index.
 *
 * Values are trimmed before both hashing and storage so the key computed here
 * and the key Postgres computes from the stored row can never disagree.
 */
export function prospectIdentityKey(
  licenseNumber: string | null | undefined,
  firmName: string,
): string {
  return `${(licenseNumber ?? '').trim()}|${firmName.trim().toLowerCase()}`;
}

function normalizeOptional(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Snake-cased column patch. Only keys the caller supplied are present. */
interface ProspectPatch {
  license_number?: string | null;
  firm_name: string;
  city?: string | null;
  state?: string | null;
  zipcode?: string | null;
  classification?: string | null;
  license_status?: string | null;
  segment?: ProspectSegment;
  segment_evidence?: EvidenceLabel;
  qualified?: boolean;
  qualify_reasons?: string[];
  source_id: string;
}

/** Column patch for the provided keys only. Absent keys are left untouched. */
function toPatch(input: ProspectInput): ProspectPatch {
  const patch: ProspectPatch = {
    firm_name: input.firmName.trim(),
    source_id: input.sourceId,
  };
  if ('licenseNumber' in input) patch.license_number = normalizeOptional(input.licenseNumber);
  if ('city' in input) patch.city = normalizeOptional(input.city);
  if ('state' in input) patch.state = normalizeOptional(input.state);
  if ('zipcode' in input) patch.zipcode = normalizeOptional(input.zipcode);
  if ('classification' in input) patch.classification = normalizeOptional(input.classification);
  if ('licenseStatus' in input) patch.license_status = normalizeOptional(input.licenseStatus);
  if (input.segment !== undefined) patch.segment = input.segment;
  if (input.segmentEvidence !== undefined) patch.segment_evidence = input.segmentEvidence;
  if (input.qualified !== undefined) patch.qualified = input.qualified;
  if (input.qualifyReasons !== undefined) patch.qualify_reasons = input.qualifyReasons;
  return patch;
}

/** True when applying `patch` would actually change `current`. */
function patchChangesRow(patch: ProspectPatch, current: ProspectRecord): boolean {
  if (patch.firm_name !== current.firmName) return true;
  if (patch.source_id !== current.sourceId) return true;
  if ('license_number' in patch && patch.license_number !== current.licenseNumber) return true;
  if ('city' in patch && patch.city !== current.city) return true;
  if ('state' in patch && patch.state !== current.state) return true;
  if ('zipcode' in patch && patch.zipcode !== current.zipcode) return true;
  if ('classification' in patch && patch.classification !== current.classification) return true;
  if ('license_status' in patch && patch.license_status !== current.licenseStatus) return true;
  if (patch.segment !== undefined && patch.segment !== current.segment) return true;
  if (patch.segment_evidence !== undefined && patch.segment_evidence !== current.segmentEvidence) {
    return true;
  }
  if (patch.qualified !== undefined && patch.qualified !== current.qualified) return true;
  if (
    patch.qualify_reasons !== undefined &&
    JSON.stringify(patch.qualify_reasons) !== JSON.stringify(current.qualifyReasons)
  ) {
    return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/** What a reconciliation pass did. Worth logging as a Sales Agent decision. */
export interface UpsertProspectsResult {
  inserted: number;
  updated: number;
  unchanged: number;
}

const INSERT_BATCH = 500;

/**
 * Reconcile a batch of prospects against the stored universe.
 *
 * Within-batch duplicates collapse to the last occurrence, matching the "last
 * writer wins" semantics of an upsert. Cross-batch identity uses
 * {@link prospectIdentityKey}.
 */
export async function upsertProspects(
  rows: readonly ProspectInput[],
): Promise<UpsertProspectsResult> {
  if (rows.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };

  const client = requireClient('upsertProspects');

  const deduped = new Map<string, ProspectInput>();
  for (const row of rows) {
    if (row.firmName.trim().length === 0) {
      throw new Error('upsertProspects: firmName is required and cannot be blank');
    }
    deduped.set(prospectIdentityKey(row.licenseNumber, row.firmName), row);
  }

  const existing = await loadIdentityIndex();

  const toInsert: ProspectPatch[] = [];
  const toUpdate: Array<{ id: string; patch: ProspectPatch }> = [];
  let unchanged = 0;

  for (const [key, input] of deduped) {
    const patch = toPatch(input);
    const current = existing.get(key);
    if (current === undefined) {
      toInsert.push(patch);
    } else if (patchChangesRow(patch, current)) {
      toUpdate.push({ id: current.id, patch });
    } else {
      unchanged += 1;
    }
  }

  for (const batch of chunk(toInsert, INSERT_BATCH)) {
    unwrap(await client.from('prospects').insert(batch).select('id'), 'upsertProspects (insert)');
  }

  for (const { id, patch } of toUpdate) {
    unwrap(
      await client.from('prospects').update(patch).eq('id', id).select('id').single(),
      'upsertProspects (update)',
    );
  }

  return { inserted: toInsert.length, updated: toUpdate.length, unchanged };
}

async function loadIdentityIndex(): Promise<Map<string, ProspectRecord>> {
  const client = requireClient('upsertProspects');
  const rows = await fetchAllPaged('upsertProspects (load existing)', (from, to) =>
    client.from('prospects').select('*').order('created_at', { ascending: true }).range(from, to),
  );
  const index = new Map<string, ProspectRecord>();
  for (const record of parseRows(prospectRowSchema, rows, 'prospects').map((row) =>
    toProspect(row, 'prospects'),
  )) {
    index.set(prospectIdentityKey(record.licenseNumber, record.firmName), record);
  }
  return index;
}

/**
 * Stamp a prospect as contacted so the Sales Agent never messages twice.
 *
 * Cold-outreach discipline (kickoff section 5): in the demo the sample goes to a
 * single consenting phone. This column is what makes "once" enforceable.
 */
export async function markContacted(id: string, at?: string): Promise<ProspectRecord> {
  const client = requireClient('markContacted');
  const row = unwrap(
    await client
      .from('prospects')
      .update({ contacted_at: at ?? nowIso() })
      .eq('id', id)
      .select('*')
      .single(),
    'markContacted',
  );
  return toProspect(row, 'prospects');
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Qualified prospects, never-contacted first, then oldest first.
 *
 * `nullsFirst` on `contacted_at` is what puts fresh prospects at the head of the
 * queue without needing a second column to track it.
 */
export async function listQualifiedProspects(limit = 25): Promise<ProspectRecord[]> {
  const client = requireClient('listQualifiedProspects');
  const rows = unwrap(
    await client
      .from('prospects')
      .select('*')
      .eq('qualified', true)
      .order('contacted_at', { ascending: true, nullsFirst: true })
      .order('created_at', { ascending: true })
      .limit(limit),
    'listQualifiedProspects',
  );
  return parseRows(prospectRowSchema, rows, 'prospects').map((row) => toProspect(row, 'prospects'));
}

/** One prospect by id, or `null`. */
export async function getProspect(id: string): Promise<ProspectRecord | null> {
  const client = requireClient('getProspect');
  const rows = unwrap(
    await client.from('prospects').select('*').eq('id', id).limit(1),
    'getProspect',
  );
  const row = rows[0];
  return row === undefined ? null : toProspect(row, 'prospects');
}
