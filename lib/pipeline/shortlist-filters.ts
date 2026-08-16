/**
 * Deterministic shortlist filters.
 *
 * Origin: gate/outcome structure adapted from SiteVelocity's deterministic
 * qualification layer (`lib/calculations/**`, https://github.com/samshanmukh/SiteVelocity).
 *
 * WHAT THIS IS
 * The first gate in the Lead Agent tick. Every permit record that arrives from
 * ingestion or replay is run through six deterministic predicates before any
 * interpretation step is allowed to look at it. Only records that clear all six
 * become candidates.
 *
 * WHY IT IS DETERMINISTIC
 * CLAUDE.md hard rule #2: filters, dedupe and thresholds are code, never model
 * output. A judge must be able to read a rejection reason and reproduce it by
 * hand from the permit record. That is why every gate returns a `FilterOutcome`
 * carrying a sentence good enough to render straight into the decision log
 * (hard rule #6) rather than a bare boolean.
 *
 * PURITY CONTRACT
 * This module is pure: no network, no filesystem, no `Date.now()`, no random.
 * "Now" is an explicit parameter. Date strings are parsed as UTC when they carry
 * no timezone designator (Socrata emits `2026-03-23T14:30:55.000`), so results
 * do not change with the machine timezone.
 *
 * WHAT IT DOES NOT DO
 * It does not decide whether the scope of work suits the subscriber's trade.
 * That is interpretation and it happens after this gate. It also does not hold
 * the dedupe set: it emits stable keys and the caller owns the set, so the same
 * permit observed on two ticks cannot produce two candidates.
 */
import { z } from 'zod';

import type { NormalizedPermit } from '@/lib/domain/permit-normalizer';
import type { CustomerProfile } from '@/lib/domain/schemas/core';

/* -------------------------------------------------------------------------- */
/* Gate vocabulary                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The six deterministic gates, in evaluation order. Names are stable strings
 * because they are written into `events.refs` and rendered in the decision log.
 */
export const SHORTLIST_GATES = [
  'geography',
  'status',
  'project_type',
  'commercial_use',
  'cost_floor',
  'dedupe',
] as const;

export type ShortlistGate = (typeof SHORTLIST_GATES)[number];

export const shortlistGateSchema = z.enum(SHORTLIST_GATES);

/**
 * Result of one gate. `reason` is always populated, on pass as well as on
 * reject, so the decision log can show the full gate sheet for a permit rather
 * than only the thing that killed it.
 */
export interface FilterOutcome {
  passed: boolean;
  gate: ShortlistGate;
  reason: string;
}

export const filterOutcomeSchema = z.object({
  passed: z.boolean(),
  gate: shortlistGateSchema,
  reason: z.string().min(1),
});

/* -------------------------------------------------------------------------- */
/* Input shape                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The slice of a normalized permit these filters read.
 *
 * `NormalizedPermit` from `@/lib/domain/permit-normalizer` is a superset of this
 * and is structurally assignable to it, which keeps this module testable in
 * isolation and keeps the normalizer free to grow fields. Field names are the
 * camelCase form of the live-inspected DataSF columns on dataset `i98e-djp9`
 * (CLAUDE.md hard rule #8: names are copied from the inspected schema, never
 * guessed).
 *
 * Costs are numbers here because coercion is the normalizer's job: every Socrata
 * value arrives as a string, including `estimated_cost` and `revised_cost`.
 * `valuation` is accepted pre-computed but re-derived when absent so this module
 * is correct on its own.
 */
export interface ShortlistPermit {
  /** DataSF `permit_number`. Primary key and contacts join key. */
  permitNumber: string;
  /** DataSF `permit_type_definition`, e.g. "otc alterations permit". */
  permitTypeDefinition?: string | null;
  /** DataSF `status`, e.g. "issued". */
  status?: string | null;
  /** DataSF `filed_date`. */
  filedDate?: string | null;
  /** DataSF `description`: the scope text. */
  description?: string | null;
  /** Composed street address, when the normalizer already assembled one. */
  address?: string | null;
  streetNumber?: string | null;
  streetNumberSuffix?: string | null;
  streetName?: string | null;
  streetSuffix?: string | null;
  unit?: string | null;
  /** DataSF `zipcode`. */
  zipcode?: string | null;
  /** DataSF `supervisor_district`, e.g. "3". */
  supervisorDistrict?: string | null;
  /** DataSF `neighborhoods_analysis_boundaries`. */
  neighborhood?: string | null;
  /** DataSF `existing_use` / `proposed_use`. */
  existingUse?: string | null;
  proposedUse?: string | null;
  /** Coerced DataSF `estimated_cost` / `revised_cost`. */
  estimatedCost?: number | null;
  revisedCost?: number | null;
  /** max(revisedCost, estimatedCost). Re-derived when absent. */
  valuation?: number | null;
}

/** Boundary schema for callers that hand-build an input instead of normalizing. */
export const shortlistPermitSchema = z
  .object({
    permitNumber: z.string().min(1),
    permitTypeDefinition: z.string().nullish(),
    status: z.string().nullish(),
    filedDate: z.string().nullish(),
    description: z.string().nullish(),
    address: z.string().nullish(),
    streetNumber: z.string().nullish(),
    streetNumberSuffix: z.string().nullish(),
    streetName: z.string().nullish(),
    streetSuffix: z.string().nullish(),
    unit: z.string().nullish(),
    zipcode: z.string().nullish(),
    supervisorDistrict: z.string().nullish(),
    neighborhood: z.string().nullish(),
    existingUse: z.string().nullish(),
    proposedUse: z.string().nullish(),
    estimatedCost: z.number().nullish(),
    revisedCost: z.number().nullish(),
    valuation: z.number().nullish(),
  })
  .passthrough();

/**
 * Compile-time guarantee that the normalizer's output can be fed straight into
 * these filters. If `NormalizedPermit` ever drops or renames a field this module
 * reads, the build breaks here rather than at runtime in a worker tick.
 */
type AssertAssignable<Actual extends Expected, Expected> = Actual;
export type ShortlistablePermit = AssertAssignable<NormalizedPermit, ShortlistPermit>;

/* -------------------------------------------------------------------------- */
/* Controlled vocabularies (measured on the committed real extract)           */
/* -------------------------------------------------------------------------- */

/**
 * Statuses that mean the project is still live and worth a contractor's time.
 * Everything else is terminal: the work is finished, abandoned, or blocked.
 */
export const ACTIVE_PIPELINE_STATUSES: ReadonlySet<string> = new Set([
  'issued',
  'approved',
  'filed',
  'reinstated',
]);

/**
 * Terminal statuses observed in the extract. Kept explicit so a rejection can
 * say what the status actually means rather than only naming it.
 */
export const TERMINAL_STATUS_REASONS: Readonly<Record<string, string>> = Object.freeze({
  complete: 'the work is already finished',
  cancelled: 'the application was cancelled',
  withdrawn: 'the application was withdrawn',
  expired: 'the permit has expired',
  denied: 'the application was denied',
  suspend: 'the permit is suspended',
});

/**
 * Permit types that never carry commercial electrical scope worth chasing.
 * Values are the exact `permit_type_definition` strings observed on the extract.
 */
export const EXCLUDED_PERMIT_TYPES: ReadonlySet<string> = new Set([
  'demolitions',
  'demolition',
  'sign - erect',
  'wall or painted sign',
  'grade or quarry or fill or excavate',
]);

/**
 * Commercial `existing_use` / `proposed_use` values observed on the extract.
 * A hit here is a positive commercial classification.
 */
export const COMMERCIAL_USES: ReadonlySet<string> = new Set([
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

/** Residential uses. Out of scope for this subscriber, rejected explicitly. */
export const RESIDENTIAL_USES: ReadonlySet<string> = new Set([
  '1 family dwelling',
  '2 family dwelling',
  'apartments',
  'residential hotel',
  'misc group residns.',
  'artist live/work',
]);

/**
 * Width of the near-duplicate collapse window, in days. DBI re-filings of the
 * same scope at the same address land within a few weeks of each other on the
 * extract; 45 days covers the observed spread without merging genuinely separate
 * projects at long-lived addresses.
 */
export const NEAR_DUPLICATE_WINDOW_DAYS = 45;

const MS_PER_DAY = 86_400_000;

/* -------------------------------------------------------------------------- */
/* Pure helpers                                                               */
/* -------------------------------------------------------------------------- */

/** Lowercase, trim, collapse internal whitespace, normalize dash variants. */
function normalizeText(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[‐-―]/g, '-')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Finite number or `null`. Never coerces `null`/`''`/`NaN` into `0`. */
function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number.parseFloat(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Project valuation: max(revisedCost, estimatedCost).
 *
 * `revised_cost` is populated on 96.0% of the extract and `estimated_cost` on
 * 99.1%, and `revised_cost` is sometimes "0.0" on a freshly filed permit, so
 * neither field alone is trustworthy. Returns `null` when neither is a usable
 * number; the caller must not read `null` as zero, and must not read zero as
 * "cheap" (it means the applicant did not publish a figure).
 */
export function permitValuation(permit: ShortlistPermit): number | null {
  const direct = coerceNumber(permit.valuation);
  if (direct !== null) return direct;
  const revised = coerceNumber(permit.revisedCost);
  const estimated = coerceNumber(permit.estimatedCost);
  if (revised === null && estimated === null) return null;
  return Math.max(revised ?? 0, estimated ?? 0);
}

/**
 * Epoch milliseconds for a permit date string, or `null`.
 *
 * Socrata floating timestamps carry no timezone designator. Reading them as
 * local time would make this module's output depend on the host clock's zone,
 * which would break the purity contract, so a bare timestamp is read as UTC.
 */
export function parsePermitDate(value: string | null | undefined): number | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(trimmed);
  const hasTime = trimmed.includes('T');
  const candidate = hasZone ? trimmed : `${trimmed}${hasTime ? 'Z' : 'T00:00:00Z'}`;
  const ms = Date.parse(candidate);
  return Number.isFinite(ms) ? ms : null;
}

/** Whole days between the permit filing and `now`. Negative if future dated. */
export function filedDaysAgo(permit: ShortlistPermit, now: Date): number | null {
  const filed = parsePermitDate(permit.filedDate);
  if (filed === null) return null;
  return Math.floor((now.getTime() - filed) / MS_PER_DAY);
}

/** `$8,285,917`. Hand-rolled so output cannot drift with the host locale. */
export function formatUsd(amount: number): string {
  const rounded = Math.round(amount);
  const sign = rounded < 0 ? '-' : '';
  const digits = Math.abs(rounded).toString();
  return `${sign}$${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}

/** FNV-1a 32-bit, hex. Used only to keep dedupe keys short and stable. */
function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Best available street address for a permit, normalized. */
export function permitAddress(permit: ShortlistPermit): string {
  const composed = normalizeText(permit.address);
  if (composed.length > 0) return composed;
  const parts = [
    permit.streetNumber,
    permit.streetNumberSuffix,
    permit.streetName,
    permit.streetSuffix,
  ]
    .map((part) => normalizeText(part))
    .filter((part) => part.length > 0);
  return parts.join(' ');
}

/** First five digits of a US zip, or `''`. Handles "94104-1234". */
function normalizeZip(value: string | null | undefined): string {
  const digits = normalizeText(value).replace(/\D/g, '');
  return digits.length >= 5 ? digits.slice(0, 5) : '';
}

/**
 * Territory district tokens are matched loosely because a profile may hold
 * either a supervisor district ("3", "District 3") or a neighborhood name
 * ("Financial District/South Beach").
 */
function normalizeDistrictToken(value: string | null | undefined): string {
  const text = normalizeText(value).replace(/^(?:supervisor\s+)?district\s+/, '');
  return /^\d+$/.test(text) ? String(Number.parseInt(text, 10)) : text;
}

/* -------------------------------------------------------------------------- */
/* Gate 1: geography                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Territory gate.
 *
 * An empty territory on the profile means "all of San Francisco" rather than
 * "nothing": the subscriber persona states a citywide territory and encoding
 * that as an empty allowlist must not silently starve the pipeline.
 *
 * When the profile does constrain territory and the permit publishes no zip,
 * district or neighborhood, the record is rejected. Territory is a hard
 * customer constraint, so an unestablished location is not the same as a pass.
 */
export function geographyGate(permit: ShortlistPermit, customer: CustomerProfile): FilterOutcome {
  const zips = customer.territoryZips.map(normalizeZip).filter((zip) => zip.length > 0);
  const districts = customer.territoryDistricts
    .map(normalizeDistrictToken)
    .filter((token) => token.length > 0);

  if (zips.length === 0 && districts.length === 0) {
    return {
      passed: true,
      gate: 'geography',
      reason: 'Territory is unrestricted for this subscriber, so all of San Francisco qualifies.',
    };
  }

  const permitZip = normalizeZip(permit.zipcode);
  const permitDistrict = normalizeDistrictToken(permit.supervisorDistrict);
  const permitNeighborhoodName = normalizeText(permit.neighborhood);

  if (permitZip.length > 0 && zips.includes(permitZip)) {
    return {
      passed: true,
      gate: 'geography',
      reason: `Zip ${permitZip} is inside the subscriber territory.`,
    };
  }

  if (permitDistrict.length > 0 && districts.includes(permitDistrict)) {
    return {
      passed: true,
      gate: 'geography',
      reason: `Supervisor district ${permitDistrict} is inside the subscriber territory.`,
    };
  }

  if (permitNeighborhoodName.length > 0 && districts.includes(permitNeighborhoodName)) {
    return {
      passed: true,
      gate: 'geography',
      reason: `Neighborhood ${permitNeighborhoodName} is inside the subscriber territory.`,
    };
  }

  const located = [
    permitZip.length > 0 ? `zip ${permitZip}` : null,
    permitDistrict.length > 0 ? `district ${permitDistrict}` : null,
    permitNeighborhoodName.length > 0 ? permitNeighborhoodName : null,
  ].filter((part): part is string => part !== null);

  if (located.length === 0) {
    return {
      passed: false,
      gate: 'geography',
      reason:
        'Location not published on the permit, so it cannot be confirmed inside the subscriber territory.',
    };
  }

  return {
    passed: false,
    gate: 'geography',
    reason: `Site at ${located.join(', ')} is outside the subscriber territory.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Gate 2: status                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Active-pipeline gate.
 *
 * Only issued, approved, filed and reinstated permits describe work that has
 * not happened yet. `now` is used for the filing age carried in the reason: the
 * decision log is more useful when it says how stale a live permit is.
 */
export function statusGate(permit: ShortlistPermit, now: Date): FilterOutcome {
  const status = normalizeText(permit.status);
  const age = filedDaysAgo(permit, now);
  const ageNote =
    age === null
      ? 'filing date not published'
      : age < 0
        ? `filed ${Math.abs(age)} days ahead of the current clock`
        : `filed ${age} days ago`;

  if (status.length === 0) {
    return {
      passed: false,
      gate: 'status',
      reason: 'Permit status not published, so an active project cannot be confirmed.',
    };
  }

  if (ACTIVE_PIPELINE_STATUSES.has(status)) {
    return {
      passed: true,
      gate: 'status',
      reason: `Status ${status} is an active pipeline status, ${ageNote}.`,
    };
  }

  const explanation = TERMINAL_STATUS_REASONS[status];
  return {
    passed: false,
    gate: 'status',
    reason:
      explanation === undefined
        ? `Status ${status} is not an active pipeline status.`
        : `Status ${status}: ${explanation}.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Gate 3: project type                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Project type gate.
 *
 * Demolitions, sign erection and grading permits are removals, signage and
 * earthworks. None of them carry the build-out scope this subscriber sells.
 *
 * A permit with no published type is not rejected here. 198 records on the
 * extract omit `permit_type_definition`, and an absent field is an unknown, not
 * a disqualifier (CLAUDE.md hard rule #3).
 */
export function projectTypeGate(permit: ShortlistPermit): FilterOutcome {
  const definition = normalizeText(permit.permitTypeDefinition);

  if (definition.length === 0) {
    return {
      passed: true,
      gate: 'project_type',
      reason: 'Permit type not published, so the project type stays unknown and is scored later.',
    };
  }

  if (
    EXCLUDED_PERMIT_TYPES.has(definition) ||
    /\bdemolitions?\b/.test(definition) ||
    /\bsign\b/.test(definition) ||
    /\b(?:grade|quarry|excavate)\b/.test(definition)
  ) {
    return {
      passed: false,
      gate: 'project_type',
      reason: `Permit type "${definition}" carries no build-out scope.`,
    };
  }

  return {
    passed: true,
    gate: 'project_type',
    reason: `Permit type "${definition}" can carry build-out scope.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Gate 4: commercial use                                                     */
/* -------------------------------------------------------------------------- */

export type UseClassification = 'commercial' | 'residential' | 'unclassified' | 'unknown';

/**
 * Classify a permit by its existing and proposed use.
 *
 * A commercial hit on either side wins, because a conversion into or out of a
 * commercial use is still commercial work. `unclassified` covers real values
 * that are in neither controlled list (the extract holds "hospital", "museum",
 * "wholesale sales" and about forty more); `unknown` covers an absent value.
 */
export function classifyUse(permit: ShortlistPermit): {
  classification: UseClassification;
  existingUse: string;
  proposedUse: string;
} {
  const existingUse = normalizeText(permit.existingUse);
  const proposedUse = normalizeText(permit.proposedUse);

  if (COMMERCIAL_USES.has(existingUse) || COMMERCIAL_USES.has(proposedUse)) {
    return { classification: 'commercial', existingUse, proposedUse };
  }
  if (RESIDENTIAL_USES.has(existingUse) || RESIDENTIAL_USES.has(proposedUse)) {
    return { classification: 'residential', existingUse, proposedUse };
  }
  if (existingUse.length === 0 && proposedUse.length === 0) {
    return { classification: 'unknown', existingUse, proposedUse };
  }
  return { classification: 'unclassified', existingUse, proposedUse };
}

/**
 * Commercial use gate.
 *
 * Residential is the explicit reject list. An unknown or unrecognized use is
 * NOT rejected: it passes with the uncertainty named in the reason so scoring
 * can mark it down on evidence rather than the record disappearing silently
 * (CLAUDE.md hard rule #3, unknowns stay visible).
 */
export function commercialUseGate(permit: ShortlistPermit): FilterOutcome {
  const { classification, existingUse, proposedUse } = classifyUse(permit);
  const both =
    existingUse === proposedUse || proposedUse.length === 0
      ? existingUse
      : `${existingUse} to ${proposedUse}`;

  switch (classification) {
    case 'commercial':
      return {
        passed: true,
        gate: 'commercial_use',
        reason: `Building use "${both}" is commercial.`,
      };
    case 'residential':
      return {
        passed: false,
        gate: 'commercial_use',
        reason: `Building use "${both}" is residential and out of scope for this subscriber.`,
      };
    case 'unclassified':
      return {
        passed: true,
        gate: 'commercial_use',
        reason: `Building use "${both}" is not in the known commercial list, so the use stays unconfirmed and is scored on evidence.`,
      };
    default:
      return {
        passed: true,
        gate: 'commercial_use',
        reason: 'Building use not published, so the use stays unknown and is scored on evidence.',
      };
  }
}

/* -------------------------------------------------------------------------- */
/* Gate 5: cost floor                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Minimum project value gate.
 *
 * A missing or zero valuation is rejected, not waved through. On the extract a
 * freshly filed permit often carries `revised_cost` of "0.0" with no
 * `estimated_cost`, which means the applicant has not published a figure. That
 * is a real reason to hold the record back rather than an implicit pass.
 */
export function costFloorGate(permit: ShortlistPermit, customer: CustomerProfile): FilterOutcome {
  const valuation = permitValuation(permit);
  const floor = customer.minProjectValue;

  if (valuation === null || valuation <= 0) {
    return {
      passed: false,
      gate: 'cost_floor',
      reason: `Valuation not published on the permit, so the ${formatUsd(floor)} minimum project value cannot be met.`,
    };
  }

  if (valuation < floor) {
    return {
      passed: false,
      gate: 'cost_floor',
      reason: `Valuation ${formatUsd(valuation)} is below the ${formatUsd(floor)} minimum project value.`,
    };
  }

  return {
    passed: true,
    gate: 'cost_floor',
    reason: `Valuation ${formatUsd(valuation)} clears the ${formatUsd(floor)} minimum project value.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Gate 6: dedupe                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Primary dedupe key. One permit number can only ever produce one candidate,
 * which matters because the committed extract itself contains 726 permit
 * numbers more than once and replay re-releases records across ticks.
 */
export function permitDedupeKey(permit: ShortlistPermit): string {
  return `permit:${permit.permitNumber.trim()}`;
}

/**
 * Site fingerprint: address plus unit plus scope description, hashed.
 *
 * Two DBI filings that describe the same work at the same address are the same
 * job even though they carry different permit numbers. The description is
 * stripped of punctuation and collapsed before hashing so trivial re-typing does
 * not defeat the match.
 */
export function permitSiteKey(permit: ShortlistPermit): string {
  const address = permitAddress(permit);
  const unit = normalizeText(permit.unit);
  const description = normalizeText(permit.description)
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Without both an address and a scope description there is nothing to compare,
  // and hashing two empty strings would collapse every such permit into one
  // candidate. Fall back to a key that can only ever match this permit.
  if (address.length === 0 || description.length === 0) {
    return `np-${fnv1a32(permit.permitNumber.trim())}`;
  }
  return fnv1a32(`${address}|${unit}|${description}`);
}

/**
 * Near-duplicate keys for a permit, the one to register first.
 *
 * The window bucket is anchored to the Unix epoch, not to `now`, so the key for
 * a given permit never changes between ticks and the caller's set stays valid
 * across a whole run.
 *
 * A re-filing can land just across a bucket boundary, so the neighbouring
 * buckets come back alongside the current one. The protocol is: REGISTER
 * `keys[0]`, CHECK all of them. Because both neighbours are checked, the
 * collapse is order independent, which matters when replay releases records out
 * of filing order.
 */
export function nearDuplicateKeys(
  permit: ShortlistPermit,
  windowDays: number = NEAR_DUPLICATE_WINDOW_DAYS,
): readonly string[] {
  const site = permitSiteKey(permit);
  const filed = parsePermitDate(permit.filedDate);
  if (filed === null) return [`site:${site}:w-na`];
  const bucket = Math.floor(Math.floor(filed / MS_PER_DAY) / windowDays);
  return [`site:${site}:w${bucket}`, `site:${site}:w${bucket - 1}`, `site:${site}:w${bucket + 1}`];
}

/** The key a caller should add to its seen set once a candidate is accepted. */
export function nearDuplicateKey(
  permit: ShortlistPermit,
  windowDays: number = NEAR_DUPLICATE_WINDOW_DAYS,
): string {
  const keys = nearDuplicateKeys(permit, windowDays);
  return keys[0] ?? `site:${permitSiteKey(permit)}:w-na`;
}

/**
 * Dedupe gate.
 *
 * The caller owns the seen set, so this gate is a lookup and never a mutation.
 * With no set supplied the gate passes and simply reports the keys it minted,
 * which is what the unit tests and single-record inspection paths want.
 */
export function dedupeGate(
  permit: ShortlistPermit,
  seenKeys?: ReadonlySet<string>,
  windowDays: number = NEAR_DUPLICATE_WINDOW_DAYS,
): FilterOutcome {
  const primary = permitDedupeKey(permit);
  const near = nearDuplicateKeys(permit, windowDays);

  if (seenKeys === undefined) {
    return {
      passed: true,
      gate: 'dedupe',
      reason: `First sighting of ${primary} in this pass.`,
    };
  }

  if (seenKeys.has(primary)) {
    return {
      passed: false,
      gate: 'dedupe',
      reason: `Permit ${permit.permitNumber.trim()} has already produced a candidate.`,
    };
  }

  const collision = near.find((key) => seenKeys.has(key));
  if (collision !== undefined) {
    return {
      passed: false,
      gate: 'dedupe',
      reason: `Duplicate re-filing of the same scope at ${permitAddress(permit) || 'the same address'} within ${windowDays} days of an existing candidate.`,
    };
  }

  return {
    passed: true,
    gate: 'dedupe',
    reason: `First sighting of ${primary} in this pass.`,
  };
}

/* -------------------------------------------------------------------------- */
/* Orchestration                                                              */
/* -------------------------------------------------------------------------- */

export interface ShortlistFilterOptions {
  /**
   * Keys already claimed by accepted candidates in this pass. The caller owns
   * this set: register `dedupeKey` and `nearDuplicateKey` from the result of
   * every accepted candidate.
   */
  seenKeys?: ReadonlySet<string>;
  /** Override the near-duplicate collapse window. */
  nearDuplicateWindowDays?: number;
}

export interface ShortlistResult {
  /** True only when all six gates passed. */
  passed: boolean;
  /** Every gate, in order, pass or fail. This is the decision-log gate sheet. */
  outcomes: FilterOutcome[];
  /** Register this on acceptance so the permit cannot yield a second candidate. */
  dedupeKey: string;
  /** Register this too, to collapse re-filings of the same scope. */
  nearDuplicateKey: string;
  /** All near-duplicate keys worth checking, current window bucket first. */
  nearDuplicateKeys: readonly string[];
  /** First failing gate, or `null` when the permit cleared everything. */
  rejectedBy: ShortlistGate | null;
  /** max(revisedCost, estimatedCost), or `null` when unpublished. */
  valuation: number | null;
  /** Whole days between filing and `now`, or `null` when the date is absent. */
  filedDaysAgo: number | null;
}

export const shortlistResultSchema = z.object({
  passed: z.boolean(),
  outcomes: z.array(filterOutcomeSchema),
  dedupeKey: z.string().min(1),
  nearDuplicateKey: z.string().min(1),
  nearDuplicateKeys: z.array(z.string().min(1)),
  rejectedBy: shortlistGateSchema.nullable(),
  valuation: z.number().nullable(),
  filedDaysAgo: z.number().nullable(),
});

/**
 * Run every deterministic shortlist gate against one permit for one subscriber.
 *
 * All six gates always run, even after one fails, so the decision log can show
 * the complete gate sheet instead of only the first objection. `now` is explicit
 * because this module is pure and must produce identical output for identical
 * inputs on any machine at any time.
 */
export function runShortlistFilters(
  permit: ShortlistPermit,
  customer: CustomerProfile,
  now: Date,
  options: ShortlistFilterOptions = {},
): ShortlistResult {
  const windowDays = options.nearDuplicateWindowDays ?? NEAR_DUPLICATE_WINDOW_DAYS;

  const outcomes: FilterOutcome[] = [
    geographyGate(permit, customer),
    statusGate(permit, now),
    projectTypeGate(permit),
    commercialUseGate(permit),
    costFloorGate(permit, customer),
    dedupeGate(permit, options.seenKeys, windowDays),
  ];

  const failed = outcomes.find((outcome) => !outcome.passed);
  const keys = nearDuplicateKeys(permit, windowDays);

  return {
    passed: failed === undefined,
    outcomes,
    dedupeKey: permitDedupeKey(permit),
    nearDuplicateKey: keys[0] ?? `site:${permitSiteKey(permit)}:w-na`,
    nearDuplicateKeys: keys,
    rejectedBy: failed?.gate ?? null,
    valuation: permitValuation(permit),
    filedDaysAgo: filedDaysAgo(permit, now),
  };
}

/**
 * One-line rejection summary for the decision log.
 *
 * Judge-facing copy: no em dashes, no technology talk, just the gate and why.
 */
export function summarizeShortlistResult(
  permit: ShortlistPermit,
  result: ShortlistResult,
): string {
  const failed = result.outcomes.find((outcome) => !outcome.passed);
  if (failed === undefined) {
    return `Permit ${permit.permitNumber} cleared all ${result.outcomes.length} shortlist gates.`;
  }
  return `Permit ${permit.permitNumber} rejected at the ${failed.gate} gate: ${failed.reason}`;
}
