/**
 * Deterministic lead scoring.
 *
 * Origin: pattern adapted from SiteVelocity `lib/calculations/scoring/alpha-scores.ts`
 * (https://github.com/samshanmukh/SiteVelocity). Component decomposition, the
 * signed-driver output, and the "fatal flags are never averaged" discipline are
 * carried over; the components themselves are LeadVelocity's.
 *
 * WHAT THIS IS
 * ------------
 * The arithmetic that turns one permit plus its evidence-labeled Findings into a
 * 0-100 number for one subscriber. Five components, fixed maxima:
 *
 *   fit 30 | demand 25 | timing 20 | value 15 | evidence 10   (threshold 80)
 *
 * WHY IT LOOKS LIKE THIS
 * ----------------------
 * CLAUDE.md hard rule #2: an LLM never produces an overall score. Everything here
 * is arithmetic over facts that are already in the record or already stored as a
 * Finding. The AI layer above may interpret a permit description into Findings;
 * it may not move the number. That separation is the reason a judge can ask
 * "why 87?" and get an answer that is reproducible rather than plausible.
 *
 * Three properties this module holds to:
 *
 * 1. PURE. No network, no clock, no filesystem, no randomness. The current time
 *    arrives as the `now` parameter. Same input, same output, forever. The only
 *    date handling is `Date.parse` on caller-supplied strings, which is a pure
 *    string-to-number transform, and it is normalized to UTC below so the result
 *    does not depend on the host machine's timezone.
 *
 * 2. ABSENCE IS NOT ZERO. A missing permit date, an unpublished valuation, an
 *    unclassified use: each scores a documented partial value and raises a
 *    warning. Silently scoring 0 for "we did not look" would be indistinguishable
 *    from "we looked and it is bad", and hard rule #3 forbids that confusion.
 *
 * 3. FATAL FLAGS ARE NOT POINTS. A cancelled permit, a project under the
 *    subscriber's floor, or a job outside the territory is returned in
 *    `fatalFlags` and never folded into `score`. A 92 with a fatal flag is
 *    archived; the 92 stays visible so the reason for archiving is legible.
 *    Corollary enforced below: terminal statuses get NO timing penalty, because
 *    penalizing them inside the score would be exactly the double-counting the
 *    rule exists to prevent.
 */
import { z } from 'zod';

import {
  EVIDENCE_STRENGTH,
  type CustomerProfile,
  type FatalFlag,
  type Finding,
  type ScoreDriver,
  type ScoreResult,
} from '@/lib/domain/schemas/core';
import { tradeProfile, type TradeProfile } from '@/lib/domain/trades';

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Delivery threshold. A candidate at or above this, with no fatal flag, is
 * delivered to the subscriber; anything else is archived with its reasons.
 *
 * This is the single number the whole product turns on. It lives here, alone,
 * so changing the business's appetite is a one-line diff.
 */
export const LEAD_SCORE_THRESHOLD = 80;

/** Component ceilings. These sum to 100 and that invariant is unit-tested. */
export const LEAD_SCORE_COMPONENT_MAX = Object.freeze({
  fit: 30,
  demand: 25,
  timing: 20,
  value: 15,
  evidence: 10,
});
export type LeadScoreComponent = keyof typeof LEAD_SCORE_COMPONENT_MAX;

/** Sub-signal ceilings inside each component. Each group sums to its component. */
const SUB_MAX = Object.freeze({
  useMatch: 14,
  tradeRelevance: 12,
  occupancy: 4,

  valuationBand: 10,
  physicalScale: 6,
  scopeBreadth: 5,
  generalContractor: 4,

  timingCurve: 20,

  valuationRatio: 15,

  evidenceStrength: 7,
  evidenceCoverage: 3,
});

/**
 * Customer weights are clamped to this range before use. The Customer Agent
 * writes `effectiveWeights` from SMS feedback; a runaway multiplier there must
 * degrade the ranking, not corrupt it.
 */
const WEIGHT_MIN = 0;
const WEIGHT_MAX = 3;

/** Timing decay knots, in days since the permit last moved. */
const TIMING_FRESH_DAYS = 14; // full marks inside this window
const TIMING_WARM_DAYS = 180; // linear decay to TIMING_WARM_FLOOR by here
const TIMING_COLD_DAYS = 365; // linear decay to zero by here
const TIMING_WARM_FLOOR = 4;
/** Awarded when the record carries no usable date at all. Not zero, on purpose. */
const TIMING_NO_DATE_FRACTION = 0.3;

const MS_PER_DAY = 86_400_000;

/* -------------------------------------------------------------------------- */
/* Vocabulary lifted from the real extract                                     */
/* -------------------------------------------------------------------------- */

/**
 * `existing_use` / `proposed_use` values observed on the committed DataSF
 * extract (n=10,880). Not invented, not guessed: these are the literal strings
 * the agency publishes, lowercased, including the truncations
 * ("warehouse,no frnitur") that come straight out of PTS.
 */
const COMMERCIAL_USES: ReadonlySet<string> = new Set([
  'office',
  'retail sales',
  'food/beverage hndlng',
  'school',
  'tourist hotel/motel',
  'church',
  'clinics-medic/dental',
  'warehouse,no frnitur',
  'prkng garage/private',
  'prkng garage/public',
  'lending institution',
  'manufacturing',
  'barber/beauty salon',
  'health studios & gym',
  'workshop commercial',
  'theater',
  'auto repairs',
  'recreation bldg',
  'laundry/laundromat',
  'filling/service stn',
  'power plant',
]);

const RESIDENTIAL_USES: ReadonlySet<string> = new Set([
  '1 family dwelling',
  '2 family dwelling',
  'apartments',
  'residential hotel',
  'misc group residns.',
  'artist live/work',
]);

/** Statuses that disqualify a candidate outright. Fatal flag, never a penalty. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  'cancelled',
  'withdrawn',
  'denied',
  'expired',
]);

/**
 * Timing multiplier by permit status. Read as "how much does the clock reading
 * actually mean for this record".
 *
 * Deliberately absent: cancelled / withdrawn / denied / expired. Those are fatal
 * flags. Giving them a 0 multiplier here would push the disqualification back
 * into the score, which is the one thing `fatalFlags` exists to prevent.
 */
const STATUS_TIMING_MULTIPLIER: Readonly<Record<string, number>> = Object.freeze({
  issued: 1, // permit in hand, the trades are being bought right now
  approved: 1,
  reinstated: 0.9,
  filed: 0.85, // real, just earlier in the funnel
  suspend: 0.5, // stalled, may return
  complete: 0.35, // the work already happened; little left to win
});
const STATUS_TIMING_DEFAULT = 0.7;

/**
 * Trade vocabulary is NOT defined here.
 *
 * `core` terms (the trade's own scope), `adjacent` terms (scope that reliably
 * carries the trade behind it), and the inline negations the agency writes into
 * descriptions all live in `lib/domain/trades.ts`, keyed by trade. This module
 * looks up the profile for `customer.trade` and contains no trade-specific
 * language of its own, so scoring a plumbing subscriber is a configuration
 * change rather than a code change.
 *
 * The negations matter: "install non-electric single faced wall sign" is a real
 * description in the extract, and matching `electric` inside it would invent a
 * lead out of a sign permit.
 */
const TRADE_CORE_POINTS = 4.5;
const TRADE_ADJACENT_POINTS = 1.5;

/**
 * Scope domains, for breadth. A description touching many domains is a bigger,
 * longer, more subcontractor-hungry job than one touching a single domain.
 */
const SCOPE_DOMAINS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  electrical: ['electrical', 'electric', 'power', 'panel', 'wiring', 'circuit', 'conduit'],
  lighting: ['lighting', 'light fixture', 'luminaire'],
  partitions: ['partition', 'partitions', 'demising wall', 'non bearing'],
  millwork: ['millwork', 'casework', 'cabinet'],
  ceilings: ['ceiling', 'ceilings', 'soffit'],
  finishes: ['finishes', 'finish', 'paint', 'flooring', 'floor and wall'],
  mechanical: ['hvac', 'mechanical', 'air distribution', 'ductwork', 'duct'],
  plumbing: ['plumbing', 'plumb', 'water heater', 'restroom'],
  fireLife: ['fire alarm', 'sprinkler', 'fire sprinkler', 'strobe', 'smoke detector'],
  structural: ['structural', 'seismic', 'shear', 'girder', 'joist'],
  demolition: ['demolition', 'demo ', 'tear off', 'remove'],
  roofing: ['roof', 'reroof', 're-roofing', 'roofing'],
  kitchen: ['kitchen', 'hood', 'commercial kitchen'],
  vertical: ['elevator', 'escalator', 'lift'],
  lowVoltage: ['communication', 'data', 'av ', 'security', 'access control'],
  envelope: ['window', 'facade', 'storefront', 'curtain wall', 'siding'],
  signage: ['sign', 'signage'],
});

/** Occupancy letters that are not residential. `R` is residential; `R` only. */
const RESIDENTIAL_OCCUPANCY_LETTER = 'R';

/* -------------------------------------------------------------------------- */
/* Input contract                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The permit shape this calculation consumes.
 *
 * CONTRACT NOTE: this is the structural contract that
 * `lib/domain/permit-normalizer.ts` must satisfy. TypeScript is structural, so a
 * richer `NormalizedPermit` from the normalizer assigns cleanly as long as these
 * field names and types line up. Required-and-nullable fields are the ones that
 * carry points; `nullish` fields are read opportunistically and may be omitted.
 *
 * All source values arrive from Socrata as strings. Coercion to number happens
 * in the normalizer, never here: this module trusts the types it is handed and
 * treats `null` as "the agency did not publish it".
 */
export const normalizedPermitSchema = z.object({
  /** DataSF `permit_number`. Primary key and the contacts join key. */
  permitNumber: z.string().min(1),
  /** Lowercased agency status: issued | filed | complete | cancelled | ... */
  status: z.string(),
  /** Free text scope of work. `null` when the agency published none. */
  description: z.string().nullable(),
  /** e.g. "otc alterations permit". */
  permitTypeDefinition: z.string().nullable(),
  existingUse: z.string().nullable(),
  proposedUse: z.string().nullable(),
  /** Occupancy class string, possibly a list: "B", "B,A-2,S-1". */
  existingOccupancy: z.string().nullable(),
  /** max(revised_cost, estimated_cost) after numeric coercion. USD. */
  valuation: z.number().nullable(),
  existingStories: z.number().nullable(),
  proposedStories: z.number().nullable(),
  existingUnits: z.number().nullable(),
  proposedUnits: z.number().nullable(),
  zipcode: z.string().nullable(),
  supervisorDistrict: z.string().nullable(),
  /** ISO 8601. DataSF omits the offset; the normalizer keeps it as published. */
  filedDate: z.string().nullable(),
  issuedDate: z.string().nullable(),
  statusDate: z.string().nullable(),

  /* Read when present, safely absent otherwise. */
  recordId: z.string().nullish(),
  address: z.string().nullish(),
  neighborhood: z.string().nullish(),
  proposedOccupancy: z.string().nullish(),
  estimatedCost: z.number().nullish(),
  revisedCost: z.number().nullish(),
  approvedDate: z.string().nullish(),
  completedDate: z.string().nullish(),
  lastPermitActivityDate: z.string().nullish(),
});
export type NormalizedPermit = z.infer<typeof normalizedPermitSchema>;

/** Everything one scoring pass needs. `now` is a parameter so the module stays pure. */
export interface ScoreLeadInput {
  permit: NormalizedPermit;
  findings: readonly Finding[];
  customer: CustomerProfile;
  /** ISO 8601 timestamp with offset. The only "clock" this module ever sees. */
  now: string;
}

/* -------------------------------------------------------------------------- */
/* Output contract                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What each of the five components contributed to the final number.
 *
 * The value is the WEIGHTED contribution: the component's clamped subtotal plus
 * the subscriber-weight adjustment that was applied to it. It is the same
 * arithmetic the flat `drivers` list already carries, grouped instead of
 * itemized, which is what lets a reader see "fit 29 of 30" without adding up
 * nine signed rows by hand.
 *
 * Two properties worth knowing before rendering it:
 *
 * - A weight above 1 can push a contribution ABOVE its `LEAD_SCORE_COMPONENT_MAX`
 *   ceiling. The ceiling is the unweighted maximum, so a bar drawn as
 *   `contribution / max` must clamp its own width rather than assume the ratio
 *   is at most 1. Reporting the weighted figure is deliberate: it is the number
 *   that actually moved the score.
 * - The five values sum to the weighted total BEFORE the final 0-100 clamp. On
 *   the rare row where that clamp fires, the correction is a visible entry in
 *   `drivers` and belongs to no single component, so the components can sum to
 *   slightly more than `score`.
 */
export type LeadScoreComponents = Record<LeadScoreComponent, number>;

/**
 * `ScoreResult` plus the component view of the same arithmetic.
 *
 * The flat `drivers` array is untouched and remains the audit record: its deltas
 * still sum to `score`, which is the property the scoring tests hold this module
 * to. `components` is a parallel projection of those same deltas, not a second
 * opinion about them, and nothing downstream may recompute a score from it.
 *
 * It extends `ScoreResult` rather than widening `scoreResultSchema` in core.ts
 * because the component names are this module's vocabulary: `core.ts` describes
 * the shape every calculation shares, and only the lead score has these five.
 * Every existing consumer typed against `ScoreResult` keeps working unchanged.
 */
export interface LeadScoreResult extends ScoreResult {
  components: LeadScoreComponents;
}

/* -------------------------------------------------------------------------- */
/* Small pure helpers                                                         */
/* -------------------------------------------------------------------------- */

const round2 = (n: number): number => Math.round(n * 100) / 100;

const clamp = (n: number, min: number, max: number): number =>
  n < min ? min : n > max ? max : n;

/** Largest of the defined numbers, or `null` when none are usable. */
function maxDefined(...values: readonly (number | null | undefined)[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    if (best === null || value > best) best = value;
  }
  return best;
}

const ISO_ZONE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parse an ISO timestamp to epoch milliseconds, deterministically.
 *
 * DataSF publishes `2026-04-10T15:03:06.000` with no timezone designator, and
 * ECMAScript reads a zone-less date-time as LOCAL time. That would make this
 * module's output depend on the machine running it, which breaks purity. So a
 * zone-less date-time is pinned to UTC. Date-only strings are already UTC by
 * spec and are left alone.
 */
function parseTimestamp(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const pinned = trimmed.includes('T') && !ISO_ZONE.test(trimmed) ? `${trimmed}Z` : trimmed;
  const ms = Date.parse(pinned);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Lowercase, whitespace-collapsed description with the trade's negated phrases
 * removed. Negations are per trade, so this takes the profile rather than
 * reaching for a module constant.
 */
function prepareDescription(raw: string | null, profile: TradeProfile): string {
  if (raw === null) return '';
  let text = raw.toLowerCase().replace(/\s+/g, ' ').trim();
  for (const pattern of profile.negations) {
    // Regexes carry the /g flag, so reset lastIndex before reuse.
    pattern.lastIndex = 0;
    text = text.replace(pattern, ' ');
  }
  return text.replace(/\s+/g, ' ').trim();
}

const escapeRegExp = (term: string): string => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whole-word term match. Built once per term at module load; the cache is a pure
 * memo of a pure function, so it does not compromise determinism.
 */
const TERM_PATTERNS = new Map<string, RegExp>();
function termPattern(term: string): RegExp {
  const cached = TERM_PATTERNS.get(term);
  if (cached !== undefined) return cached;
  const built = new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(term)}(?:[^a-z0-9]|$)`, 'i');
  TERM_PATTERNS.set(term, built);
  return built;
}

function matchedTerms(text: string, terms: readonly string[]): string[] {
  const hits: string[] = [];
  for (const term of terms) {
    if (termPattern(term).test(text)) hits.push(term);
  }
  return hits;
}

const lower = (value: string | null | undefined): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim().toLowerCase() : null;

/**
 * Comma-separated occupancy string -> the distinct leading class letter of each
 * token, in order. "B,A-2,S-1" -> ["B","A","S"]; "E,A-3,A-2" -> ["E","A"].
 */
function occupancyLetters(raw: string | null): string[] {
  if (raw === null) return [];
  const seen = new Set<string>();
  const letters: string[] = [];
  for (const token of raw.split(/[,/;]/)) {
    const letter = token.trim().charAt(0).toUpperCase();
    if (!/[A-Z]/.test(letter) || seen.has(letter)) continue;
    seen.add(letter);
    letters.push(letter);
  }
  return letters;
}

/** Accumulator that keeps a component's drivers and its running subtotal aligned. */
class ComponentBuilder {
  readonly drivers: ScoreDriver[] = [];
  private total = 0;

  /** Adds a signed, capped, rounded contribution with its human reason. */
  add(delta: number, reason: string, cap: number): void {
    const rounded = round2(clamp(delta, -cap, cap));
    this.drivers.push({ delta: rounded, reason });
    this.total += rounded;
  }

  subtotal(): number {
    return round2(this.total);
  }
}

/* -------------------------------------------------------------------------- */
/* Component: fit (30)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Does this job belong to this subscriber at all?
 *
 * Use category answers "is it the kind of building they work in", trade language
 * answers "is their trade actually in the scope of work", occupancy class is the
 * building-code cross-check on the first two.
 */
function scoreFit(
  permit: NormalizedPermit,
  customer: CustomerProfile,
  description: string,
  profile: TradeProfile,
  warnings: string[],
): { drivers: ScoreDriver[]; subtotal: number } {
  const builder = new ComponentBuilder();

  /* --- trade relevance gate, checked FIRST because it is categorical -------
   *
   * Fit asks "does this job belong to this subscriber". If the scope of work
   * was published and this trade is nowhere in it, the answer is no, and it
   * stays no however large, recent, or well located the job is. Scoring it
   * additively lets a big enough job in the wrong trade accumulate a delivery
   * out of size alone: an $8.29M office fit-out with no roofing scope reached
   * 63 for a roofing subscriber before this gate existed, and would have
   * crossed the threshold once Findings were attached.
   *
   * Collapsing the whole component rather than just its trade sub-score is the
   * point. With fit at zero the reachable maximum is 70 (demand 25 + timing 20
   * + value 15 + evidence 10), so a trade-mismatched job can never be
   * delivered. That is asserted in lib/domain/trades.test.ts.
   *
   * An EMPTY description is deliberately excluded from this gate. Absent scope
   * language means the trade is not in the job; an absent description means we
   * could not read it, which is unknown and not absent (hard rule 3). Those
   * candidates fall through and score normally with a warning.
   */
  const scope =
    description.length === 0
      ? null
      : {
          core: matchedTerms(description, profile.core),
          adjacent: matchedTerms(description, profile.adjacent),
        };

  if (scope !== null && scope.core.length === 0 && scope.adjacent.length === 0) {
    warnings.push(
      `Scope of work names no ${profile.label} work, so fit is zero regardless of the project's size.`,
    );
    return {
      drivers: [
        {
          delta: 0,
          reason: `Scope of work names no ${profile.label} work, so this job does not fit a ${profile.label} contractor regardless of its size`,
        },
      ],
      subtotal: 0,
    };
  }

  /* --- use category ------------------------------------------------------ */
  const existingUse = lower(permit.existingUse);
  const proposedUse = lower(permit.proposedUse);
  const uses = [existingUse, proposedUse].filter((u): u is string => u !== null);
  const preferred = new Set(customer.preferredUses.map((u) => u.toLowerCase()));
  const preferredHit = uses.find((u) => preferred.has(u));

  if (preferredHit !== undefined) {
    builder.add(
      SUB_MAX.useMatch,
      `Building use "${preferredHit}" is on the subscriber's preferred list`,
      SUB_MAX.useMatch,
    );
  } else if (uses.some((u) => COMMERCIAL_USES.has(u))) {
    const hit = uses.find((u) => COMMERCIAL_USES.has(u)) ?? 'commercial';
    builder.add(10, `Commercial use "${hit}", outside the stated preferences`, SUB_MAX.useMatch);
  } else if (uses.length > 0 && uses.every((u) => RESIDENTIAL_USES.has(u))) {
    const hit = uses[0] ?? 'residential';
    builder.add(0, `Residential use "${hit}" is outside a commercial trade's book`, SUB_MAX.useMatch);
    warnings.push(`Use "${hit}" is residential; this subscriber sells commercial work.`);
  } else if (uses.length > 0) {
    const hit = uses[0] ?? 'unclassified';
    builder.add(5, `Use "${hit}" is not in the observed commercial or residential sets`, SUB_MAX.useMatch);
  } else {
    builder.add(3, 'Building use not published on the permit; partial credit only', SUB_MAX.useMatch);
    warnings.push('Permit publishes no existing or proposed use; fit is partly unverified.');
  }

  /* --- trade relevance of the scope of work ------------------------------
   * The read-and-absent case already returned above, so `scope` here is either
   * null (unreadable description) or a genuine match.
   */
  if (scope === null) {
    builder.add(0, 'Permit carries no description; trade relevance could not be read', SUB_MAX.tradeRelevance);
    warnings.push('Permit description is empty; trade relevance is unassessed, not absent.');
  } else {
    const raw = scope.core.length * TRADE_CORE_POINTS + scope.adjacent.length * TRADE_ADJACENT_POINTS;
    const parts: string[] = [];
    if (scope.core.length > 0) parts.push(`${profile.label} scope (${scope.core.join(', ')})`);
    if (scope.adjacent.length > 0) parts.push(`adjacent scope (${scope.adjacent.join(', ')})`);
    builder.add(
      Math.min(raw, SUB_MAX.tradeRelevance),
      `Scope of work names ${parts.join(' and ')}`,
      SUB_MAX.tradeRelevance,
    );
  }

  /* --- occupancy class --------------------------------------------------- */
  const letters = occupancyLetters(permit.existingOccupancy);
  if (letters.length === 0) {
    builder.add(1, 'Occupancy class not published; partial credit only', SUB_MAX.occupancy);
  } else if (letters.some((letter) => letter !== RESIDENTIAL_OCCUPANCY_LETTER)) {
    builder.add(
      SUB_MAX.occupancy,
      `Occupancy class ${letters.join('/')} is a commercial classification`,
      SUB_MAX.occupancy,
    );
  } else {
    builder.add(0, 'Occupancy class R is residential', SUB_MAX.occupancy);
  }

  return { drivers: builder.drivers, subtotal: builder.subtotal() };
}

/* -------------------------------------------------------------------------- */
/* Component: demand (25)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How much work is actually on this job?
 *
 * Absolute scale, deliberately separate from `value`. `value` asks "is this big
 * enough for this subscriber"; `demand` asks "is there a lot of electrical work
 * inside it", which is a property of the project regardless of who is buying.
 */
function scoreDemand(
  permit: NormalizedPermit,
  findings: readonly Finding[],
  description: string,
  warnings: string[],
): { drivers: ScoreDriver[]; subtotal: number } {
  const builder = new ComponentBuilder();

  /* --- valuation band ---------------------------------------------------- */
  const valuation = permit.valuation;
  if (valuation === null || !Number.isFinite(valuation) || valuation <= 0) {
    builder.add(0, 'Project valuation not published; scale unread', SUB_MAX.valuationBand);
    warnings.push('Neither revised nor estimated cost is populated; project scale is unknown.');
  } else {
    const band =
      valuation >= 5_000_000 ? 10 : valuation >= 1_000_000 ? 7.5 : valuation >= 250_000 ? 5 : valuation >= 100_000 ? 3 : 1;
    builder.add(band, `Declared project valuation ${formatUsd(valuation)}`, SUB_MAX.valuationBand);
  }

  /* --- physical scale ---------------------------------------------------- */
  const stories = maxDefined(permit.existingStories, permit.proposedStories);
  const units = maxDefined(permit.existingUnits, permit.proposedUnits);
  const storyPoints = stories === null ? null : scaleBand(stories);
  const unitPoints = units === null ? null : scaleBand(units);
  const scale = maxDefined(storyPoints, unitPoints);

  if (scale === null) {
    builder.add(0.5, 'Neither story count nor unit count published; nominal credit', SUB_MAX.physicalScale);
  } else if (storyPoints !== null && (unitPoints === null || storyPoints >= unitPoints)) {
    builder.add(scale, `Building is ${stories ?? 0} stories`, SUB_MAX.physicalScale);
  } else {
    builder.add(scale, `Permit touches ${units ?? 0} units`, SUB_MAX.physicalScale);
  }

  /* --- scope breadth ----------------------------------------------------- */
  if (description.length === 0) {
    builder.add(0, 'No description to read scope breadth from', SUB_MAX.scopeBreadth);
  } else {
    const domains: string[] = [];
    for (const [domain, terms] of Object.entries(SCOPE_DOMAINS)) {
      if (matchedTerms(description, terms).length > 0) domains.push(domain);
    }
    const count = domains.length;
    const points = count >= 6 ? 5 : count >= 4 ? 3.5 : count >= 2 ? 2 : count === 1 ? 1 : 0;
    builder.add(
      points,
      count === 0
        ? 'Scope of work names no recognizable building trade'
        : `Scope spans ${count} trade ${count === 1 ? 'domain' : 'domains'}: ${domains.join(', ')}`,
      SUB_MAX.scopeBreadth,
    );
  }

  /* --- general contractor on the job ------------------------------------- */
  const gc = strongestFinding(findings, (f) => f.key.startsWith('gc.') && f.value !== null);
  if (gc === null) {
    builder.add(0, 'No general contractor identified on the permit', SUB_MAX.generalContractor);
    warnings.push('No general contractor Finding; the path in is unproven.');
  } else if (EVIDENCE_STRENGTH[gc.evidence] >= EVIDENCE_STRENGTH.corroborated) {
    builder.add(
      SUB_MAX.generalContractor,
      `General contractor on record (${String(gc.value)}), evidence ${gc.evidence}`,
      SUB_MAX.generalContractor,
    );
  } else {
    builder.add(
      2.5,
      `General contractor only ${gc.evidence} (${String(gc.value)})`,
      SUB_MAX.generalContractor,
    );
  }

  return { drivers: builder.drivers, subtotal: builder.subtotal() };
}

function scaleBand(count: number): number {
  if (count >= 20) return 6;
  if (count >= 6) return 4;
  if (count >= 2) return 2.5;
  if (count >= 1) return 1;
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Component: timing (20)                                                     */
/* -------------------------------------------------------------------------- */

/**
 * How recently did this permit move?
 *
 * The window that matters is the gap between a permit issuing and the general
 * contractor awarding the electrical subcontract. Full marks inside two weeks,
 * linear decay to a floor at six months, zero past a year. Status scales the
 * reading: a `complete` permit is a real record with a fresh date and nothing
 * left to sell.
 *
 * Missing dates land on a documented neutral floor rather than zero, because
 * "the agency did not publish `issued_date`" (18% of the extract) is not
 * evidence that the job is stale.
 */
function scoreTiming(
  permit: NormalizedPermit,
  nowMs: number | null,
  warnings: string[],
): { drivers: ScoreDriver[]; subtotal: number } {
  const builder = new ComponentBuilder();
  const floor = round2(SUB_MAX.timingCurve * TIMING_NO_DATE_FRACTION);

  if (nowMs === null) {
    builder.add(floor, 'Scoring clock unreadable; timing held at the neutral floor', SUB_MAX.timingCurve);
    warnings.push('The `now` timestamp could not be parsed; timing was not evaluated.');
    return { drivers: builder.drivers, subtotal: builder.subtotal() };
  }

  const moved = maxDefined(
    parseTimestamp(permit.statusDate),
    parseTimestamp(permit.issuedDate),
    parseTimestamp(permit.approvedDate),
    parseTimestamp(permit.lastPermitActivityDate),
    parseTimestamp(permit.filedDate),
  );

  if (moved === null) {
    builder.add(floor, 'Permit carries no usable date; timing held at the neutral floor', SUB_MAX.timingCurve);
    warnings.push('No filed, issued, or status date on the record; timing is unknown, not stale.');
    return { drivers: builder.drivers, subtotal: builder.subtotal() };
  }

  const rawDays = (nowMs - moved) / MS_PER_DAY;
  if (rawDays < 0) {
    warnings.push('Permit movement date is ahead of the scoring clock; treated as same-day.');
  }
  const days = Math.max(0, rawDays);
  const base = timingCurve(days);

  const status = lower(permit.status) ?? '';
  // A terminal status is a fatal flag, so it gets no timing discount here.
  // Discounting it too would push the disqualification into the score, which is
  // precisely the double-counting `fatalFlags` exists to prevent.
  const multiplier = TERMINAL_STATUSES.has(status)
    ? 1
    : (STATUS_TIMING_MULTIPLIER[status] ?? STATUS_TIMING_DEFAULT);
  const points = base * multiplier;

  const dayLabel = `${Math.round(days)} ${Math.round(days) === 1 ? 'day' : 'days'}`;
  const reason =
    multiplier === 1
      ? `Permit last moved ${dayLabel} ago with status "${status || 'unknown'}"`
      : `Permit last moved ${dayLabel} ago; status "${status || 'unknown'}" discounts timing to ${Math.round(multiplier * 100)}%`;

  builder.add(points, reason, SUB_MAX.timingCurve);
  if (status === 'complete') {
    warnings.push('Permit status is complete; most of the buying decisions are already made.');
  }
  return { drivers: builder.drivers, subtotal: builder.subtotal() };
}

/** Piecewise-linear decay. Continuous at every knot, so no cliff edges. */
function timingCurve(days: number): number {
  const max = SUB_MAX.timingCurve;
  if (days <= TIMING_FRESH_DAYS) return max;
  if (days <= TIMING_WARM_DAYS) {
    const span = TIMING_WARM_DAYS - TIMING_FRESH_DAYS;
    return max - (max - TIMING_WARM_FLOOR) * ((days - TIMING_FRESH_DAYS) / span);
  }
  if (days <= TIMING_COLD_DAYS) {
    const span = TIMING_COLD_DAYS - TIMING_WARM_DAYS;
    return TIMING_WARM_FLOOR * (1 - (days - TIMING_WARM_DAYS) / span);
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Component: value (15)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Is this big enough for THIS subscriber?
 *
 * Measured as a ratio to their stated floor, on a log scale with a second, much
 * flatter segment above 10x. Past ten times the floor the subscriber's answer
 * stops changing: a job at 40x their minimum is not four times as interesting as
 * one at 10x, it is slightly more interesting.
 */
function scoreValue(
  permit: NormalizedPermit,
  customer: CustomerProfile,
  warnings: string[],
): { drivers: ScoreDriver[]; subtotal: number } {
  const builder = new ComponentBuilder();
  const valuation = permit.valuation;

  if (valuation === null || !Number.isFinite(valuation) || valuation <= 0) {
    builder.add(0, 'Project valuation not published; value withheld', SUB_MAX.valuationRatio);
    return { drivers: builder.drivers, subtotal: builder.subtotal() };
  }

  const floor = customer.minProjectValue > 0 ? customer.minProjectValue : 1;
  const ratio = valuation / floor;

  if (ratio < 1) {
    builder.add(
      0,
      `Valuation ${formatUsd(valuation)} is under the ${formatUsd(floor)} floor`,
      SUB_MAX.valuationRatio,
    );
    return { drivers: builder.drivers, subtotal: builder.subtotal() };
  }

  const points =
    ratio < 10
      ? 3 + 9 * Math.log10(ratio)
      : 12 + 3 * Math.min(1, Math.log10(ratio / 10));

  builder.add(
    points,
    `Valuation ${formatUsd(valuation)} is ${formatMultiple(ratio)} the ${formatUsd(floor)} floor`,
    SUB_MAX.valuationRatio,
  );
  if (ratio >= 10) {
    warnings.push('Project is an order of magnitude above the subscriber floor; confirm capacity to bid.');
  }
  return { drivers: builder.drivers, subtotal: builder.subtotal() };
}

/* -------------------------------------------------------------------------- */
/* Component: evidence (10)                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How well backed is everything above?
 *
 * Two halves: the average strength of what we hold (`EVIDENCE_STRENGTH` from
 * core.ts) and how much of the picture is actually filled in. A candidate built
 * mostly from `unknown` Findings is not disqualified, it is discounted, and the
 * discount is a visible driver rather than an invisible haircut.
 */
function scoreEvidence(
  findings: readonly Finding[],
  warnings: string[],
): { drivers: ScoreDriver[]; subtotal: number } {
  const builder = new ComponentBuilder();

  if (findings.length === 0) {
    builder.add(0, 'No Findings recorded for this candidate', SUB_MAX.evidenceStrength);
    warnings.push('Candidate has no Findings; nothing above is corroborated.');
    return { drivers: builder.drivers, subtotal: builder.subtotal() };
  }

  let strengthSum = 0;
  let unknownCount = 0;
  let establishedCount = 0;
  for (const finding of findings) {
    strengthSum += EVIDENCE_STRENGTH[finding.evidence];
    if (finding.evidence === 'unknown') unknownCount += 1;
    if (finding.value !== null && finding.evidence !== 'unknown') establishedCount += 1;
  }

  const maxStrength = findings.length * EVIDENCE_STRENGTH.verified;
  const meanFraction = strengthSum / maxStrength;
  builder.add(
    SUB_MAX.evidenceStrength * meanFraction,
    `${findings.length} Findings at mean evidence strength ${round2(meanFraction * EVIDENCE_STRENGTH.verified)}/3`,
    SUB_MAX.evidenceStrength,
  );

  const coverageTarget = 6;
  builder.add(
    SUB_MAX.evidenceCoverage * Math.min(1, establishedCount / coverageTarget),
    `${establishedCount} of ${findings.length} Findings establish a concrete fact`,
    SUB_MAX.evidenceCoverage,
  );

  const unknownRatio = unknownCount / findings.length;
  if (unknownRatio >= 0.5) {
    builder.add(-2, `Half or more of the Findings are unknown (${unknownCount}/${findings.length})`, 2);
    warnings.push(`${unknownCount} of ${findings.length} Findings are unknown; the picture is thin.`);
  } else if (unknownRatio >= 0.34) {
    builder.add(-1, `A third of the Findings are unknown (${unknownCount}/${findings.length})`, 1);
  }

  return { drivers: builder.drivers, subtotal: builder.subtotal() };
}

/** Strongest-evidence Finding matching a predicate, or `null`. Ties keep the first. */
function strongestFinding(
  findings: readonly Finding[],
  predicate: (finding: Finding) => boolean,
): Finding | null {
  let best: Finding | null = null;
  for (const finding of findings) {
    if (!predicate(finding)) continue;
    if (best === null || EVIDENCE_STRENGTH[finding.evidence] > EVIDENCE_STRENGTH[best.evidence]) {
      best = finding;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Fatal flags                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Disqualifiers. Returned beside the score, never inside it.
 *
 * Territory is checked as a union: a permit satisfies the territory if it is in
 * the zip allowlist OR the district allowlist, whichever the subscriber
 * declared. If the permit publishes neither a zip nor a district, that is an
 * unknown, not a mismatch, and it raises a warning instead of a flag. Inventing
 * a disqualification out of an absent field would violate hard rule #3 in the
 * one direction people never check.
 */
function collectFatalFlags(
  permit: NormalizedPermit,
  customer: CustomerProfile,
  warnings: string[],
): FatalFlag[] {
  const flags: FatalFlag[] = [];
  const status = lower(permit.status) ?? '';

  if (TERMINAL_STATUSES.has(status)) {
    flags.push({
      code: 'status.terminal',
      message: `Permit status is "${status}"; the project is not going ahead on this record.`,
    });
  }

  const valuation = permit.valuation;
  if (valuation !== null && Number.isFinite(valuation) && valuation < customer.minProjectValue) {
    flags.push({
      code: 'valuation.below_floor',
      message: `Valuation ${formatUsd(valuation)} is below the ${formatUsd(customer.minProjectValue)} minimum ${customer.businessName} will chase.`,
    });
  }

  const zips = customer.territoryZips;
  const districts = customer.territoryDistricts;
  if (zips.length > 0 || districts.length > 0) {
    const permitZip = lower(permit.zipcode);
    const permitDistrict = lower(permit.supervisorDistrict);
    if (permitZip === null && permitDistrict === null) {
      warnings.push('Permit publishes no zip or supervisor district; territory could not be confirmed.');
    } else {
      const zipOk = zips.length > 0 && permitZip !== null && zips.some((z) => z.toLowerCase() === permitZip);
      const districtOk =
        districts.length > 0 &&
        permitDistrict !== null &&
        districts.some((d) => d.toLowerCase() === permitDistrict);
      if (!zipOk && !districtOk) {
        flags.push({
          code: 'territory.mismatch',
          message: `Job at zip ${permitZip ?? 'unknown'} / district ${permitDistrict ?? 'unknown'} is outside the subscriber's territory.`,
        });
      }
    }
  }

  return flags;
}

/* -------------------------------------------------------------------------- */
/* Formatting (pure, locale-independent)                                      */
/* -------------------------------------------------------------------------- */

/**
 * Fixed en-US currency formatting, written by hand rather than via
 * `Intl.NumberFormat`, so the driver text cannot vary with the host's ICU data.
 */
function formatUsd(amount: number): string {
  const rounded = Math.round(amount);
  const digits = Math.abs(rounded).toString();
  let grouped = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) grouped += ',';
    grouped += digits.charAt(i);
  }
  return `${rounded < 0 ? '-' : ''}$${grouped}`;
}

function formatMultiple(ratio: number): string {
  return `${round2(ratio) % 1 === 0 ? String(Math.round(ratio)) : round2(ratio).toFixed(2)}x`;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Score one permit for one subscriber.
 *
 * Pure. Deterministic. Never throws on incomplete data: every absent field has a
 * documented partial value and a warning. The returned `drivers` sum to the
 * returned `score` (within rounding), which is what makes the number auditable
 * on screen instead of merely displayed.
 *
 * `components` reports the same arithmetic grouped by component, for the readers
 * who need "fit 29 of 30" rather than nine signed rows. See
 * {@link LeadScoreComponents} for the two caveats on rendering it.
 *
 * @param input.permit    normalized permit record (see `normalizedPermitSchema`)
 * @param input.findings  every Finding stored against this candidate
 * @param input.customer  the subscriber, including Customer-Agent-tuned weights
 * @param input.now       ISO 8601 scoring clock, supplied by the caller
 */
export function scoreLead(input: ScoreLeadInput): LeadScoreResult {
  const { permit, findings, customer } = input;
  const warnings: string[] = [];
  // The subscriber's trade selects the vocabulary everything below reads.
  const profile = tradeProfile(customer.trade);
  const description = prepareDescription(permit.description, profile);
  const nowMs = parseTimestamp(input.now);

  const components: Readonly<Record<LeadScoreComponent, { drivers: ScoreDriver[]; subtotal: number }>> = {
    fit: scoreFit(permit, customer, description, profile, warnings),
    demand: scoreDemand(permit, findings, description, warnings),
    timing: scoreTiming(permit, nowMs, warnings),
    value: scoreValue(permit, customer, warnings),
    evidence: scoreEvidence(findings, warnings),
  };

  const weights = customer.effectiveWeights;
  const drivers: ScoreDriver[] = [];
  let total = 0;

  /**
   * The grouped view, filled in as each component is folded into `total`. It is
   * accumulated from exactly the deltas that are pushed onto `drivers`, so the
   * two views cannot report different arithmetic.
   */
  const contributions: LeadScoreComponents = { fit: 0, demand: 0, timing: 0, value: 0, evidence: 0 };

  const order: readonly LeadScoreComponent[] = ['fit', 'demand', 'timing', 'value', 'evidence'];
  for (const name of order) {
    const component = components[name];
    const max = LEAD_SCORE_COMPONENT_MAX[name];
    const subtotal = clamp(component.subtotal, 0, max);
    drivers.push(...component.drivers);
    // A component can only be clamped by the evidence penalty pushing it below
    // zero, but if it ever happens the correction is a visible driver, so
    // "drivers sum to the score" stays true without exception.
    if (subtotal !== component.subtotal) {
      drivers.push({
        delta: round2(subtotal - component.subtotal),
        reason: `${name} subtotal ${component.subtotal} clamped to the 0-${max} range`,
      });
    }
    total += subtotal;
    contributions[name] = subtotal;

    const declared = weights[name];
    const weight = clamp(typeof declared === 'number' && Number.isFinite(declared) ? declared : 1, WEIGHT_MIN, WEIGHT_MAX);
    if (weight !== declared) {
      warnings.push(`Customer weight for ${name} (${String(declared)}) was clamped to ${weight}.`);
    }
    if (weight !== 1) {
      const adjustment = round2(subtotal * (weight - 1));
      drivers.push({
        delta: adjustment,
        reason: `Subscriber feedback weights ${name} at ${weight}x (${subtotal} base)`,
      });
      total += adjustment;
      contributions[name] = round2(subtotal + adjustment);
    }
  }

  total = round2(total);
  const clamped = clamp(total, 0, 100);
  if (clamped !== total) {
    drivers.push({
      delta: round2(clamped - total),
      reason: `Weighted total ${total} clamped to the 0-100 scale`,
    });
  }

  const score = Math.round(clamped);
  const fatalFlags = collectFatalFlags(permit, customer, warnings);

  /* `contributions` deliberately does NOT absorb the 0-100 clamp above: that
   * correction belongs to the total, not to any one component, and inventing a
   * component to charge it to would misstate which part of the record moved. */
  return { score, drivers, warnings, fatalFlags, components: contributions };
}

/**
 * The delivery gate. Score alone is never sufficient: a fatal flag archives the
 * candidate no matter how high the number is.
 */
export function meetsDeliveryBar(result: ScoreResult): boolean {
  return result.fatalFlags.length === 0 && result.score >= LEAD_SCORE_THRESHOLD;
}
