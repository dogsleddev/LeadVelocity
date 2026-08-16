/**
 * Core domain vocabulary.
 *
 * Origin: structure and evidence model adapted from SiteVelocity
 * (`lib/domain/schemas/core.ts`, https://github.com/samshanmukh/SiteVelocity).
 *
 * These names are merge-critical. `SourceDescriptor`, `Finding`, `ScoreOutput`,
 * the snapshot semantics, and the evidence labels are shared vocabulary with the
 * upstream project and MUST NOT be renamed (CLAUDE.md conventions).
 *
 * Everything crossing a boundary (source records, agent output, API routes) is
 * validated through the Zod schemas here. No `any`, no unvalidated shapes.
 */
import { z } from 'zod';

import { tradeSchema } from '@/lib/domain/trades';

/* -------------------------------------------------------------------------- */
/* Evidence model                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Confidence attached to every stored fact.
 *
 * - `verified`     first-party authoritative source confirmed it (e.g. the permit
 *                  record itself, or a CSLB license lookup that returned a match).
 * - `corroborated` two or more independent sources agree, none authoritative.
 * - `inferred`     derived by reasoning over other facts. Defensible, not observed.
 * - `unknown`      we looked and could not establish it. Stays visible; never
 *                  silently dropped and never replaced with a guess.
 *
 * Hard rule (CLAUDE.md #3): nothing is ever fabricated. An absent fact is
 * `unknown`, including in the demo path.
 */
export const evidenceLabelSchema = z.enum(['verified', 'corroborated', 'inferred', 'unknown']);
export type EvidenceLabel = z.infer<typeof evidenceLabelSchema>;

/** Ordering used when a stronger observation should replace a weaker one. */
export const EVIDENCE_STRENGTH: Readonly<Record<EvidenceLabel, number>> = Object.freeze({
  unknown: 0,
  inferred: 1,
  corroborated: 2,
  verified: 3,
});

/** True when `next` is a strictly stronger claim than `current`. */
export function isStrongerEvidence(next: EvidenceLabel, current: EvidenceLabel): boolean {
  return EVIDENCE_STRENGTH[next] > EVIDENCE_STRENGTH[current];
}

/* -------------------------------------------------------------------------- */
/* Source provenance                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Identity of an external data source, preserved on every raw record so a fact
 * can always be traced back to the agency, dataset, and exact endpoint it came
 * from. Field mappings are declared only after live schema inspection
 * (CLAUDE.md hard rule #8).
 */
export const sourceDescriptorSchema = z.object({
  /** Stable registry key, e.g. `datasf.building_permits`. */
  id: z.string().min(1),
  /** Publishing agency, human readable. */
  agency: z.string().min(1),
  /** Dataset identity as the agency names it, e.g. the Socrata 4x4 `i98e-djp9`. */
  datasetId: z.string().min(1),
  /** Dataset title as published. */
  name: z.string().min(1),
  /** Exact endpoint the record was retrieved from. */
  endpoint: z.string().url(),
  /** Transport/shape of the source. */
  kind: z.enum(['socrata', 'http-json', 'csv', 'replay']),
  /** Cadence the agency claims, free text (e.g. "weekly", "daily"). */
  updateCadence: z.string().optional(),
});
export type SourceDescriptor = z.infer<typeof sourceDescriptorSchema>;

/** Provenance stamped onto a single retrieved record. */
export const provenanceSchema = z.object({
  sourceId: z.string().min(1),
  datasetId: z.string().min(1),
  endpoint: z.string(),
  /** When this system retrieved it. */
  retrievedAt: z.string().datetime({ offset: true }),
  /** Agency-reported currency of the record, if the dataset exposes it. */
  dataAsOf: z.string().nullable(),
  dataLoadedAt: z.string().nullable(),
  /** True when the record was released by the replay harness, not a live call. */
  replayed: z.boolean().default(false),
});
export type Provenance = z.infer<typeof provenanceSchema>;

/* -------------------------------------------------------------------------- */
/* Snapshot / change detection                                                */
/* -------------------------------------------------------------------------- */

/**
 * Result of diffing a fresh observation against the last stored snapshot.
 *
 * `not_observed` deliberately does NOT mean "deleted". Public datasets drop and
 * re-add rows for reasons that have nothing to do with the real world, so an
 * unobserved record is recorded as unobserved and nothing more.
 */
export const snapshotStatusSchema = z.enum(['added', 'changed', 'not_observed']);
export type SnapshotStatus = z.infer<typeof snapshotStatusSchema>;

export const snapshotDeltaSchema = z.object({
  key: z.string().min(1),
  status: snapshotStatusSchema,
  /** Field names that differ, populated only when status is `changed`. */
  changedFields: z.array(z.string()).default([]),
  /** Content hash of the normalized record at observation time. */
  contentHash: z.string(),
  observedAt: z.string().datetime({ offset: true }),
});
export type SnapshotDelta = z.infer<typeof snapshotDeltaSchema>;

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A single evidence-labeled fact about a candidate.
 *
 * Findings are the only way a fact enters the system. Scoring reads Findings;
 * the UI renders Findings with their labels visible. A Finding with a `null`
 * value and label `unknown` is a first-class, expected outcome.
 */
export const findingSchema = z.object({
  id: z.string().optional(),
  candidateId: z.string().min(1),
  /** Machine key, e.g. `gc.firm_name`, `gc.license_status`, `project.valuation`. */
  key: z.string().min(1),
  /** Human-readable label for the UI. */
  label: z.string().min(1),
  /** Observed value. `null` is meaningful and pairs with `unknown`. */
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  evidence: evidenceLabelSchema,
  /** Registry id of the source that produced this fact, when there is one. */
  sourceId: z.string().nullable(),
  /** Short provenance note rendered under the fact in the UI. */
  note: z.string().default(''),
  observedAt: z.string().datetime({ offset: true }),
});
export type Finding = z.infer<typeof findingSchema>;

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

/** One signed contribution to a score, always carrying its reason. */
export const scoreDriverSchema = z.object({
  delta: z.number(),
  reason: z.string().min(1),
});
export type ScoreDriver = z.infer<typeof scoreDriverSchema>;

/**
 * Output shape shared with SiteVelocity's calculation layer.
 *
 * An LLM never produces this (CLAUDE.md hard rule #2). It is computed
 * arithmetically from Findings by a pure module.
 *
 * `warnings` are advisory. Fatal conditions are NOT folded in here: they are
 * returned separately as `fatalFlags` so they can never be averaged away.
 */
export const scoreOutputSchema = z.object({
  score: z.number().min(0).max(100),
  drivers: z.array(scoreDriverSchema),
  warnings: z.array(z.string()).default([]),
});
export type ScoreOutput = z.infer<typeof scoreOutputSchema>;

/** A disqualifying condition. Never averaged into `score`. */
export const fatalFlagSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
});
export type FatalFlag = z.infer<typeof fatalFlagSchema>;

/** Full result of a scoring pass: the score plus any disqualifiers. */
export const scoreResultSchema = scoreOutputSchema.extend({
  fatalFlags: z.array(fatalFlagSchema).default([]),
});
export type ScoreResult = z.infer<typeof scoreResultSchema>;

/* -------------------------------------------------------------------------- */
/* Agents and the decision log                                                */
/* -------------------------------------------------------------------------- */

/**
 * Exactly four agents (CLAUDE.md hard rule #4). Stripe is not a Billing Agent,
 * cron is not a Monitoring Agent. Do not extend this enum.
 */
export const agentNameSchema = z.enum(['ceo', 'sales', 'lead', 'customer']);
export type AgentName = z.infer<typeof agentNameSchema>;

/**
 * One append-only entry in the decision log. Every agent decision writes one
 * (CLAUDE.md hard rule #6). This log is the demo.
 */
export const agentEventSchema = z.object({
  id: z.string().optional(),
  ts: z.string().datetime({ offset: true }),
  agent: agentNameSchema,
  /** Short machine-ish verb, e.g. `shortlist.rejected`, `opportunity.delivered`. */
  decision: z.string().min(1),
  /** One sentence a judge can read without context. */
  summary: z.string().min(1),
  /** Pointers to the rows this decision touched. */
  refs: z.record(z.string(), z.string()).default({}),
});
export type AgentEvent = z.infer<typeof agentEventSchema>;

/* -------------------------------------------------------------------------- */
/* Customer profile                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Trades live in `lib/domain/trades.ts`, which is the single place the engine
 * knows what a trade is. Re-exported here so `core.ts` stays the one import for
 * shared vocabulary. The product serves commercial contractors generally;
 * electrical is the trade the demo is configured for, not the product's limit.
 */
export { tradeSchema };
export type { Trade } from '@/lib/domain/trades';

/**
 * The subscriber's buying profile. `effectiveWeights` is what the Customer Agent
 * mutates in response to feedback; the base profile stays as the human-stated
 * intent so the two can be diffed in the UI.
 */
export const customerProfileSchema = z.object({
  id: z.string().optional(),
  businessName: z.string().min(1),
  trade: tradeSchema,
  /** Territory as neighbourhood / district names plus zip allowlist. */
  territoryZips: z.array(z.string()).default([]),
  territoryDistricts: z.array(z.string()).default([]),
  /** Minimum project valuation in USD the subscriber will chase. */
  // Matches the `min_project_value` default in 0001_init.sql. Keep the two in step.
  minProjectValue: z.number().nonnegative().default(25_000),
  /** Uses the subscriber wants; empty means "any commercial". */
  preferredUses: z.array(z.string()).default([]),
  phone: z.string().min(1),
  status: z.enum(['prospect', 'active', 'paused', 'cancelled']).default('prospect'),
  effectiveWeights: z
    .object({
      fit: z.number().default(1),
      demand: z.number().default(1),
      timing: z.number().default(1),
      value: z.number().default(1),
      evidence: z.number().default(1),
    })
    .default({ fit: 1, demand: 1, timing: 1, value: 1, evidence: 1 }),
});
export type CustomerProfile = z.infer<typeof customerProfileSchema>;

/* -------------------------------------------------------------------------- */
/* Opportunity                                                                */
/* -------------------------------------------------------------------------- */

export const opportunityStatusSchema = z.enum(['delivered', 'archived', 'pending']);
export type OpportunityStatus = z.infer<typeof opportunityStatusSchema>;

export const feedbackSchema = z.enum(['good', 'too_small', 'wrong_scope']);
export type Feedback = z.infer<typeof feedbackSchema>;
