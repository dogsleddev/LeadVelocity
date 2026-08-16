/**
 * Permit normalizer tests, run against the committed REAL extract.
 *
 * No fixtures are invented here (CLAUDE.md hard rule #5). Every row these tests
 * assert on is a real San Francisco building permit from
 * `data/permits.json` (10,880 rows, filed_date > 2026-02-15), including the
 * demo's hero permit at 555 California St.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  SF_TIME_ZONE,
  assembleAddress,
  canonicalJson,
  coerceInteger,
  coerceNumber,
  coerceText,
  contentHash,
  extractCoordinates,
  normalizeAgencyTimestamp,
  normalizePermit,
  normalizedPermitSchema,
  resolveValuation,
  safeNormalizePermit,
  toFloatingTimestamp,
  type NormalizedPermit,
} from './permit-normalizer';

/* -------------------------------------------------------------------------- */
/* Real data                                                                  */
/* -------------------------------------------------------------------------- */

const PERMITS_PATH = fileURLToPath(new URL('../../data/permits.json', import.meta.url));
const RAW_PERMITS = JSON.parse(readFileSync(PERMITS_PATH, 'utf8')) as Record<string, unknown>[];

/** The demo turns on this record. */
const HERO_PERMIT_NUMBER = '202603238106';
/** Real row where DBI wrote revised_cost "0.0" and estimated_cost "150000". */
const ZERO_REVISED_PERMIT_NUMBER = '202602176033';
/** Real row with neither cost column populated. */
const NO_COST_PERMIT_NUMBER = '202602186088';
/** Real row carrying a street_number_suffix and a genuine unit. */
const SUFFIXED_PERMIT_NUMBER = '202605221794';

function rawPermit(permitNumber: string): Record<string, unknown> {
  const row = RAW_PERMITS.find((candidate) => candidate.permit_number === permitNumber);
  if (row === undefined) throw new Error(`Permit ${permitNumber} is not in the committed extract`);
  return row;
}

/* -------------------------------------------------------------------------- */

describe('committed extract', () => {
  it('is the real 10,880 row SF pull', () => {
    expect(Array.isArray(RAW_PERMITS)).toBe(true);
    expect(RAW_PERMITS.length).toBe(10_880);
  });
});

describe('normalizePermit / hero permit 202603238106', () => {
  const hero = normalizePermit(rawPermit(HERO_PERMIT_NUMBER));

  it('carries identity and address assembled from the split columns', () => {
    expect(hero.permitNumber).toBe(HERO_PERMIT_NUMBER);
    expect(hero.recordId).toBe('1745632298587');
    // unit is "0" on this row, which means "no unit" and must not reach the address.
    expect(hero.address).toBe('555 California St');
  });

  it('reports the geography the shortlist filters on', () => {
    expect(hero.neighborhood).toBe('Financial District/South Beach');
    expect(hero.supervisorDistrict).toBe('3');
    expect(hero.zipcode).toBe('94104');
  });

  it('has coordinates lifted out of the GeoJSON point', () => {
    expect(hero.latitude).not.toBeNull();
    expect(hero.longitude).not.toBeNull();
    expect(hero.latitude).toBeCloseTo(37.792579585, 6);
    expect(hero.longitude).toBeCloseTo(-122.403518141, 6);
  });

  it('values the project at the real 8,285,917 from the revised column', () => {
    expect(hero.valuation).toBe(8_285_917);
    expect(hero.valuationSource).toBe('revised');
  });

  it('is an issued office alteration', () => {
    expect(hero.status).toBe('issued');
    expect(hero.permitTypeDefinition).toBe('otc alterations permit');
    expect(hero.existingUse).toBe('office');
    expect(hero.proposedUse).toBe('office');
    expect(hero.existingOccupancy).toBe('B');
    expect(hero.storiesExisting).toBe(52);
    expect(hero.storiesProposed).toBe(52);
  });

  it('keeps the description verbatim so the scope language survives', () => {
    expect(hero.description).toContain('lighting, power and communication fixtures');
  });

  it('renders every date as ISO-8601 with a real Pacific offset', () => {
    expect(hero.filedDate).toBe('2026-03-23T14:30:55.000-07:00');
    expect(hero.issuedDate).toBe('2026-04-10T15:03:06.000-07:00');
    expect(hero.approvedDate).toBe('2026-04-10T15:03:06.000-07:00');
    expect(hero.statusDate).toBe('2026-04-10T15:03:06.000-07:00');
    // 30.0% coverage across the extract; this permit is not complete.
    expect(hero.completedDate).toBeNull();
    expect(hero.dataAsOf).toBe('2026-04-12T01:05:02.000-07:00');
    expect(hero.dataLoadedAt).toBe('2026-04-12T05:30:44.519-07:00');
  });

  it('satisfies its own schema', () => {
    expect(() => normalizedPermitSchema.parse(hero)).not.toThrow();
  });
});

describe('valuation', () => {
  it('falls back to estimated_cost when DBI wrote revised_cost "0.0"', () => {
    const raw = rawPermit(ZERO_REVISED_PERMIT_NUMBER);
    expect(raw.revised_cost).toBe('0.0');
    expect(raw.estimated_cost).toBe('150000');

    const permit = normalizePermit(raw);
    expect(permit.valuation).toBe(150_000);
    expect(permit.valuationSource).toBe('estimated');
  });

  it('reports unknown rather than zero when neither cost column exists', () => {
    const raw = rawPermit(NO_COST_PERMIT_NUMBER);
    expect(raw.revised_cost).toBeUndefined();
    expect(raw.estimated_cost).toBeUndefined();

    const permit = normalizePermit(raw);
    expect(permit.valuation).toBeNull();
    expect(permit.valuationSource).toBe('none');
  });

  it('takes the larger of the two coerced costs and credits the right column', () => {
    expect(resolveValuation('1.0', '10.0')).toEqual({
      valuation: 10,
      valuationSource: 'estimated',
    });
    expect(resolveValuation('9000000', '8285917.0')).toEqual({
      valuation: 9_000_000,
      valuationSource: 'revised',
    });
    // Tie goes to revised: it is the column the city updates last.
    expect(resolveValuation('500000', '500000')).toEqual({
      valuation: 500_000,
      valuationSource: 'revised',
    });
    expect(resolveValuation('0.0', '0.0')).toEqual({ valuation: null, valuationSource: 'none' });
    expect(resolveValuation(undefined, undefined)).toEqual({
      valuation: null,
      valuationSource: 'none',
    });
  });
});

describe('coercion of string-typed Socrata values', () => {
  it('never trusts typeof', () => {
    expect(coerceNumber('8285917.0')).toBe(8_285_917);
    expect(coerceNumber(8_285_917)).toBe(8_285_917);
    expect(coerceNumber('$1,250,000')).toBe(1_250_000);
    expect(coerceNumber('')).toBeNull();
    expect(coerceNumber('n/a')).toBeNull();
    expect(coerceNumber(null)).toBeNull();
    expect(coerceNumber(Number.NaN)).toBeNull();
    expect(coerceInteger('4.0')).toBe(4);
    expect(coerceInteger('52')).toBe(52);
    expect(coerceText('  office  ')).toBe('office');
    expect(coerceText('   ')).toBeNull();
    expect(coerceText(undefined)).toBeNull();
  });
});

describe('address assembly', () => {
  it('joins the street number suffix without a space and keeps a real unit', () => {
    const permit = normalizePermit(rawPermit(SUFFIXED_PERMIT_NUMBER));
    expect(permit.address).toBe('1310B Scott St Unit 39');
  });

  it('drops placeholder unit values', () => {
    expect(
      assembleAddress({ streetNumber: '555', streetName: 'California', streetSuffix: 'St', unit: '0' }),
    ).toBe('555 California St');
    expect(
      assembleAddress({
        streetNumber: '100',
        streetName: 'Stockton',
        streetSuffix: 'St',
        unit: '2',
        unitSuffix: 'A',
      }),
    ).toBe('100 Stockton St Unit 2 A');
  });

  it('returns null when there is nothing to assemble', () => {
    expect(assembleAddress({})).toBeNull();
  });
});

describe('timestamp normalization', () => {
  it('resolves Pacific standard and daylight time from the wall clock alone', () => {
    // 2026 DST window is 8 March to 1 November.
    expect(normalizeAgencyTimestamp('2026-02-17T11:43:56.000')).toBe('2026-02-17T11:43:56.000-08:00');
    expect(normalizeAgencyTimestamp('2026-03-23T14:30:55.000')).toBe('2026-03-23T14:30:55.000-07:00');
    expect(normalizeAgencyTimestamp('2026-12-01T00:00:00.000')).toBe('2026-12-01T00:00:00.000-08:00');
  });

  it('accepts date-only and already-absolute values', () => {
    expect(normalizeAgencyTimestamp('2026-03-23')).toBe('2026-03-23T00:00:00.000-07:00');
    expect(normalizeAgencyTimestamp('2026-03-23T21:30:55Z')).toBe('2026-03-23T14:30:55.000-07:00');
  });

  it('returns null for anything it cannot parse instead of guessing', () => {
    expect(normalizeAgencyTimestamp(undefined)).toBeNull();
    expect(normalizeAgencyTimestamp('')).toBeNull();
    expect(normalizeAgencyTimestamp('not a date')).toBeNull();
    expect(normalizeAgencyTimestamp('2026-13-45T00:00:00.000')).toBeNull();
    expect(normalizeAgencyTimestamp(20_260_323)).toBeNull();
  });

  it('renders the offset-free literal SoQL compares against', () => {
    expect(toFloatingTimestamp('2026-04-12T01:05:02.000')).toBe('2026-04-12T01:05:02.000');
    expect(toFloatingTimestamp('2026-04-12T08:05:02.000Z')).toBe('2026-04-12T01:05:02.000');
  });
});

describe('coordinates', () => {
  it('is null for the three real rows that carry no location', () => {
    const locationless = RAW_PERMITS.filter((row) => row.location === undefined);
    expect(locationless.length).toBe(3);
    for (const row of locationless) {
      const permit = normalizePermit(row);
      expect(permit.latitude).toBeNull();
      expect(permit.longitude).toBeNull();
    }
  });

  it('rejects malformed and out-of-range GeoJSON rather than storing nonsense', () => {
    expect(extractCoordinates(undefined)).toEqual({ latitude: null, longitude: null });
    expect(extractCoordinates({ type: 'Point', coordinates: [] })).toEqual({
      latitude: null,
      longitude: null,
    });
    expect(extractCoordinates({ type: 'Polygon', coordinates: [1, 2] })).toEqual({
      latitude: null,
      longitude: null,
    });
    expect(extractCoordinates({ type: 'Point', coordinates: [-999, 999] })).toEqual({
      latitude: null,
      longitude: null,
    });
    // Socrata could start sending coordinates as strings; that must still work.
    expect(extractCoordinates({ type: 'Point', coordinates: ['-122.4', '37.79'] })).toEqual({
      longitude: -122.4,
      latitude: 37.79,
    });
  });
});

describe('contentHash', () => {
  const hero = normalizePermit(rawPermit(HERO_PERMIT_NUMBER));

  it('is stable across key reordering', () => {
    const reversed = Object.fromEntries(
      Object.entries(hero).reverse(),
    ) as unknown as NormalizedPermit;

    // Proves the reordering actually happened, so the test is not vacuous.
    expect(Object.keys(reversed)).not.toEqual(Object.keys(hero));
    expect(JSON.stringify(reversed)).not.toBe(JSON.stringify(hero));

    expect(contentHash(reversed)).toBe(contentHash(hero));
  });

  it('is stable across repeated normalization of the same row', () => {
    expect(contentHash(normalizePermit(rawPermit(HERO_PERMIT_NUMBER)))).toBe(contentHash(hero));
  });

  it('changes when any field changes', () => {
    expect(contentHash({ ...hero, status: 'complete' })).not.toBe(contentHash(hero));
    expect(contentHash({ ...hero, valuation: 8_285_918 })).not.toBe(contentHash(hero));
    expect(contentHash({ ...hero, completedDate: '2026-05-01T00:00:00.000-07:00' })).not.toBe(
      contentHash(hero),
    );
  });

  it('is a sha256 hex digest', () => {
    expect(contentHash(hero)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('canonical JSON sorts keys recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson({ a: { c: 3, d: 2 }, b: 1 })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe('the whole extract', () => {
  it('normalizes every one of the 10,880 real rows without throwing', () => {
    let failures = 0;
    let withValuation = 0;
    let withIssuedDate = 0;

    for (const row of RAW_PERMITS) {
      const result = safeNormalizePermit(row);
      if (!result.ok) {
        failures += 1;
        continue;
      }
      if (result.permit.valuation !== null) withValuation += 1;
      if (result.permit.issuedDate !== null) withIssuedDate += 1;
    }

    expect(failures).toBe(0);
    // Coverage stays in the band measured on the extract; a normalizer regression
    // that quietly nulls a column shows up here instead of in the demo.
    expect(withValuation / RAW_PERMITS.length).toBeGreaterThan(0.9);
    expect(withIssuedDate / RAW_PERMITS.length).toBeGreaterThan(0.8);
  });

  it('gives distinct permits distinct hashes', () => {
    const hashes = new Map<string, string>();
    for (const row of RAW_PERMITS.slice(0, 2_000)) {
      const permit = normalizePermit(row);
      hashes.set(permit.permitNumber, contentHash(permit));
    }
    expect(new Set(hashes.values()).size).toBe(hashes.size);
  });

  it('does not assume permit_number is unique, because in this dataset it is not', () => {
    // Measured on the committed extract: 10,880 rows carry only 10,049 distinct
    // permit numbers. DBI issues one permit across an address range and
    // publishes a row per address, so 726 permit numbers appear more than once.
    // `permit_records.permit_number` is a primary key, so ingestion has to
    // collapse these deliberately rather than upsert blindly.
    const byPermitNumber = new Map<string, Record<string, unknown>[]>();
    for (const row of RAW_PERMITS) {
      const key = String(row.permit_number);
      const bucket = byPermitNumber.get(key);
      if (bucket === undefined) byPermitNumber.set(key, [row]);
      else bucket.push(row);
    }
    expect(RAW_PERMITS.length).toBe(10_880);
    expect(byPermitNumber.size).toBe(10_049);

    const repeated = byPermitNumber.get('202304296759');
    expect(repeated?.length).toBe(2);
    const [first, second] = (repeated ?? []).map((row) => normalizePermit(row));
    expect(first?.permitNumber).toBe(second?.permitNumber);
    // Same permit, two addresses in the range: 272 and 274 Chattanooga-style rows.
    expect(first?.address).not.toBe(second?.address);
    expect(contentHash(first as NormalizedPermit)).not.toBe(
      contentHash(second as NormalizedPermit),
    );
  });

  it('rejects a row with no permit number instead of inventing one', () => {
    expect(() => normalizePermit({ street_name: 'California' })).toThrow();
    expect(safeNormalizePermit({ permit_number: '   ' }).ok).toBe(false);
  });

  it('uses America/Los_Angeles as the declared agency zone', () => {
    expect(SF_TIME_ZONE).toBe('America/Los_Angeles');
  });
});
