/**
 * Registry of deterministic calculations.
 *
 * Origin: pattern adapted from SiteVelocity `lib/calculations/registry.ts`
 * (https://github.com/samshanmukh/SiteVelocity).
 *
 * WHAT THIS IS
 * ------------
 * One named, versioned place listing every arithmetic module the company is
 * allowed to make a decision with. Workers, API routes, and the judge-facing UI
 * resolve calculations through here rather than importing scoring internals, so
 * there is exactly one answer to "what computed this number, and which version
 * of it".
 *
 * WHY IT EXISTS
 * -------------
 * CLAUDE.md hard rule #2 draws a hard line: deterministic code owns filters,
 * thresholds, scoring arithmetic, and billing state; AI owns interpretation and
 * drafting. That line is only enforceable if the deterministic side is
 * enumerable. Anything registered here carries `deterministic: true` as a claim
 * the unit tests hold it to: no network, no clock, no filesystem, no randomness,
 * and "now" passed in as a parameter when a calculation needs it.
 *
 * Adding an entry is a deliberate act. If a module cannot honestly claim purity,
 * it does not belong in the registry; it belongs in a worker.
 */
import {
  LEAD_SCORE_COMPONENT_MAX,
  LEAD_SCORE_THRESHOLD,
  scoreLead,
  type ScoreLeadInput,
} from '@/lib/calculations/scoring/lead-score';
import type { ScoreResult } from '@/lib/domain/schemas/core';

/**
 * A single registered calculation.
 *
 * `version` is bumped by hand whenever the arithmetic changes in a way that
 * would move a stored score. Opportunities record the version that produced
 * them, so a rescore after a weight change is explainable rather than
 * mysterious.
 */
export interface CalculationDescriptor<TInput, TOutput> {
  /** Stable dotted key, e.g. `scoring.lead`. Never renamed once shipped. */
  readonly id: string;
  readonly title: string;
  /** Semver-ish. Bump when output for identical input would change. */
  readonly version: string;
  /** One sentence a judge can read without context. */
  readonly summary: string;
  /** Named outputs this calculation produces, for the UI and the docs. */
  readonly outputs: readonly string[];
  /**
   * Claim, enforced by review and unit tests: pure function of its arguments.
   * No network, clock, filesystem, or randomness.
   */
  readonly deterministic: true;
  readonly run: (input: TInput) => TOutput;
}

/** Metadata view: everything about a calculation except the function itself. */
export type CalculationMetadata = Omit<CalculationDescriptor<never, never>, 'run'>;

/* -------------------------------------------------------------------------- */
/* Entries                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The lead score. Five weighted components over a permit and its Findings,
 * against one subscriber profile, with fatal flags returned separately.
 */
export const leadScoreCalculation: CalculationDescriptor<ScoreLeadInput, ScoreResult> = Object.freeze({
  id: 'scoring.lead',
  title: 'Lead score',
  version: '1.0.0',
  summary: `Weighted permit score across fit ${LEAD_SCORE_COMPONENT_MAX.fit}, demand ${LEAD_SCORE_COMPONENT_MAX.demand}, timing ${LEAD_SCORE_COMPONENT_MAX.timing}, value ${LEAD_SCORE_COMPONENT_MAX.value}, and evidence ${LEAD_SCORE_COMPONENT_MAX.evidence}; delivered at ${LEAD_SCORE_THRESHOLD} or above with no fatal flag.`,
  outputs: ['score', 'drivers', 'warnings', 'fatalFlags'],
  deterministic: true,
  run: scoreLead,
});

/* -------------------------------------------------------------------------- */
/* Lookup                                                                     */
/* -------------------------------------------------------------------------- */

/** Every calculation the company may decide with, keyed by id. */
export const CALCULATIONS = Object.freeze({
  'scoring.lead': leadScoreCalculation,
});

export type CalculationId = keyof typeof CALCULATIONS;

/** Typed lookup. The key type makes an unknown id a compile error, not a runtime one. */
export function getCalculation<K extends CalculationId>(id: K): (typeof CALCULATIONS)[K] {
  return CALCULATIONS[id];
}

/** True when a caller-supplied string names a registered calculation. */
export function isCalculationId(id: string): id is CalculationId {
  return Object.prototype.hasOwnProperty.call(CALCULATIONS, id);
}

/**
 * Metadata for every calculation, for the detail page and the health probe.
 * Deliberately drops `run` so nothing can be invoked straight off a listing.
 */
export function listCalculations(): CalculationMetadata[] {
  return Object.values(CALCULATIONS).map(({ id, title, version, summary, outputs, deterministic }) => ({
    id,
    title,
    version,
    summary,
    outputs,
    deterministic,
  }));
}
