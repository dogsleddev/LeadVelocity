/**
 * Shortlist filter tests, run against the committed real extract.
 *
 * There are no fixtures in this file. Every permit referenced by number is a
 * real San Francisco DBI record in `data/permits.json` (10,880 rows retrieved
 * from Socrata dataset `i98e-djp9`), normalized through the real normalizer.
 * CLAUDE.md hard rule #5 bans mock data from the demo path, and a filter proved
 * only against hand-written objects proves nothing about the data it will meet.
 *
 * The load-bearing assertion is the hero permit: 202603238106, the $8.29M office
 * remodel at 555 California St whose scope names lighting and power and whose
 * contact list contains no electrical contractor. The demo turns on that record
 * clearing every gate, so a failure here is a real defect in the filters.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { normalizePermit, type NormalizedPermit } from '@/lib/domain/permit-normalizer';
import { customerProfileSchema, type CustomerProfile } from '@/lib/domain/schemas/core';

import {
  ACTIVE_PIPELINE_STATUSES,
  classifyUse,
  commercialUseGate,
  costFloorGate,
  dedupeGate,
  filterOutcomeSchema,
  formatUsd,
  geographyGate,
  nearDuplicateKey,
  nearDuplicateKeys,
  permitDedupeKey,
  permitValuation,
  projectTypeGate,
  runShortlistFilters,
  SHORTLIST_GATES,
  shortlistResultSchema,
  statusGate,
  summarizeShortlistResult,
  type ShortlistGate,
} from '@/lib/pipeline/shortlist-filters';

/* -------------------------------------------------------------------------- */
/* Real extract                                                               */
/* -------------------------------------------------------------------------- */

const EXTRACT_PATH = path.resolve(process.cwd(), 'data/permits.json');

/** Raw rows, loaded once. Normalizing all 10,880 costs a couple of seconds. */
const rawRows: unknown[] = JSON.parse(readFileSync(EXTRACT_PATH, 'utf8')) as unknown[];

const rawByPermitNumber = new Map<string, unknown>();
for (const row of rawRows) {
  const permitNumber = (row as { permit_number?: unknown }).permit_number;
  if (typeof permitNumber === 'string' && !rawByPermitNumber.has(permitNumber)) {
    rawByPermitNumber.set(permitNumber, row);
  }
}

/** Normalize one real record by permit number. Fails loudly if it is missing. */
function permit(permitNumber: string): NormalizedPermit {
  const raw = rawByPermitNumber.get(permitNumber);
  if (raw === undefined) {
    throw new Error(`Permit ${permitNumber} is not in the committed extract at ${EXTRACT_PATH}`);
  }
  return normalizePermit(raw);
}

let allPermitsCache: NormalizedPermit[] | null = null;

/** Every row in the extract, normalized once and reused across tests. */
function allPermits(): NormalizedPermit[] {
  if (allPermitsCache === null) {
    allPermitsCache = rawRows.map((row) => normalizePermit(row));
  }
  return allPermitsCache;
}

/* -------------------------------------------------------------------------- */
/* The subscriber                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Mike's Commercial Electric: the single subscriber persona from the kickoff.
 * Empty territory arrays encode "all of San Francisco", which is the stated
 * territory.
 */
const mike: CustomerProfile = customerProfileSchema.parse({
  businessName: "Mike's Commercial Electric",
  trade: 'electrical',
  territoryZips: [],
  territoryDistricts: [],
  minProjectValue: 100_000,
  preferredUses: [],
  phone: '+15555550123',
  status: 'active',
});

/** Same subscriber, territory narrowed to the Financial District zip. */
const mikeZipRestricted: CustomerProfile = customerProfileSchema.parse({
  ...mike,
  territoryZips: ['94104'],
});

/** Same subscriber, territory expressed as supervisor districts. */
const mikeDistrictRestricted: CustomerProfile = customerProfileSchema.parse({
  ...mike,
  territoryDistricts: ['3'],
});

/** A fixed clock. Every function under test takes "now" explicitly. */
const NOW = new Date('2026-08-15T12:00:00-07:00');

const HERO = '202603238106';

/** The gate that rejected a permit, or null. */
function rejectedGates(
  target: NormalizedPermit,
  customer: CustomerProfile = mike,
): ShortlistGate[] {
  return runShortlistFilters(target, customer, NOW)
    .outcomes.filter((outcome) => !outcome.passed)
    .map((outcome) => outcome.gate);
}

/* -------------------------------------------------------------------------- */

describe('extract sanity', () => {
  it('loads the committed real extract of 10,880 SF permits', () => {
    expect(rawRows.length).toBe(10_880);
  });

  it('normalizes every row in the extract without throwing', () => {
    expect(allPermits().length).toBe(rawRows.length);
  });
});

/* -------------------------------------------------------------------------- */
/* Hero permit                                                                */
/* -------------------------------------------------------------------------- */

describe('hero permit 202603238106 (555 California St, $8.29M office remodel)', () => {
  const hero = permit(HERO);

  it('is the record the demo expects: issued, office, 8,285,917, district 3, zip 94104', () => {
    expect(hero.status).toBe('issued');
    expect(hero.existingUse).toBe('office');
    expect(hero.proposedUse).toBe('office');
    expect(hero.valuation).toBe(8_285_917);
    expect(hero.supervisorDistrict).toBe('3');
    expect(hero.zipcode).toBe('94104');
    expect(hero.description).toContain('lighting');
    expect(hero.description).toContain('power');
  });

  it('clears the geography gate for a citywide territory', () => {
    expect(geographyGate(hero, mike).passed).toBe(true);
  });

  it('clears the status gate: issued is an active pipeline status', () => {
    const outcome = statusGate(hero, NOW);
    expect(outcome.passed).toBe(true);
    expect(outcome.reason).toContain('issued');
  });

  it('clears the project type gate: an otc alterations permit carries build-out scope', () => {
    expect(projectTypeGate(hero).passed).toBe(true);
  });

  it('clears the commercial use gate: office is commercial', () => {
    const outcome = commercialUseGate(hero);
    expect(outcome.passed).toBe(true);
    expect(classifyUse(hero).classification).toBe('commercial');
  });

  it('clears the cost floor gate: 8,285,917 beats the 100,000 minimum', () => {
    const outcome = costFloorGate(hero, mike);
    expect(outcome.passed).toBe(true);
    expect(outcome.reason).toContain('$8,285,917');
    expect(outcome.reason).toContain('$100,000');
  });

  it('clears the dedupe gate on first sighting', () => {
    expect(dedupeGate(hero, new Set<string>()).passed).toBe(true);
  });

  it('PASSES EVERY GATE for Mike’s profile', () => {
    const result = runShortlistFilters(hero, mike, NOW);
    expect(result.outcomes.map((outcome) => outcome.gate)).toEqual([...SHORTLIST_GATES]);
    expect(result.outcomes.every((outcome) => outcome.passed)).toBe(true);
    expect(result.rejectedBy).toBeNull();
    expect(result.passed).toBe(true);
    expect(result.valuation).toBe(8_285_917);
  });

  it('passes when the territory is narrowed to zip 94104', () => {
    const result = runShortlistFilters(hero, mikeZipRestricted, NOW);
    expect(result.passed).toBe(true);
    expect(result.outcomes[0]?.reason).toContain('94104');
  });

  it('passes when the territory is expressed as supervisor district 3', () => {
    const result = runShortlistFilters(hero, mikeDistrictRestricted, NOW);
    expect(result.passed).toBe(true);
    expect(result.outcomes[0]?.reason).toContain('district 3');
  });

  it('passes when the territory is expressed as a neighborhood name', () => {
    const byNeighborhood = customerProfileSchema.parse({
      ...mike,
      territoryDistricts: ['Financial District/South Beach'],
    });
    expect(runShortlistFilters(hero, byNeighborhood, NOW).passed).toBe(true);
  });

  it('produces a result that satisfies the published schema', () => {
    const result = runShortlistFilters(hero, mike, NOW);
    expect(() => shortlistResultSchema.parse(result)).not.toThrow();
    for (const outcome of result.outcomes) {
      expect(() => filterOutcomeSchema.parse(outcome)).not.toThrow();
    }
  });

  it('summarizes as a clean line for the decision log', () => {
    const result = runShortlistFilters(hero, mike, NOW);
    const summary = summarizeShortlistResult(hero, result);
    expect(summary).toBe(`Permit ${HERO} cleared all 6 shortlist gates.`);
    expect(summary).not.toMatch(/—/);
  });
});

describe('backup hero permits also clear every gate', () => {
  // Verified alternates from the kickoff, in case the hero record moves.
  for (const permitNumber of ['202607295760', '202604239978', '202604209747']) {
    it(`permit ${permitNumber} passes every gate`, () => {
      const result = runShortlistFilters(permit(permitNumber), mike, NOW);
      expect(result.rejectedBy).toBeNull();
      expect(result.passed).toBe(true);
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Gate 1: geography                                                          */
/* -------------------------------------------------------------------------- */

describe('geography gate', () => {
  it('rejects permit 202407055897 (1948 Ocean Av, zip 94127, district 7) outside a 94104 territory', () => {
    const target = permit('202407055897');
    expect(target.zipcode).toBe('94127');
    const outcome = geographyGate(target, mikeZipRestricted);
    expect(outcome.passed).toBe(false);
    expect(outcome.gate).toBe('geography');
    expect(outcome.reason).toContain('outside the subscriber territory');
    expect(outcome.reason).toContain('94127');
  });

  it('accepts permit 202407055897 for a citywide territory', () => {
    expect(geographyGate(permit('202407055897'), mike).passed).toBe(true);
  });

  it('treats an empty territory as all of San Francisco rather than nothing', () => {
    const reason = geographyGate(permit(HERO), mike).reason;
    expect(reason).toContain('all of San Francisco');
  });

  it('rejects a territory-restricted permit that publishes no location at all', () => {
    const outcome = geographyGate(
      { permitNumber: '000000000000', zipcode: null, supervisorDistrict: null, neighborhood: null },
      mikeZipRestricted,
    );
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain('Location not published');
  });

  it('matches a zip written with a plus-four suffix', () => {
    const outcome = geographyGate(
      { permitNumber: '000000000000', zipcode: '94104-1234' },
      mikeZipRestricted,
    );
    expect(outcome.passed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Gate 2: status                                                             */
/* -------------------------------------------------------------------------- */

describe('status gate', () => {
  it('rejects permit 202602175990 (150 California St, $342,500 office) because it is complete', () => {
    const target = permit('202602175990');
    expect(target.status).toBe('complete');
    const outcome = statusGate(target, NOW);
    expect(outcome.passed).toBe(false);
    expect(outcome.gate).toBe('status');
    expect(outcome.reason).toContain('complete');
    expect(outcome.reason).toContain('already finished');
  });

  it('permit 202602175990 fails ONLY at the status gate, proving the gate is the cause', () => {
    expect(rejectedGates(permit('202602175990'))).toEqual(['status']);
  });

  it('accepts every status in the active set and rejects every terminal status seen on the extract', () => {
    const observed = new Map<string, boolean>();
    for (const target of allPermits()) {
      const status = target.status ?? '';
      if (observed.has(status)) continue;
      observed.set(status, statusGate(target, NOW).passed);
    }
    for (const [status, passed] of observed) {
      expect(passed).toBe(ACTIVE_PIPELINE_STATUSES.has(status));
    }
    // The extract really does contain all ten DBI statuses.
    expect(observed.size).toBe(10);
  });

  it('reports the filing age from the supplied clock, never from the wall clock', () => {
    const hero = permit(HERO);
    const early = statusGate(hero, new Date('2026-04-15T00:00:00-07:00'));
    const late = statusGate(hero, new Date('2026-08-15T00:00:00-07:00'));
    expect(early.reason).toContain('filed 22 days ago');
    expect(late.reason).toContain('filed 144 days ago');
  });
});

/* -------------------------------------------------------------------------- */
/* Gate 3: project type                                                       */
/* -------------------------------------------------------------------------- */

describe('project type gate', () => {
  it('rejects permit 202604270114 (758 Pacific Av, $127,000 retail) because it is a demolition', () => {
    const target = permit('202604270114');
    expect(target.permitTypeDefinition).toBe('demolitions');
    const outcome = projectTypeGate(target);
    expect(outcome.passed).toBe(false);
    expect(outcome.gate).toBe('project_type');
    expect(outcome.reason).toContain('demolitions');
    expect(outcome.reason).toContain('no build-out scope');
  });

  it('permit 202604270114 fails ONLY at the project type gate', () => {
    // Issued, retail sales, $127,000, district 3: it clears everything else.
    expect(rejectedGates(permit('202604270114'))).toEqual(['project_type']);
  });

  it('rejects sign and grading permits found on the extract', () => {
    const byType = new Map<string, NormalizedPermit>();
    for (const target of allPermits()) {
      const definition = target.permitTypeDefinition;
      if (definition !== null && !byType.has(definition)) byType.set(definition, target);
    }
    for (const definition of [
      'sign - erect',
      'wall or painted sign',
      'grade or quarry or fill or excavate',
      'demolitions',
    ]) {
      const sample = byType.get(definition);
      expect(sample, `${definition} should exist on the extract`).toBeDefined();
      if (sample !== undefined) expect(projectTypeGate(sample).passed).toBe(false);
    }
    for (const definition of [
      'otc alterations permit',
      'additions alterations or repairs',
      'new construction',
      'new construction wood frame',
    ]) {
      const sample = byType.get(definition);
      expect(sample, `${definition} should exist on the extract`).toBeDefined();
      if (sample !== undefined) expect(projectTypeGate(sample).passed).toBe(true);
    }
  });

  it('does not reject an unpublished permit type, it records it as unknown', () => {
    const outcome = projectTypeGate({ permitNumber: HERO, permitTypeDefinition: null });
    expect(outcome.passed).toBe(true);
    expect(outcome.reason).toContain('not published');
  });
});

/* -------------------------------------------------------------------------- */
/* Gate 4: commercial use                                                     */
/* -------------------------------------------------------------------------- */

describe('commercial use gate', () => {
  it('rejects permit 202505297539 (1820 Post St, $7.56M) because the use is apartments', () => {
    const target = permit('202505297539');
    expect(target.existingUse).toBe('apartments');
    expect(target.valuation).toBe(7_561_942);
    const outcome = commercialUseGate(target);
    expect(outcome.passed).toBe(false);
    expect(outcome.gate).toBe('commercial_use');
    expect(outcome.reason).toContain('apartments');
    expect(outcome.reason).toContain('residential');
  });

  it('permit 202505297539 fails ONLY at the use gate, so value alone cannot buy it in', () => {
    expect(rejectedGates(permit('202505297539'))).toEqual(['commercial_use']);
  });

  it('rejects every residential use present on the extract', () => {
    const byUse = new Map<string, NormalizedPermit>();
    for (const target of allPermits()) {
      const use = target.existingUse;
      if (use !== null && !byUse.has(use)) byUse.set(use, target);
    }
    for (const use of [
      '1 family dwelling',
      '2 family dwelling',
      'apartments',
      'residential hotel',
      'artist live/work',
    ]) {
      const sample = byUse.get(use);
      expect(sample, `${use} should exist on the extract`).toBeDefined();
      if (sample !== undefined) {
        expect(classifyUse(sample).classification).toBe('residential');
        expect(commercialUseGate(sample).passed).toBe(false);
      }
    }
  });

  it('keeps an unpublished use visible instead of dropping the record', () => {
    // 202408289673: filed, $280,000, zip 94124, and DBI published no use at all.
    const target = permit('202408289673');
    expect(target.existingUse).toBeNull();
    expect(target.proposedUse).toBeNull();
    const outcome = commercialUseGate(target);
    expect(outcome.passed).toBe(true);
    expect(outcome.reason).toContain('not published');
    expect(classifyUse(target).classification).toBe('unknown');
  });

  it('keeps a use outside both controlled lists visible rather than silently dropping it', () => {
    const unclassified = allPermits().find(
      (target) => classifyUse(target).classification === 'unclassified',
    );
    expect(unclassified, 'the extract contains uses in neither list, e.g. hospital').toBeDefined();
    if (unclassified !== undefined) {
      const outcome = commercialUseGate(unclassified);
      expect(outcome.passed).toBe(true);
      expect(outcome.reason).toContain('unconfirmed');
    }
  });

  it('counts a commercial hit on either side of a use conversion', () => {
    // 202509235962: existing use office, proposed use adult entertainment.
    const target = permit('202509235962');
    expect(target.existingUse).toBe('office');
    expect(target.proposedUse).toBe('adult entertainment');
    expect(classifyUse(target).classification).toBe('commercial');
  });
});

/* -------------------------------------------------------------------------- */
/* Gate 5: cost floor                                                         */
/* -------------------------------------------------------------------------- */

describe('cost floor gate', () => {
  it('rejects permit 202509235962 (739 Bryant St office) because $4,500 is under the floor', () => {
    const target = permit('202509235962');
    expect(target.valuation).toBe(4_500);
    const outcome = costFloorGate(target, mike);
    expect(outcome.passed).toBe(false);
    expect(outcome.gate).toBe('cost_floor');
    expect(outcome.reason).toBe(
      'Valuation $4,500 is below the $100,000 minimum project value.',
    );
  });

  it('permit 202509235962 fails ONLY at the cost gate', () => {
    expect(rejectedGates(permit('202509235962'))).toEqual(['cost_floor']);
  });

  it('rejects permit 202605080926 (1255 Battery St office) because no valuation was published', () => {
    // DBI wrote revised_cost "0.0" and no estimated_cost on this freshly filed permit.
    const target = permit('202605080926');
    expect(target.valuation).toBeNull();
    expect(target.valuationSource).toBe('none');
    const outcome = costFloorGate(target, mike);
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain('Valuation not published');
    expect(rejectedGates(target)).toEqual(['cost_floor']);
  });

  it('takes the larger of the two cost columns, because neither alone is reliable', () => {
    expect(permitValuation({ permitNumber: 'x', revisedCost: 0, estimatedCost: 250_000 })).toBe(
      250_000,
    );
    expect(permitValuation({ permitNumber: 'x', revisedCost: 900_000, estimatedCost: 250_000 })).toBe(
      900_000,
    );
    expect(permitValuation({ permitNumber: 'x', revisedCost: null, estimatedCost: null })).toBeNull();
  });

  it('accepts a valuation exactly on the floor', () => {
    const outcome = costFloorGate({ permitNumber: 'x', valuation: 100_000 }, mike);
    expect(outcome.passed).toBe(true);
  });

  it('formats money without locale drift', () => {
    expect(formatUsd(8_285_917)).toBe('$8,285,917');
    expect(formatUsd(100_000)).toBe('$100,000');
    expect(formatUsd(999)).toBe('$999');
  });
});

/* -------------------------------------------------------------------------- */
/* Gate 6: dedupe                                                             */
/* -------------------------------------------------------------------------- */

describe('dedupe gate', () => {
  it('mints a stable key that does not move with the clock', () => {
    const hero = permit(HERO);
    const early = runShortlistFilters(hero, mike, new Date('2026-04-15T00:00:00-07:00'));
    const late = runShortlistFilters(hero, mike, new Date('2026-12-31T00:00:00-07:00'));
    expect(early.dedupeKey).toBe(`permit:${HERO}`);
    expect(late.dedupeKey).toBe(early.dedupeKey);
    expect(late.nearDuplicateKey).toBe(early.nearDuplicateKey);
  });

  it('never lets the same permit number produce two candidates', () => {
    const hero = permit(HERO);
    const first = runShortlistFilters(hero, mike, NOW, { seenKeys: new Set<string>() });
    expect(first.passed).toBe(true);

    const seen = new Set<string>([first.dedupeKey, first.nearDuplicateKey]);
    const second = runShortlistFilters(hero, mike, NOW, { seenKeys: seen });
    expect(second.passed).toBe(false);
    expect(second.rejectedBy).toBe('dedupe');
    expect(second.outcomes[5]?.reason).toContain('already produced a candidate');
  });

  it('collapses the real re-filing pair 202604099172 / 202604179650 at 1854 Great Hy', () => {
    const first = permit('202604099172');
    const second = permit('202604179650');
    expect(first.address).toBe('1854 Great Hy');
    expect(second.address).toBe(first.address);
    expect(second.description).toBe(first.description);
    // Different permit numbers, so the primary key cannot catch this.
    expect(permitDedupeKey(first)).not.toBe(permitDedupeKey(second));

    const seen = new Set<string>([permitDedupeKey(first), nearDuplicateKey(first)]);
    const outcome = dedupeGate(second, seen);
    expect(outcome.passed).toBe(false);
    expect(outcome.reason).toContain('Duplicate re-filing');
    expect(outcome.reason).toContain('1854 great hy');
  });

  it('collapses the pair in either order, because replay does not guarantee filing order', () => {
    const first = permit('202605050699');
    const second = permit('202605292190');
    expect(first.address).toBe('856 Sunnydale Av');

    const forward = new Set<string>([permitDedupeKey(first), nearDuplicateKey(first)]);
    expect(dedupeGate(second, forward).passed).toBe(false);

    const backward = new Set<string>([permitDedupeKey(second), nearDuplicateKey(second)]);
    expect(dedupeGate(first, backward).passed).toBe(false);
  });

  it('does not collapse two different projects at different addresses', () => {
    const hero = permit(HERO);
    const other = permit('202604239978');
    const seen = new Set<string>([permitDedupeKey(hero), nearDuplicateKey(hero)]);
    expect(dedupeGate(other, seen).passed).toBe(true);
  });

  it('never collapses permits that publish neither an address nor a description', () => {
    const a = nearDuplicateKeys({ permitNumber: '111', address: null, description: null });
    const b = nearDuplicateKeys({ permitNumber: '222', address: null, description: null });
    expect(a[0]).not.toBe(b[0]);
    expect(new Set([...a, ...b]).size).toBe(a.length + b.length);
  });

  it('passes with no seen set supplied, because the caller owns the set', () => {
    expect(dedupeGate(permit(HERO)).passed).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* Whole extract                                                              */
/* -------------------------------------------------------------------------- */

describe('the whole real extract', () => {
  /** Run the extract the way the Lead Agent tick runs it: caller holds the set. */
  function shortlistWholeExtract(customer: CustomerProfile): NormalizedPermit[] {
    const seen = new Set<string>();
    const accepted: NormalizedPermit[] = [];
    for (const target of allPermits()) {
      const result = runShortlistFilters(target, customer, NOW, { seenKeys: seen });
      if (!result.passed) continue;
      seen.add(result.dedupeKey);
      seen.add(result.nearDuplicateKey);
      accepted.push(target);
    }
    return accepted;
  }

  const shortlist = shortlistWholeExtract(mike);

  it('produces a non-empty, non-trivial shortlist', () => {
    expect(shortlist.length).toBeGreaterThan(50);
    // Regression guard: measured at 714 on the committed extract.
    expect(shortlist.length).toBeGreaterThan(400);
    expect(shortlist.length).toBeLessThan(1_500);
  });

  it('filters hard: the shortlist is a small fraction of the 10,880 permits', () => {
    expect(shortlist.length / rawRows.length).toBeLessThan(0.15);
  });

  it('contains the hero permit', () => {
    expect(shortlist.some((target) => target.permitNumber === HERO)).toBe(true);
  });

  it('contains every backup hero permit', () => {
    const numbers = new Set(shortlist.map((target) => target.permitNumber));
    for (const backup of ['202607295760', '202604239978', '202604209747']) {
      expect(numbers.has(backup), `backup ${backup} should be shortlisted`).toBe(true);
    }
  });

  it('yields no duplicate permit numbers even though the extract holds 726 repeats', () => {
    const numbers = shortlist.map((target) => target.permitNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it('never shortlists a terminal status, a residential use, an excluded type, or a cheap job', () => {
    for (const target of shortlist) {
      expect(ACTIVE_PIPELINE_STATUSES.has(target.status ?? '')).toBe(true);
      expect(classifyUse(target).classification).not.toBe('residential');
      expect(projectTypeGate(target).passed).toBe(true);
      expect(target.valuation ?? 0).toBeGreaterThanOrEqual(mike.minProjectValue);
    }
  });

  it('shrinks when the territory narrows and stays a strict subset', () => {
    const districtOnly = shortlistWholeExtract(mikeDistrictRestricted);
    const cityWide = new Set(shortlist.map((target) => target.permitNumber));
    expect(districtOnly.length).toBeGreaterThan(0);
    expect(districtOnly.length).toBeLessThan(shortlist.length);
    for (const target of districtOnly) {
      expect(cityWide.has(target.permitNumber)).toBe(true);
      expect(target.supervisorDistrict).toBe('3');
    }
  });

  it('every rejection carries a reason worth rendering in the decision log', () => {
    let rejected = 0;
    for (const target of allPermits()) {
      const result = runShortlistFilters(target, mike, NOW);
      if (result.passed) continue;
      rejected += 1;
      const failure = result.outcomes.find((outcome) => !outcome.passed);
      expect(failure).toBeDefined();
      if (failure === undefined) continue;
      expect(failure.reason.length).toBeGreaterThan(20);
      expect(failure.reason.endsWith('.')).toBe(true);
      // Judge-facing copy: no em dashes, no technology talk.
      expect(failure.reason).not.toMatch(/—/);
      expect(failure.reason).not.toMatch(/\b(?:AI|LLM|agent|autonomous|automated)\b/i);
    }
    expect(rejected).toBeGreaterThan(9_000);
  });

  it('is pure: the same inputs give byte-identical results on a second pass', () => {
    const sample = allPermits().slice(0, 500);
    const first = sample.map((target) => runShortlistFilters(target, mike, NOW));
    const second = sample.map((target) => runShortlistFilters(target, mike, NOW));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
