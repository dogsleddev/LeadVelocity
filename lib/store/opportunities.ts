/**
 * Opportunities: a scored candidate, delivered or archived (`opportunities`).
 *
 * This is the product. Everything upstream exists to produce one row here that a
 * contractor can act on: what the project is, why it scores what it scores, the
 * best way in, and what to do next.
 *
 * The score arrives already computed. Hard rule #2 puts the arithmetic in a pure
 * deterministic module and forbids an LLM from producing an overall score, so
 * this module stores `score`, `drivers`, and `warnings` exactly as the scorer
 * emitted them and does no arithmetic of its own.
 *
 * `fatal_flags` is a separate column for a reason spelled out in core.ts: a
 * disqualifying condition must never be averaged into a number. It travels
 * beside the score, never inside it.
 *
 * The AI-authored fields are `summary`, `best_path_in`, and `recommended_action`.
 * Those are customer-facing (hard rule #9): they sell the contractor's problem
 * and the outcome, and the words AI, agent, autonomous, LLM, and automated do
 * not appear in them. This module stores what it is given; enforcing the wording
 * is the drafting layer's job.
 *
 * `component_subtotals` (migration 0003) is the grouped view of the same
 * arithmetic that produced `drivers`: how much each of the five components
 * contributed. It is nullable and never defaulted, because a row scored before
 * the column existed has no breakdown, and five zeroes would read as five real
 * zero scores rather than as an absent record (hard rule #3).
 */
import { z } from 'zod';

import {
  type FatalFlag,
  type Feedback,
  type OpportunityStatus,
  type ScoreDriver,
  fatalFlagSchema,
  feedbackSchema,
  opportunityStatusSchema,
  scoreDriverSchema,
} from '@/lib/domain/schemas/core';

import {
  type Database,
  dbTimestamp,
  dbTimestampNullable,
  nowIso,
  parseRow,
  parseRows,
  requireClient,
  unwrap,
} from './client';

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The five weighted component contributions, as stored in `component_subtotals`.
 *
 * The keys are spelled out rather than imported from the scorer, the same way
 * `effectiveWeightsSchema` in `customers.ts` spells out the matching weights:
 * the store validates what is in the column, and a column that has drifted from
 * the calculation is exactly the failure this boundary check exists to catch.
 * `coerce` because a `numeric` that took a trip through jsonb can come back as a
 * string.
 */
export const componentSubtotalsSchema = z.object({
  fit: z.coerce.number(),
  demand: z.coerce.number(),
  timing: z.coerce.number(),
  value: z.coerce.number(),
  evidence: z.coerce.number(),
});
export type ComponentSubtotals = z.infer<typeof componentSubtotalsSchema>;

const opportunityRowSchema = z.object({
  id: z.string().min(1),
  candidate_id: z.string().min(1),
  customer_id: z.string().min(1),
  score: z.coerce.number(),
  drivers: z.array(scoreDriverSchema),
  warnings: z.array(z.string()),
  fatal_flags: z.array(fatalFlagSchema),
  /**
   * Absent AND null both mean "no breakdown recorded". Absent covers a database
   * that has not had migration 0003 applied yet, where PostgREST returns no such
   * key at all; treating that as a validation failure would take the whole feed
   * down over a column nothing requires. Either way the reader is told it is
   * unavailable rather than shown zeroes.
   */
  component_subtotals: componentSubtotalsSchema.nullable().default(null),
  status: opportunityStatusSchema,
  summary: z.string().nullable(),
  best_path_in: z.string().nullable(),
  recommended_action: z.string().nullable(),
  delivered_at: dbTimestampNullable,
  feedback: feedbackSchema.nullable(),
  feedback_at: dbTimestampNullable,
  created_at: dbTimestamp,
});

export interface OpportunityRecord {
  id: string;
  candidateId: string;
  customerId: string;
  /** 0-100, produced by the deterministic scorer. Never by a model. */
  score: number;
  /** Signed contributions with their reasons, in scorer order. */
  drivers: ScoreDriver[];
  /**
   * The same arithmetic grouped by component, when it was recorded.
   *
   * `null` is a real answer and must be rendered as one: the breakdown was not
   * captured for this row. It is not an excuse to display zeroes, and it is not
   * a reason to recompute the split from `drivers`, which cannot be done without
   * guessing which driver belonged to which component.
   */
  componentSubtotals: ComponentSubtotals | null;
  warnings: string[];
  /** Disqualifiers. Held apart from the score so they cannot be averaged away. */
  fatalFlags: FatalFlag[];
  status: OpportunityStatus;
  /** Customer-facing summary of the project and the opening. */
  summary: string | null;
  /** The contact path with the best chance of a conversation. */
  bestPathIn: string | null;
  /** The single next step the contractor should take. */
  recommendedAction: string | null;
  deliveredAt: string | null;
  feedback: Feedback | null;
  feedbackAt: string | null;
  createdAt: string;
}

export interface CreateOpportunityInput {
  candidateId: string;
  customerId: string;
  score: number;
  drivers: ScoreDriver[];
  /**
   * Per-component contributions from the same scoring pass that produced
   * `score`. Optional: a caller that does not have them writes nothing, and the
   * row reports the breakdown as unavailable.
   */
  componentSubtotals?: ComponentSubtotals | null;
  warnings?: string[];
  fatalFlags?: FatalFlag[];
  summary?: string | null;
  bestPathIn?: string | null;
  recommendedAction?: string | null;
  status?: OpportunityStatus;
}

function toOpportunity(row: unknown, context: string): OpportunityRecord {
  const parsed = parseRow(opportunityRowSchema, row, context);
  return {
    id: parsed.id,
    candidateId: parsed.candidate_id,
    customerId: parsed.customer_id,
    score: parsed.score,
    drivers: parsed.drivers,
    componentSubtotals: parsed.component_subtotals,
    warnings: parsed.warnings,
    fatalFlags: parsed.fatal_flags,
    status: parsed.status,
    summary: parsed.summary,
    bestPathIn: parsed.best_path_in,
    recommendedAction: parsed.recommended_action,
    deliveredAt: parsed.delivered_at,
    feedback: parsed.feedback,
    feedbackAt: parsed.feedback_at,
    createdAt: parsed.created_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Create the opportunity for a candidate, or rewrite it after a rescore.
 *
 * `candidate_id` is unique, so this is an upsert: rescoring after a Terac expert
 * escalation upgraded an `unknown` Finding replaces the numbers in place rather
 * than producing a second opportunity for the same project.
 *
 * `delivered_at` and `feedback` are not in the payload. A rescore must not erase
 * the fact that the contractor already received this lead, nor what they said
 * about it.
 *
 * `component_subtotals` IS in the payload, and an omitted one writes `null`
 * rather than leaving the previous value in place. The breakdown has to belong
 * to the score sitting next to it: keeping an old split beside a new number
 * would produce five bars that do not add up to the total on screen, which is a
 * worse answer than "not recorded".
 */
export async function createOpportunity(
  input: CreateOpportunityInput,
): Promise<OpportunityRecord> {
  const client = requireClient('createOpportunity');

  if (!Number.isFinite(input.score) || input.score < 0 || input.score > 100) {
    throw new Error(`createOpportunity: score must be within 0-100, received ${input.score}`);
  }

  const drivers = z.array(scoreDriverSchema).parse(input.drivers);
  const fatalFlags = z.array(fatalFlagSchema).parse(input.fatalFlags ?? []);
  const componentSubtotals =
    input.componentSubtotals === undefined || input.componentSubtotals === null
      ? null
      : componentSubtotalsSchema.parse(input.componentSubtotals);

  /*
   * Typed as the generated Insert plus the 0003 column.
   *
   * `Database` in ./client.ts is transcribed by hand from the migrations and has
   * not been updated for `component_subtotals`; that file belongs to the store
   * plumbing and is regenerated as a unit. supabase-js rejects excess properties
   * on an insert payload, so the value is described precisely here and narrowed
   * to the generated Insert at the call site. The narrowing is a statement about
   * what the compiler knows, not about what is sent: the column is real, it is
   * in migration 0003, and it is written on every upsert.
   */
  type OpportunityInsert = Database['public']['Tables']['opportunities']['Insert'];
  const payload: OpportunityInsert & { component_subtotals: ComponentSubtotals | null } = {
    candidate_id: input.candidateId,
    customer_id: input.customerId,
    score: input.score,
    drivers,
    warnings: input.warnings ?? [],
    fatal_flags: fatalFlags,
    component_subtotals: componentSubtotals,
    status: input.status ?? 'pending',
    summary: input.summary ?? null,
    best_path_in: input.bestPathIn ?? null,
    recommended_action: input.recommendedAction ?? null,
  };

  const row = unwrap(
    await client
      .from('opportunities')
      .upsert(payload as OpportunityInsert, { onConflict: 'candidate_id' })
      .select('*')
      .single(),
    'createOpportunity',
  );

  return toOpportunity(row, 'opportunities');
}

/**
 * Record that the opportunity reached the contractor.
 *
 * Written after the delivery channel confirms, never before. `delivered_at` is
 * what the dashboard counts and what stops a second send.
 */
export async function markDelivered(id: string, at?: string): Promise<OpportunityRecord> {
  const client = requireClient('markDelivered');
  const row = unwrap(
    await client
      .from('opportunities')
      .update({ status: 'delivered', delivered_at: at ?? nowIso() })
      .eq('id', id)
      .select('*')
      .single(),
    'markDelivered',
  );
  return toOpportunity(row, 'opportunities');
}

/**
 * Store the contractor's verdict.
 *
 * This is the only real signal the Customer Agent gets, and it is what moves
 * `effective_weights` on the customer profile. `good | too_small | wrong_scope`
 * is the whole vocabulary; anything richer would be inventing input the
 * contractor never gave.
 */
export async function recordFeedback(
  id: string,
  feedback: Feedback,
  at?: string,
): Promise<OpportunityRecord> {
  const client = requireClient('recordFeedback');
  const validated = feedbackSchema.parse(feedback);
  const row = unwrap(
    await client
      .from('opportunities')
      .update({ feedback: validated, feedback_at: at ?? nowIso() })
      .eq('id', id)
      .select('*')
      .single(),
    'recordFeedback',
  );
  return toOpportunity(row, 'opportunities');
}

/** Archive an opportunity that will not be delivered. */
export async function archiveOpportunity(id: string): Promise<OpportunityRecord> {
  const client = requireClient('archiveOpportunity');
  const row = unwrap(
    await client
      .from('opportunities')
      .update({ status: 'archived' })
      .eq('id', id)
      .select('*')
      .single(),
    'archiveOpportunity',
  );
  return toOpportunity(row, 'opportunities');
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** One opportunity by id, or `null`. */
export async function getOpportunity(id: string): Promise<OpportunityRecord | null> {
  const client = requireClient('getOpportunity');
  const rows = unwrap(
    await client.from('opportunities').select('*').eq('id', id).limit(1),
    'getOpportunity',
  );
  const row = rows[0];
  return row === undefined ? null : toOpportunity(row, 'opportunities');
}

/** The opportunity produced for a candidate, if it has been scored. */
export async function getOpportunityByCandidate(
  candidateId: string,
): Promise<OpportunityRecord | null> {
  const client = requireClient('getOpportunityByCandidate');
  const rows = unwrap(
    await client.from('opportunities').select('*').eq('candidate_id', candidateId).limit(1),
    'getOpportunityByCandidate',
  );
  const row = rows[0];
  return row === undefined ? null : toOpportunity(row, 'opportunities');
}

export interface ListOpportunitiesOptions {
  status?: OpportunityStatus;
  limit?: number;
  customerId?: string;
}

/** Newest opportunities first, optionally narrowed to one status or customer. */
export async function listOpportunities(
  options: ListOpportunitiesOptions = {},
): Promise<OpportunityRecord[]> {
  const client = requireClient('listOpportunities');
  const limit = options.limit ?? 25;

  const base = client.from('opportunities').select('*');
  const byStatus = options.status === undefined ? base : base.eq('status', options.status);
  const byCustomer =
    options.customerId === undefined ? byStatus : byStatus.eq('customer_id', options.customerId);

  const rows = unwrap(
    await byCustomer.order('created_at', { ascending: false }).limit(limit),
    'listOpportunities',
  );
  return parseRows(opportunityRowSchema, rows, 'opportunities').map((row) =>
    toOpportunity(row, 'opportunities'),
  );
}
