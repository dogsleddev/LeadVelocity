/**
 * Proof that the engine is trade-agnostic.
 *
 * The pitch claims "the engine does not change for the next trade or the next
 * city". That is a claim about the code, so the code should be able to prove it.
 *
 * The test is a cross-over on REAL permits: score the same two real San
 * Francisco records for two different trades and show the ranking flips. An
 * electrical subscriber should prefer the office tenant improvement with
 * lighting and power in its scope; a roofing subscriber should prefer the
 * reroof. Nothing about the scoring module changes between the two runs, only
 * `customer.trade`.
 *
 * This does NOT enable a second trade in the demo. The seeded subscriber stays
 * electrical (kickoff not-building list: "no second trade unless electrical is
 * rock solid"). It only demonstrates that the generality is real.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { LEAD_SCORE_THRESHOLD, normalizedPermitSchema, scoreLead } from '@/lib/calculations/scoring/lead-score';
import { customerProfileSchema, type CustomerProfile } from '@/lib/domain/schemas/core';
import { allTrades, TRADE_PROFILES, tradeProfile, tradeSchema, type Trade } from '@/lib/domain/trades';
import type { NormalizedPermit } from '@/lib/calculations/scoring/lead-score';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
type RawRow = Record<string, unknown>;

const PERMIT_ROWS = JSON.parse(readFileSync(`${REPO_ROOT}data/permits.json`, 'utf8')) as RawRow[];

/** 555 California St: $8.29M office TI, "lighting, power and communication fixtures". */
const ELECTRICAL_JOB = '202603238106';
/** $334k office reroof with hot works. No electrical language anywhere in scope. */
const ROOFING_JOB = '202603187837';

const NOW = '2026-08-15T12:00:00-07:00';

function str(row: RawRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function num(row: RawRow, key: string): number | null {
  const value = row[key];
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function permitFor(permitNumber: string): NormalizedPermit {
  const row = PERMIT_ROWS.find((candidate) => str(candidate, 'permit_number') === permitNumber);
  if (row === undefined) throw new Error(`Permit ${permitNumber} is not in data/permits.json`);
  const costs = [num(row, 'estimated_cost'), num(row, 'revised_cost')].filter(
    (c): c is number => c !== null,
  );
  return normalizedPermitSchema.parse({
    permitNumber: str(row, 'permit_number') ?? '',
    status: (str(row, 'status') ?? '').toLowerCase(),
    description: str(row, 'description'),
    permitTypeDefinition: str(row, 'permit_type_definition'),
    existingUse: str(row, 'existing_use'),
    proposedUse: str(row, 'proposed_use'),
    existingOccupancy: str(row, 'existing_occupancy'),
    proposedOccupancy: str(row, 'proposed_occupancy'),
    valuation: costs.length > 0 ? Math.max(...costs) : null,
    estimatedCost: num(row, 'estimated_cost'),
    revisedCost: num(row, 'revised_cost'),
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

/** Same subscriber in every respect except the trade. That is the whole point. */
function subscriberInTrade(trade: Trade): CustomerProfile {
  return customerProfileSchema.parse({
    businessName: `Demo ${tradeProfile(trade).label} contractor`,
    trade,
    territoryZips: [],
    territoryDistricts: [],
    minProjectValue: 100_000,
    preferredUses: ['office', 'retail sales', 'school', 'church'],
    phone: '+14155550137',
    status: 'active',
    effectiveWeights: { fit: 1, demand: 1, timing: 1, value: 1, evidence: 1 },
  });
}

/** Findings held empty and identical, so only trade vocabulary can move the score. */
const NO_FINDINGS: never[] = [];

function scoreFor(permitNumber: string, trade: Trade): number {
  return scoreLead({
    permit: permitFor(permitNumber),
    findings: NO_FINDINGS,
    customer: subscriberInTrade(trade),
    now: NOW,
  }).score;
}

describe('trade profiles', () => {
  it('covers every trade in the schema with a usable profile', () => {
    for (const trade of allTrades()) {
      const profile = tradeProfile(trade);
      expect(profile.label.length, `${trade} label`).toBeGreaterThan(0);
      expect(profile.cslbClassification.length, `${trade} classification`).toBeGreaterThan(0);
      expect(profile.core.length, `${trade} core terms`).toBeGreaterThan(0);
    }
  });

  it('exposes exactly the trades the schema allows', () => {
    expect(new Set(Object.keys(TRADE_PROFILES))).toEqual(new Set(tradeSchema.options));
  });

  it('keeps electrical as the trade the demo is configured for', () => {
    expect(tradeProfile('electrical').cslbClassification).toBe('C-10');
  });
});

describe('the engine is trade-agnostic (cross-over on real permits)', () => {
  it('the two test records are the real records this test assumes', () => {
    const electricalJob = permitFor(ELECTRICAL_JOB);
    expect(electricalJob.description?.toLowerCase()).toContain('lighting');
    expect(electricalJob.description?.toLowerCase()).toContain('power');

    const roofingJob = permitFor(ROOFING_JOB);
    expect(roofingJob.description?.toLowerCase()).toContain('reroof');
    // The roofing record must be clean of electrical language, otherwise the
    // cross-over proves nothing.
    expect(roofingJob.description?.toLowerCase()).not.toContain('electric');
    expect(roofingJob.description?.toLowerCase()).not.toContain('lighting');
  });

  it('an electrical subscriber prefers the lighting-and-power job', () => {
    expect(scoreFor(ELECTRICAL_JOB, 'electrical')).toBeGreaterThan(
      scoreFor(ROOFING_JOB, 'electrical'),
    );
  });

  it('a roofing subscriber prefers the reroof, on the same engine', () => {
    expect(scoreFor(ROOFING_JOB, 'roofing')).toBeGreaterThan(scoreFor(ELECTRICAL_JOB, 'roofing'));
  });

  it('the ranking genuinely flips with the trade, not just the magnitude', () => {
    const electricalRanking = scoreFor(ELECTRICAL_JOB, 'electrical') - scoreFor(ROOFING_JOB, 'electrical');
    const roofingRanking = scoreFor(ELECTRICAL_JOB, 'roofing') - scoreFor(ROOFING_JOB, 'roofing');
    expect(electricalRanking).toBeGreaterThan(0);
    expect(roofingRanking).toBeLessThan(0);
  });

  it('scores the same permit differently for a trade whose scope is absent', () => {
    // A glazing contractor has no business on either of these jobs, so both
    // should sit below what the matching trade sees.
    const glazingOnElectrical = scoreFor(ELECTRICAL_JOB, 'glazing');
    expect(glazingOnElectrical).toBeLessThan(scoreFor(ELECTRICAL_JOB, 'electrical'));
  });

  it('names the subscriber trade in its drivers rather than hardcoding electrical', () => {
    const result = scoreLead({
      permit: permitFor(ROOFING_JOB),
      findings: NO_FINDINGS,
      customer: subscriberInTrade('roofing'),
      now: NOW,
    });
    const reasons = result.drivers.map((driver) => driver.reason).join(' | ');
    expect(reasons.toLowerCase()).toContain('roofing');
    expect(reasons.toLowerCase()).not.toContain('electrical scope');
  });

  it('is deterministic per trade', () => {
    for (const trade of allTrades()) {
      expect(scoreFor(ELECTRICAL_JOB, trade)).toBe(scoreFor(ELECTRICAL_JOB, trade));
    }
  });

  it('keeps the delivery threshold shared across trades', () => {
    expect(LEAD_SCORE_THRESHOLD).toBe(80);
  });
});

/**
 * The property that makes the product promise true.
 *
 * Before the fit gate existed, the $8.29M office fit-out scored 63 for a roofing
 * subscriber purely on size, recency and a desirable building use, despite its
 * own driver saying there was no roofing scope in the job. Attach Findings and
 * it would have crossed 80 and been texted to a roofer. These tests pin the fix.
 */
describe('a job in the wrong trade can never be delivered', () => {
  it('collapses fit to zero when the scope was read and the trade is absent', () => {
    const result = scoreLead({
      permit: permitFor(ELECTRICAL_JOB),
      findings: NO_FINDINGS,
      customer: subscriberInTrade('roofing'),
      now: NOW,
    });
    const fitDriver = result.drivers.find((d) => d.reason.includes('does not fit'));
    expect(fitDriver, 'expected an explicit no-fit driver').toBeDefined();
    expect(result.warnings.join(' ')).toContain('regardless');
  });

  it('cannot reach the delivery threshold even with a perfect everything else', () => {
    // fit 30 is zeroed, so the reachable ceiling is demand 25 + timing 20 +
    // value 15 + evidence 10 = 70, which is below the threshold of 80.
    const MAX_WITHOUT_FIT = 25 + 20 + 15 + 10;
    expect(MAX_WITHOUT_FIT).toBeLessThan(LEAD_SCORE_THRESHOLD);

    const result = scoreLead({
      permit: permitFor(ELECTRICAL_JOB),
      findings: NO_FINDINGS,
      customer: subscriberInTrade('roofing'),
      now: NOW,
    });
    expect(result.score).toBeLessThanOrEqual(MAX_WITHOUT_FIT);
    expect(result.score).toBeLessThan(LEAD_SCORE_THRESHOLD);
  });

  it('does NOT punish a permit whose description is simply missing', () => {
    // Unknown is not absent (hard rule 3). A permit with no description must
    // fall through to normal scoring with a warning, not hit the fit gate.
    const withoutDescription = { ...permitFor(ELECTRICAL_JOB), description: null };
    const result = scoreLead({
      permit: withoutDescription,
      findings: NO_FINDINGS,
      customer: subscriberInTrade('roofing'),
      now: NOW,
    });
    expect(result.drivers.some((d) => d.reason.includes('does not fit'))).toBe(false);
    expect(result.warnings.join(' ')).toContain('unassessed, not absent');
  });

  it('still delivers the hero to the trade it actually belongs to', () => {
    // The gate must not have broken the demo. Electrical keeps its fit.
    const result = scoreLead({
      permit: permitFor(ELECTRICAL_JOB),
      findings: NO_FINDINGS,
      customer: subscriberInTrade('electrical'),
      now: NOW,
    });
    expect(result.drivers.some((d) => d.reason.includes('does not fit'))).toBe(false);
    expect(result.score).toBeGreaterThan(scoreFor(ELECTRICAL_JOB, 'roofing'));
  });
});
