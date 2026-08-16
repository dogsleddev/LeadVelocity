/**
 * The Terac GenPop message study (`message_studies`).
 *
 * Event rule, P0 (kickoff sections 3 and 5): the company must collect real human
 * input during the event and show a clear before and after. The Sales Agent
 * drafts three variants of the outreach message, a General Population panel
 * ranks them and rates trust and clarity, and the winner is picked in code.
 *
 * Winner selection is deterministic and lives in the caller, not here: highest
 * mean rank, trust breaks ties (hard rule #2, an LLM never adjudicates). This
 * module stores the variants, the panel's numbers, and the adopted copy so the
 * dashboard can render the before and after from real data rather than from a
 * claim about it.
 *
 * Field naming: `variants` and `results` are `jsonb` and the migration documents
 * their internal keys in snake_case (`[{ id, mean_rank, trust, clarity, n }]`).
 * That documented shape is the contract, so the mapping to camelCase happens
 * here rather than being quietly changed on disk.
 */
import { z } from 'zod';

import {
  dbTimestamp,
  dbTimestampNullable,
  nowIso,
  parseRow,
  requireClient,
  unwrap,
} from './client';

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export const studyStatusSchema = z.enum(['draft', 'launched', 'complete', 'failed']);
export type StudyStatus = z.infer<typeof studyStatusSchema>;

/** One candidate message put in front of the panel. */
export const studyVariantSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});
export type StudyVariant = z.infer<typeof studyVariantSchema>;

/**
 * Stored form of a panel result row, snake_cased per the migration comment.
 *
 * Shape follows what Terac actually reports. Its panel mechanism yields
 * per-question first-choice selection counts and shares (`screening_stats`),
 * not ordinal ranks, so that is what is persisted. See the deviation note in
 * `lib/integrations/terac.ts`.
 */
const studyResultRowSchema = z.object({
  id: z.string().min(1),
  label: z.string().default(''),
  /** Question key to selection count, e.g. { trust: 21, clarity: 18, reply: 20 }. */
  selections: z.record(z.string(), z.coerce.number()).default({}),
  /** Question key to share of respondents, 0..1. */
  shares: z.record(z.string(), z.coerce.number()).default({}),
  total_selections: z.coerce.number().int().nonnegative(),
});

/** Panel numbers for one variant. */
export interface StudyResult {
  variantId: string;
  /** Label the panel saw, e.g. "Message A". */
  label: string;
  /** First-choice selections per question key. */
  selections: Record<string, number>;
  /** Share of respondents per question key, 0..1, as reported. */
  shares: Record<string, number>;
  /** Sum of selections across every question. The primary ordering key. */
  totalSelections: number;
}

/** The adopted copy plus the variant it came from. */
export interface StudyWinner {
  variantId: string;
  text: string;
}

const studyRowSchema = z.object({
  id: z.string().min(1),
  study_ref: z.string().nullable(),
  variants: z.array(studyVariantSchema),
  results: z.array(studyResultRowSchema).nullable(),
  winner_variant_id: z.string().nullable(),
  winner_text: z.string().nullable(),
  status: studyStatusSchema,
  launched_at: dbTimestampNullable,
  completed_at: dbTimestampNullable,
  created_at: dbTimestamp,
});

export interface MessageStudy {
  id: string;
  /** Identifier Terac gave the study, once it is launched. */
  studyRef: string | null;
  variants: StudyVariant[];
  /** `null` until the panel reports. Absence is not a zero. */
  results: StudyResult[] | null;
  winner: StudyWinner | null;
  status: StudyStatus;
  launchedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

function toStudy(row: unknown, context: string): MessageStudy {
  const parsed = parseRow(studyRowSchema, row, context);
  return {
    id: parsed.id,
    studyRef: parsed.study_ref,
    variants: parsed.variants,
    results:
      parsed.results === null
        ? null
        : parsed.results.map((result) => ({
            variantId: result.id,
            label: result.label,
            selections: result.selections,
            shares: result.shares,
            totalSelections: result.total_selections,
          })),
    winner:
      parsed.winner_variant_id === null || parsed.winner_text === null
        ? null
        : { variantId: parsed.winner_variant_id, text: parsed.winner_text },
    status: parsed.status,
    launchedAt: parsed.launched_at,
    completedAt: parsed.completed_at,
    createdAt: parsed.created_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Record the drafted variants before anything is sent to the panel.
 *
 * Writing the "before" first is the point: the drafts are on record ahead of the
 * result, so the before-and-after on the dashboard cannot be assembled after the
 * fact.
 */
export async function createStudy(variants: readonly StudyVariant[]): Promise<MessageStudy> {
  const client = requireClient('createStudy');
  const validated = z.array(studyVariantSchema).min(2).parse(variants);

  const ids = new Set(validated.map((variant) => variant.id));
  if (ids.size !== validated.length) {
    throw new Error('createStudy: variant ids must be unique');
  }

  const row = unwrap(
    await client
      .from('message_studies')
      .insert({ variants: validated, status: 'draft' })
      .select('*')
      .single(),
    'createStudy',
  );
  return toStudy(row, 'message_studies');
}

/** Attach the Terac study reference and move to `launched`. */
export async function markLaunched(id: string, studyRef: string): Promise<MessageStudy> {
  const client = requireClient('markLaunched');
  const row = unwrap(
    await client
      .from('message_studies')
      .update({ study_ref: studyRef, status: 'launched', launched_at: nowIso() })
      .eq('id', id)
      .select('*')
      .single(),
    'markLaunched',
  );
  return toStudy(row, 'message_studies');
}

/**
 * Store the panel's numbers and the copy the company adopted.
 *
 * The winner is supplied, not derived here: selection is deterministic code that
 * belongs with the rest of the arithmetic. Every result row must correspond to a
 * declared variant, and the winner must be one of them, so the dashboard can
 * never show a winner the panel was not asked about.
 */
export async function recordResults(
  id: string,
  results: readonly StudyResult[],
  winner: StudyWinner,
): Promise<MessageStudy> {
  const client = requireClient('recordResults');

  const current = await getStudy(id);
  if (current === null) throw new Error(`recordResults: study ${id} does not exist`);

  const variantIds = new Set(current.variants.map((variant) => variant.id));
  for (const result of results) {
    if (!variantIds.has(result.variantId)) {
      throw new Error(`recordResults: result references unknown variant ${result.variantId}`);
    }
  }
  if (!variantIds.has(winner.variantId)) {
    throw new Error(`recordResults: winner ${winner.variantId} is not one of the variants`);
  }

  const stored = results.map((result) => ({
    id: result.variantId,
    label: result.label,
    selections: result.selections,
    shares: result.shares,
    total_selections: result.totalSelections,
  }));

  const row = unwrap(
    await client
      .from('message_studies')
      .update({
        results: stored,
        winner_variant_id: winner.variantId,
        winner_text: winner.text,
        status: 'complete',
        completed_at: nowIso(),
      })
      .eq('id', id)
      .select('*')
      .single(),
    'recordResults',
  );
  return toStudy(row, 'message_studies');
}

/**
 * Mark a study that could not complete.
 *
 * Terac being unreachable is a visible failed study, not a missing one and
 * certainly not a fabricated result (hard rule #3).
 */
export async function markFailed(id: string): Promise<MessageStudy> {
  const client = requireClient('markFailed');
  const row = unwrap(
    await client
      .from('message_studies')
      .update({ status: 'failed', completed_at: nowIso() })
      .eq('id', id)
      .select('*')
      .single(),
    'markFailed',
  );
  return toStudy(row, 'message_studies');
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** One study by id, or `null`. */
export async function getStudy(id: string): Promise<MessageStudy | null> {
  const client = requireClient('getStudy');
  const rows = unwrap(
    await client.from('message_studies').select('*').eq('id', id).limit(1),
    'getStudy',
  );
  const row = rows[0];
  return row === undefined ? null : toStudy(row, 'message_studies');
}

/** The most recently created study, whatever state it is in. */
export async function getLatestStudy(): Promise<MessageStudy | null> {
  const client = requireClient('getLatestStudy');
  const rows = unwrap(
    await client
      .from('message_studies')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(1),
    'getLatestStudy',
  );
  const row = rows[0];
  return row === undefined ? null : toStudy(row, 'message_studies');
}

/**
 * The newest study that actually produced panel results.
 *
 * This is what the CEO dashboard renders as the before and after. A launched but
 * unfinished study is not shown as evidence, because it is not evidence yet.
 */
export async function getCompletedStudy(): Promise<MessageStudy | null> {
  const client = requireClient('getCompletedStudy');
  const rows = unwrap(
    await client
      .from('message_studies')
      .select('*')
      .eq('status', 'complete')
      .order('completed_at', { ascending: false })
      .limit(1),
    'getCompletedStudy',
  );
  const row = rows[0];
  return row === undefined ? null : toStudy(row, 'message_studies');
}
