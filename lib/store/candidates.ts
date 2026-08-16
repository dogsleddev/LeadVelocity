/**
 * Candidates: one permit paired with one customer (`candidates`).
 *
 * A candidate is the unit of work the pipeline moves along. It exists the moment
 * the deterministic shortlist filter says a permit is worth looking at for a
 * given subscriber, and it carries the reason that filter gave, in words, so a
 * judge reading the decision log can see why this permit and not the 10,000
 * others.
 *
 * Stages are a strict pipeline, mirrored by the CHECK constraint in the
 * migration:
 *
 *   shortlisted -> enriched -> scored -> delivered
 *                                    \-> archived
 *
 * The `(permit_number, customer_id)` unique constraint is the dedupe guarantee
 * (hard rule #2, dedupe is deterministic): re-running ingestion over the same
 * permit cannot produce a second candidate, so it cannot produce a second
 * opportunity or a second text message.
 */
import { z } from 'zod';

import { dbTimestamp, parseRow, parseRows, requireClient, unwrap } from './client';

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export const candidateStageSchema = z.enum([
  'shortlisted',
  'enriched',
  'scored',
  'delivered',
  'archived',
]);
export type CandidateStage = z.infer<typeof candidateStageSchema>;

const candidateRowSchema = z.object({
  id: z.string().min(1),
  permit_number: z.string().min(1),
  customer_id: z.string().min(1),
  stage: candidateStageSchema,
  shortlist_reason: z.string().nullable(),
  created_at: dbTimestamp,
});

export interface CandidateRecord {
  id: string;
  permitNumber: string;
  customerId: string;
  stage: CandidateStage;
  /** Why the deterministic filter kept this permit for this subscriber. */
  shortlistReason: string | null;
  createdAt: string;
}

export interface CreateCandidateInput {
  permitNumber: string;
  customerId: string;
  shortlistReason?: string | null;
}

function toCandidate(row: unknown, context: string): CandidateRecord {
  const parsed = parseRow(candidateRowSchema, row, context);
  return {
    id: parsed.id,
    permitNumber: parsed.permit_number,
    customerId: parsed.customer_id,
    stage: parsed.stage,
    shortlistReason: parsed.shortlist_reason,
    createdAt: parsed.created_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create the candidate for this permit and customer, or return the existing one.
 *
 * `stage` is deliberately not in the payload. PostgREST only updates the columns
 * present in the body, so a repeat shortlist of a permit already at `scored`
 * refreshes its reason without dragging it backwards to `shortlisted`.
 */
export async function createCandidate(
  input: CreateCandidateInput,
): Promise<CandidateRecord> {
  const client = requireClient('createCandidate');
  const row = unwrap(
    await client
      .from('candidates')
      .upsert(
        {
          permit_number: input.permitNumber,
          customer_id: input.customerId,
          shortlist_reason: input.shortlistReason ?? null,
        },
        { onConflict: 'permit_number,customer_id' },
      )
      .select('*')
      .single(),
    'createCandidate',
  );
  return toCandidate(row, 'candidates');
}

/** Advance (or archive) a candidate. */
export async function setStage(id: string, stage: CandidateStage): Promise<CandidateRecord> {
  const client = requireClient('setStage');
  const row = unwrap(
    await client.from('candidates').update({ stage }).eq('id', id).select('*').single(),
    'setStage',
  );
  return toCandidate(row, 'candidates');
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** One candidate by id, or `null`. */
export async function getCandidate(id: string): Promise<CandidateRecord | null> {
  const client = requireClient('getCandidate');
  const rows = unwrap(
    await client.from('candidates').select('*').eq('id', id).limit(1),
    'getCandidate',
  );
  const row = rows[0];
  return row === undefined ? null : toCandidate(row, 'candidates');
}

/**
 * The work queue for one pipeline stage, oldest first.
 *
 * Oldest first is not cosmetic: it makes the Lead Agent drain a backlog in the
 * order permits arrived rather than starving early records behind a fresh batch.
 */
export async function listCandidatesByStage(
  stage: CandidateStage,
  limit = 25,
): Promise<CandidateRecord[]> {
  const client = requireClient('listCandidatesByStage');
  const rows = unwrap(
    await client
      .from('candidates')
      .select('*')
      .eq('stage', stage)
      .order('created_at', { ascending: true })
      .limit(limit),
    'listCandidatesByStage',
  );
  return parseRows(candidateRowSchema, rows, 'candidates').map((row) =>
    toCandidate(row, 'candidates'),
  );
}

/** The candidate for a permit/customer pair, if one exists. */
export async function getCandidateByPair(
  permitNumber: string,
  customerId: string,
): Promise<CandidateRecord | null> {
  const client = requireClient('getCandidateByPair');
  const rows = unwrap(
    await client
      .from('candidates')
      .select('*')
      .eq('permit_number', permitNumber)
      .eq('customer_id', customerId)
      .limit(1),
    'getCandidateByPair',
  );
  const row = rows[0];
  return row === undefined ? null : toCandidate(row, 'candidates');
}
