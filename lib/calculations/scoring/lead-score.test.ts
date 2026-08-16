/**
 * Unit tests for the deterministic lead score.
 *
 * Origin: test shape adapted from SiteVelocity `lib/calculations/scoring/alpha-scores.ts`
 * and its spec (https://github.com/samshanmukh/SiteVelocity).
 *
 * EVERY permit in this file is a real San Francisco record, read out of the
 * committed extract in `/data` (DataSF Socrata `i98e-djp9`), and every Finding is
 * derived from the real contacts extract (`3pee-9qhc`) joined on `permit_number`.
 * Nothing here is a fixture someone typed to make a number come out right, which
 * is the point: CLAUDE.md hard rule #5 bans mock data from the demo path, and a
 * scorer proven only against invented inputs is not proven at all.
 *
 * The one thing this file does invent is the timezone-free translation from raw
 * Socrata strings to `NormalizedPermit`. That belongs to
 * `lib/domain/permit-normalizer.ts`, which is owned elsewhere; the local
 * `normalize()` below is a deliberate stand-in that also documents the exact
 * contract the scorer expects from it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CALCULATIONS,
  getCalculation,
  isCalculationId,
  listCalculations,
} from '@/lib/calculations/registry';
import {
  LEAD_SCORE_COMPONENT_MAX,
  LEAD_SCORE_THRESHOLD,
  meetsDeliveryBar,
  normalizedPermitSchema,
  scoreLead,
  type NormalizedPermit,
  type ScoreLeadInput,
} from '@/lib/calculations/scoring/lead-score';
import {
  customerProfileSchema,
  findingSchema,
  type CustomerProfile,
  type EvidenceLabel,
  type Finding,
  type ScoreResult,
} from '@/lib/domain/schemas/core';

/* -------------------------------------------------------------------------- */
/* Real extract                                                               */
/* -------------------------------------------------------------------------- */

type RawRow = Readonly<Record<string, unknown>>;

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function loadRows(relativePath: string): readonly RawRow[] {
  const parsed: unknown = JSON.parse(readFileSync(`${REPO_ROOT}${relativePath}`, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`${relativePath} is not an array of records`);
  return parsed as readonly RawRow[];
}

const PERMIT_ROWS = loadRows('data/permits.json');
const CONTACT_ROWS = loadRows('data/contacts.json');

/** Real permit numbers used below, each verified present in the extract. */
const HERO = '202603238106'; // 555 California St, $8.29M office TI, lighting + power scope
const WEAK = '202605010480'; // 2200 block office reroof, $226k, complete, no trade scope
const CANCELLED = '202602186095'; // school reroof, $1.53M, status cancelled
const UNDER_FLOOR = '202602266558'; // office phone-booth power work, $20k, issued
const NEGATED = '202602196188'; // "install non-electric single faced wall sign"
const MULTI_OCCUPANCY = '202602175990'; // 9th fl office TI, occupancy "B,M,S-2", names lighting

/* -------------------------------------------------------------------------- */
/* Local stand-in for lib/domain/permit-normalizer.ts                         */
/* -------------------------------------------------------------------------- */

function str(row: RawRow, key: string): string | null {
  const value = row[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Socrata ships every value as a string, including money and counts. */
function num(row: RawRow, key: string): number | null {
  const raw = str(row, key);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalize(row: RawRow): NormalizedPermit {
  const estimated = num(row, 'estimated_cost');
  const revised = num(row, 'revised_cost');
  // Data reality: revised_cost is sometimes "0.0" on a freshly filed permit, so
  // valuation is the max of the two rather than a preference order.
  const costs = [estimated, revised].filter((c): c is number => c !== null);
  const valuation = costs.length > 0 ? Math.max(...costs) : null;

  return normalizedPermitSchema.parse({
    permitNumber: str(row, 'permit_number') ?? '',
    status: (str(row, 'status') ?? '').toLowerCase(),
    description: str(row, 'description'),
    permitTypeDefinition: str(row, 'permit_type_definition'),
    existingUse: str(row, 'existing_use'),
    proposedUse: str(row, 'proposed_use'),
    existingOccupancy: str(row, 'existing_occupancy'),
    proposedOccupancy: str(row, 'proposed_occupancy'),
    valuation,
    estimatedCost: estimated,
    revisedCost: revised,
    existingStories: num(row, 'number_of_existing_stories'),
    proposedStories: num(row, 'number_of_proposed_stories'),
    existingUnits: num(row, 'existing_units'),
    proposedUnits: num(row, 'proposed_units'),
    zipcode: str(row, 'zipcode'),
    supervisorDistrict: str(row, 'supervisor_district'),
    neighborhood: str(row, 'neighborhoods_analysis_boundaries'),
    recordId: str(row, 'record_id'),
    address: [str(row, 'street_number'), str(row, 'street_name'), str(row, 'street_suffix')]
      .filter((part): part is string => part !== null)
      .join(' '),
    filedDate: str(row, 'filed_date'),
    issuedDate: str(row, 'issued_date'),
    approvedDate: str(row, 'approved_date'),
    statusDate: str(row, 'status_date'),
    completedDate: str(row, 'completed_date'),
    lastPermitActivityDate: str(row, 'last_permit_activity_date'),
  });
}

function permitFor(permitNumber: string): NormalizedPermit {
  const row = PERMIT_ROWS.find((candidate) => str(candidate, 'permit_number') === permitNumber);
  if (row === undefined) throw new Error(`Permit ${permitNumber} is not in data/permits.json`);
  return normalize(row);
}

/* -------------------------------------------------------------------------- */
/* Findings built from the real contacts join                                 */
/* -------------------------------------------------------------------------- */

const SOURCE_PERMITS = 'datasf.building_permits';
const SOURCE_CONTACTS = 'datasf.permit_contacts';

function finding(
  candidateId: string,
  key: string,
  label: string,
  value: string | number | boolean | null,
  evidence: EvidenceLabel,
  sourceId: string | null,
  note: string,
  observedAt: string,
): Finding {
  return findingSchema.parse({ candidateId, key, label, value, evidence, sourceId, note, observedAt });
}

/** `data_as_of` on the real rows has no offset; pin it to UTC for the schema. */
function observedAt(row: RawRow): string {
  const raw = str(row, 'data_as_of');
  return raw === null ? '2026-08-01T00:00:00Z' : `${raw}Z`;
}

/**
 * The Finding set the Lead Agent's enrichment step would hold for a candidate:
 * the permit facts it can read directly (verified), the contact rows joined on
 * `permit_number` (verified), and the things DataSF simply does not publish,
 * which stay `unknown` with a null value rather than being guessed.
 */
function findingsFor(permitNumber: string, permit: NormalizedPermit): Finding[] {
  const rows = CONTACT_ROWS.filter((row) => str(row, 'permit_number') === permitNumber);
  const out: Finding[] = [];
  const seen = new Set<string>();

  const push = (
    key: string,
    label: string,
    value: string | number | boolean | null,
    evidence: EvidenceLabel,
    sourceId: string | null,
    note: string,
    ts: string,
  ): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(finding(permitNumber, key, label, value, evidence, sourceId, note, ts));
  };

  for (const row of rows) {
    const role = (str(row, 'role') ?? '').toLowerCase();
    const ts = observedAt(row);
    const firm = str(row, 'firm_name');
    const license = str(row, 'license1');
    const city = str(row, 'firm_city') ?? str(row, 'city');
    const businessLicense = str(row, 'sf_business_license_number');

    if (role === 'contractor') {
      if (firm !== null) {
        push('gc.firm_name', 'General contractor', firm, 'verified', SOURCE_CONTACTS, `Listed as contractor on permit ${permitNumber}.`, ts);
      }
      if (license !== null) {
        push('gc.license_number', 'Contractor license', license, 'verified', SOURCE_CONTACTS, 'License number as filed with DBI.', ts);
      }
      if (city !== null) {
        push('gc.city', 'Contractor city', city, 'verified', SOURCE_CONTACTS, 'Firm city as filed.', ts);
      }
      if (businessLicense !== null) {
        push('gc.sf_business_license', 'SF business license', businessLicense, 'verified', SOURCE_CONTACTS, 'San Francisco business licence number as filed.', ts);
      }
    } else if (role === 'engineer') {
      if (firm !== null) {
        push('engineer.firm_name', 'Engineer of record', firm, 'verified', SOURCE_CONTACTS, `Listed as engineer on permit ${permitNumber}.`, ts);
      }
      if (license !== null) {
        push('engineer.license_number', 'Engineer license', license, 'verified', SOURCE_CONTACTS, 'License number as filed with DBI.', ts);
      }
    } else if (role === 'architect') {
      if (firm !== null) {
        push('architect.firm_name', 'Architect of record', firm, 'verified', SOURCE_CONTACTS, `Listed as architect on permit ${permitNumber}.`, ts);
      }
      if (license !== null) {
        push('architect.license_number', 'Architect license', license, 'verified', SOURCE_CONTACTS, 'License number as filed with DBI.', ts);
      }
    }
  }

  const permitTs = '2026-08-01T00:00:00Z';
  if (permit.valuation !== null) {
    push('project.valuation', 'Declared project valuation', permit.valuation, 'verified', SOURCE_PERMITS, 'max(revised_cost, estimated_cost) as published.', permitTs);
  }
  push('permit.status', 'Permit status', permit.status, 'verified', SOURCE_PERMITS, 'Status as published by DBI.', permitTs);

  // Honest unknowns. DataSF publishes none of these, and no amount of wanting
  // them changes that. They stay visible and they cost evidence points.
  push('electrical.contractor_on_permit', 'Electrical contractor on the permit', null, 'unknown', SOURCE_CONTACTS, 'No contact row carries an electrical role on this permit.', permitTs);
  push('gc.phone', 'Contractor phone', null, 'unknown', null, 'Not published in the permit contacts dataset.', permitTs);
  push('gc.electrical_award', 'Electrical subcontract awarded', null, 'unknown', null, 'Award status is not a public record.', permitTs);

  return out;
}

/* -------------------------------------------------------------------------- */
/* The subscriber                                                             */
/* -------------------------------------------------------------------------- */

function mikesElectric(overrides: Partial<CustomerProfile> = {}): CustomerProfile {
  return customerProfileSchema.parse({
    businessName: "Mike's Commercial Electric",
    trade: 'electrical',
    territoryZips: [],
    territoryDistricts: [],
    minProjectValue: 100_000,
    preferredUses: [
      'office',
      'retail sales',
      'clinics-medic/dental',
      'tourist hotel/motel',
      'food/beverage hndlng',
    ],
    phone: '+14155550137',
    status: 'active',
    effectiveWeights: { fit: 1, demand: 1, timing: 1, value: 1, evidence: 1 },
    ...overrides,
  });
}

/** Demo day. Roughly four months after the hero permit was issued. */
const NOW_DEMO_DAY = '2026-08-15T12:00:00-07:00';
/** Four days after the hero permit issued, which is when replay releases it. */
const NOW_JUST_ISSUED = '2026-04-14T12:00:00-07:00';

function inputFor(permitNumber: string, now: string, customer = mikesElectric()): ScoreLeadInput {
  const permit = permitFor(permitNumber);
  return { permit, findings: findingsFor(permitNumber, permit), customer, now };
}

const sumDeltas = (result: ScoreResult): number =>
  result.drivers.reduce((total, driver) => total + driver.delta, 0);

/* -------------------------------------------------------------------------- */
/* Contract invariants                                                        */
/* -------------------------------------------------------------------------- */

describe('scoring contract', () => {
  it('keeps the threshold at 80 and the component maxima summing to 100', () => {
    expect(LEAD_SCORE_THRESHOLD).toBe(80);
    expect(LEAD_SCORE_COMPONENT_MAX).toEqual({ fit: 30, demand: 25, timing: 20, value: 15, evidence: 10 });
    const total = Object.values(LEAD_SCORE_COMPONENT_MAX).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it('registers the lead score as a deterministic calculation', () => {
    expect(isCalculationId('scoring.lead')).toBe(true);
    expect(isCalculationId('scoring.nope')).toBe(false);

    const descriptor = getCalculation('scoring.lead');
    expect(descriptor.deterministic).toBe(true);
    expect(descriptor.outputs).toContain('fatalFlags');

    const input = inputFor(HERO, NOW_DEMO_DAY);
    expect(descriptor.run(input)).toEqual(scoreLead(input));

    const listed = listCalculations();
    expect(listed).toHaveLength(Object.keys(CALCULATIONS).length);
    expect(listed[0]).not.toHaveProperty('run');
  });
});

/* -------------------------------------------------------------------------- */
/* The hero permit                                                            */
/* -------------------------------------------------------------------------- */

describe('hero permit 202603238106 (555 California St)', () => {
  it('is the record the demo says it is', () => {
    const permit = permitFor(HERO);
    expect(permit.valuation).toBe(8_285_917);
    expect(permit.status).toBe('issued');
    expect(permit.existingUse).toBe('office');
    expect(permit.zipcode).toBe('94104');
    expect(permit.description).toContain('lighting');
  });

  it('clears the delivery threshold on demo day', () => {
    const result = scoreLead(inputFor(HERO, NOW_DEMO_DAY));
    expect(result.fatalFlags).toEqual([]);
    expect(result.score).toBeGreaterThanOrEqual(LEAD_SCORE_THRESHOLD);
    expect(meetsDeliveryBar(result)).toBe(true);
  });

  it('scores higher the closer the scoring clock sits to the issue date', () => {
    const fresh = scoreLead(inputFor(HERO, NOW_JUST_ISSUED));
    const later = scoreLead(inputFor(HERO, NOW_DEMO_DAY));
    expect(fresh.score).toBeGreaterThanOrEqual(LEAD_SCORE_THRESHOLD);
    expect(fresh.score).toBeGreaterThan(later.score);
  });

  it('names the electrical scope and the general contractor in its drivers', () => {
    const result = scoreLead(inputFor(HERO, NOW_DEMO_DAY));
    const reasons = result.drivers.map((driver) => driver.reason).join(' | ');
    expect(reasons).toMatch(/lighting/);
    expect(reasons).toMatch(/Skyline Construction/);
    expect(reasons).toMatch(/52 stories/);
  });

  it('carries the missing electrical contractor as an unknown, not an absence', () => {
    const findings = findingsFor(HERO, permitFor(HERO));
    const gap = findings.find((f) => f.key === 'electrical.contractor_on_permit');
    expect(gap).toBeDefined();
    expect(gap?.value).toBeNull();
    expect(gap?.evidence).toBe('unknown');
    // And the whole set validates against the shared Finding contract.
    for (const item of findings) expect(() => findingSchema.parse(item)).not.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* A real, weak candidate                                                     */
/* -------------------------------------------------------------------------- */

describe('weak real candidate 202605010480 (office reroof)', () => {
  it('is a genuinely qualifying record on paper', () => {
    const permit = permitFor(WEAK);
    expect(permit.existingUse).toBe('office');
    expect(permit.valuation).toBe(226_425);
    expect(permit.valuation ?? 0).toBeGreaterThan(mikesElectric().minProjectValue);
  });

  it('falls well short of the threshold with no fatal flag', () => {
    const result = scoreLead(inputFor(WEAK, NOW_DEMO_DAY));
    expect(result.fatalFlags).toEqual([]);
    expect(result.score).toBeLessThan(LEAD_SCORE_THRESHOLD);
    expect(meetsDeliveryBar(result)).toBe(false);
  });

  it('explains itself: no electrical scope, and the work is already complete', () => {
    const result = scoreLead(inputFor(WEAK, NOW_DEMO_DAY));
    const reasons = result.drivers.map((driver) => driver.reason).join(' | ');
    // The scope was published and names no electrical work, so fit collapses
    // entirely rather than merely scoring zero on its trade sub-component.
    // See the fit gate in lead-score.ts and lib/domain/trades.test.ts.
    expect(reasons).toMatch(/names no electrical work/);
    expect(reasons).toMatch(/regardless of its size/);
    expect(result.warnings.join(' | ')).toMatch(/complete/);
  });

  it('scores below the hero permit under identical conditions', () => {
    const hero = scoreLead(inputFor(HERO, NOW_DEMO_DAY));
    const weak = scoreLead(inputFor(WEAK, NOW_DEMO_DAY));
    expect(weak.score).toBeLessThan(hero.score);
  });
});

/* -------------------------------------------------------------------------- */
/* Purity                                                                     */
/* -------------------------------------------------------------------------- */

describe('purity', () => {
  it('returns identical output for identical input', () => {
    const input = inputFor(HERO, NOW_DEMO_DAY);
    const first = scoreLead(input);
    const second = scoreLead(input);
    expect(second).toEqual(first);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it('does not mutate its input', () => {
    const input = inputFor(HERO, NOW_DEMO_DAY);
    const snapshot = JSON.stringify(input);
    scoreLead(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('reads permit dates as UTC, so the same instant scores the same either way', () => {
    // DataSF publishes `2026-04-10T15:03:06.000` with no offset. If the module
    // let the host timezone decide, these two equivalent clocks would diverge.
    const zulu = scoreLead(inputFor(HERO, '2026-08-15T19:00:00Z'));
    const pacific = scoreLead(inputFor(HERO, '2026-08-15T12:00:00-07:00'));
    expect(pacific).toEqual(zulu);
  });

  it('degrades rather than throwing when the scoring clock is unreadable', () => {
    const result = scoreLead(inputFor(HERO, 'not-a-timestamp'));
    expect(result.score).toBeGreaterThan(0);
    expect(result.warnings.join(' | ')).toMatch(/could not be parsed/);
  });
});

/* -------------------------------------------------------------------------- */
/* Fatal flags                                                                */
/* -------------------------------------------------------------------------- */

describe('fatal flags', () => {
  it('flags a cancelled permit without silently zeroing its score', () => {
    const result = scoreLead(inputFor(CANCELLED, NOW_DEMO_DAY));
    expect(result.fatalFlags.map((flag) => flag.code)).toContain('status.terminal');
    expect(result.score).toBeGreaterThan(0);
    expect(meetsDeliveryBar(result)).toBe(false);
    expect(result.fatalFlags[0]?.message).toMatch(/cancelled/);
  });

  it('does not double-count a terminal status as a timing penalty', () => {
    // Same record, same clock, one scored with its real cancelled status and one
    // with the status it held before cancellation. The score must be identical:
    // the disqualification lives in fatalFlags, not in the arithmetic.
    const cancelled = inputFor(CANCELLED, NOW_DEMO_DAY);
    const asIssued: ScoreLeadInput = {
      ...cancelled,
      permit: { ...cancelled.permit, status: 'issued' },
    };
    const a = scoreLead(cancelled);
    const b = scoreLead(asIssued);
    expect(a.score).toBe(b.score);
    expect(a.fatalFlags).toHaveLength(1);
    expect(b.fatalFlags).toHaveLength(0);
  });

  it('flags a project under the subscriber floor while keeping the score honest', () => {
    const result = scoreLead(inputFor(UNDER_FLOOR, NOW_DEMO_DAY));
    expect(result.fatalFlags.map((flag) => flag.code)).toContain('valuation.below_floor');
    // $20k of phone-booth power work in a downtown office tower: good fit, wrong size.
    expect(result.score).toBeGreaterThan(20);
    expect(result.score).toBeLessThan(LEAD_SCORE_THRESHOLD);
  });

  it('flags a job outside the declared territory', () => {
    const narrow = mikesElectric({ territoryZips: ['94110', '94103'] });
    const result = scoreLead(inputFor(HERO, NOW_DEMO_DAY, narrow));
    expect(result.fatalFlags.map((flag) => flag.code)).toContain('territory.mismatch');
    // The hero still scores like the hero. Only delivery is blocked.
    expect(result.score).toBeGreaterThanOrEqual(LEAD_SCORE_THRESHOLD);
    expect(meetsDeliveryBar(result)).toBe(false);
  });

  it('accepts a district match when the zip allowlist misses', () => {
    const byDistrict = mikesElectric({ territoryZips: ['94110'], territoryDistricts: ['3'] });
    const result = scoreLead(inputFor(HERO, NOW_DEMO_DAY, byDistrict));
    expect(result.fatalFlags).toEqual([]);
  });

  it('warns instead of flagging when the permit publishes no location at all', () => {
    const narrow = mikesElectric({ territoryZips: ['94110'] });
    const base = inputFor(HERO, NOW_DEMO_DAY, narrow);
    const locationless: ScoreLeadInput = {
      ...base,
      permit: { ...base.permit, zipcode: null, supervisorDistrict: null },
    };
    const result = scoreLead(locationless);
    expect(result.fatalFlags).toEqual([]);
    expect(result.warnings.join(' | ')).toMatch(/territory could not be confirmed/);
  });
});

/* -------------------------------------------------------------------------- */
/* Drivers                                                                    */
/* -------------------------------------------------------------------------- */

describe('drivers', () => {
  const cases: readonly [string, string][] = [
    ['hero', HERO],
    ['weak', WEAK],
    ['cancelled', CANCELLED],
    ['under floor', UNDER_FLOOR],
  ];

  it.each(cases)('%s: every driver carries a non-empty reason', (_label, permitNumber) => {
    const result = scoreLead(inputFor(permitNumber, NOW_DEMO_DAY));
    expect(result.drivers.length).toBeGreaterThan(0);
    for (const driver of result.drivers) {
      expect(driver.reason.trim().length).toBeGreaterThan(0);
      expect(Number.isFinite(driver.delta)).toBe(true);
    }
  });

  it.each(cases)('%s: driver deltas sum to the reported score', (_label, permitNumber) => {
    const result = scoreLead(inputFor(permitNumber, NOW_DEMO_DAY));
    expect(Math.abs(sumDeltas(result) - result.score)).toBeLessThanOrEqual(0.5);
  });

  it('keeps the sum honest when customer weights push past 100', () => {
    const loud = mikesElectric({
      effectiveWeights: { fit: 2, demand: 2, timing: 2, value: 2, evidence: 2 },
    });
    const result = scoreLead(inputFor(HERO, NOW_DEMO_DAY, loud));
    expect(result.score).toBe(100);
    expect(Math.abs(sumDeltas(result) - result.score)).toBeLessThanOrEqual(0.5);
    expect(result.drivers.some((driver) => /clamped to the 0-100 scale/.test(driver.reason))).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Customer weights                                                           */
/* -------------------------------------------------------------------------- */

describe('customer weights', () => {
  it('moves the score when the Customer Agent de-emphasises a component', () => {
    const base = scoreLead(inputFor(HERO, NOW_DEMO_DAY));
    const valueBlind = mikesElectric({
      effectiveWeights: { fit: 1, demand: 1, timing: 1, value: 0, evidence: 1 },
    });
    const adjusted = scoreLead(inputFor(HERO, NOW_DEMO_DAY, valueBlind));
    expect(adjusted.score).toBeLessThan(base.score);
    expect(adjusted.drivers.some((driver) => /weights value at 0x/.test(driver.reason))).toBe(true);
  });

  it('clamps an out-of-range weight and says so', () => {
    const runaway = mikesElectric({
      effectiveWeights: { fit: 99, demand: 1, timing: 1, value: 1, evidence: 1 },
    });
    const result = scoreLead(inputFor(HERO, NOW_DEMO_DAY, runaway));
    expect(result.warnings.join(' | ')).toMatch(/clamped/);
    expect(result.score).toBeLessThanOrEqual(100);
  });
});

/* -------------------------------------------------------------------------- */
/* Evidence discipline                                                        */
/* -------------------------------------------------------------------------- */

describe('evidence', () => {
  it('costs visible points when the Findings are mostly unknown', () => {
    const strong = inputFor(HERO, NOW_DEMO_DAY);
    const hollow: ScoreLeadInput = {
      ...strong,
      findings: strong.findings.map((item) => ({ ...item, value: null, evidence: 'unknown' as const })),
    };
    const strongResult = scoreLead(strong);
    const hollowResult = scoreLead(hollow);

    expect(hollowResult.score).toBeLessThan(strongResult.score);
    expect(hollowResult.warnings.join(' | ')).toMatch(/unknown/);
    expect(hollowResult.drivers.some((driver) => /Findings are unknown/.test(driver.reason))).toBe(true);
    // The unknown penalty drives the component negative; the clamp back to zero
    // is itself a driver, so the sum still reconciles with the score.
    expect(Math.abs(sumDeltas(hollowResult) - hollowResult.score)).toBeLessThanOrEqual(0.5);
    expect(hollowResult.drivers.some((driver) => /evidence subtotal .* clamped/.test(driver.reason))).toBe(true);
  });

  it('scores a candidate with no Findings at all without crashing', () => {
    const base = inputFor(HERO, NOW_DEMO_DAY);
    const bare: ScoreLeadInput = { ...base, findings: [] };
    const result = scoreLead(bare);
    expect(result.score).toBeGreaterThan(0);
    expect(result.score).toBeLessThan(scoreLead(base).score);
    expect(result.warnings.join(' | ')).toMatch(/no Findings/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Absent data                                                                */
/* -------------------------------------------------------------------------- */

describe('absent data is not zero', () => {
  it('holds timing at a neutral floor when the permit carries no dates', () => {
    const base = inputFor(HERO, NOW_DEMO_DAY);
    const undated: ScoreLeadInput = {
      ...base,
      permit: {
        ...base.permit,
        filedDate: null,
        issuedDate: null,
        statusDate: null,
        approvedDate: null,
        lastPermitActivityDate: null,
      },
    };
    const result = scoreLead(undated);
    const timing = result.drivers.find((driver) => /neutral floor/.test(driver.reason));
    expect(timing?.delta).toBe(6);
    expect(result.warnings.join(' | ')).toMatch(/timing is unknown, not stale/);
  });

  it('withholds value rather than guessing when no cost is published', () => {
    const base = inputFor(HERO, NOW_DEMO_DAY);
    const priceless: ScoreLeadInput = {
      ...base,
      permit: { ...base.permit, valuation: null, estimatedCost: null, revisedCost: null },
    };
    const result = scoreLead(priceless);
    expect(result.fatalFlags).toEqual([]); // absent is not "below the floor"
    expect(result.warnings.join(' | ')).toMatch(/cost is populated/);
    expect(result.drivers.some((driver) => /valuation not published/i.test(driver.reason))).toBe(true);
  });

  it('gives partial credit when the building use is not published', () => {
    const base = inputFor(HERO, NOW_DEMO_DAY);
    const useless: ScoreLeadInput = {
      ...base,
      permit: { ...base.permit, existingUse: null, proposedUse: null },
    };
    const result = scoreLead(useless);
    const driver = result.drivers.find((d) => /use not published/i.test(d.reason));
    expect(driver?.delta).toBe(3);
    expect(result.score).toBeLessThan(scoreLead(base).score);
  });
});

/* -------------------------------------------------------------------------- */
/* Description reading                                                        */
/* -------------------------------------------------------------------------- */

describe('scope-of-work reading', () => {
  it('does not read "non-electric" as electrical scope', () => {
    const permit = permitFor(NEGATED);
    expect(permit.description).toMatch(/non-electric/);
    const result = scoreLead(inputFor(NEGATED, NOW_DEMO_DAY));
    const reasons = result.drivers.map((driver) => driver.reason).join(' | ');
    expect(reasons).not.toMatch(/electrical scope/);
  });

  it('reads real electrical scope on the under-floor office permit', () => {
    const result = scoreLead(inputFor(UNDER_FLOOR, NOW_DEMO_DAY));
    const reasons = result.drivers.map((driver) => driver.reason).join(' | ');
    expect(reasons).toMatch(/electrical scope/);
  });

  it('reads a multi-class occupancy string down to distinct classes', () => {
    // Uses a permit that CLEARS the trade-fit gate, because occupancy is only
    // scored for candidates whose scope actually names the subscriber's trade.
    // 202602175990: 9th floor office TI, existing_occupancy "B,M,S-2", and its
    // description names "ceiling and lighting", so an electrical subscriber
    // reaches the occupancy driver at all.
    expect(permitFor(MULTI_OCCUPANCY).existingOccupancy).toBe('B,M,S-2');
    const result = scoreLead(inputFor(MULTI_OCCUPANCY, NOW_DEMO_DAY));
    const driver = result.drivers.find((d) => /Occupancy class/.test(d.reason));
    expect(driver?.reason).toContain('B/M/S');
    expect(driver?.delta).toBe(4); // full credit: B, M and S are all commercial
  });

  it('does not reach occupancy at all when the trade is absent from the scope', () => {
    // The cancelled school reroof publishes a rich multi-class occupancy
    // ("E,A-3,A-2") but no electrical scope, so the fit gate returns before
    // occupancy is ever considered. Building class cannot rescue a job that is
    // not in the subscriber's trade.
    expect(permitFor(CANCELLED).existingOccupancy).toBe('E,A-3,A-2');
    const result = scoreLead(inputFor(CANCELLED, NOW_DEMO_DAY));
    expect(result.drivers.some((d) => /Occupancy class/.test(d.reason))).toBe(false);
    expect(result.drivers.some((d) => /names no electrical work/.test(d.reason))).toBe(true);
  });
});
