/**
 * Snapshot diff tests, driven by the committed REAL extract.
 *
 * The previous/current snapshot sets below are built from actual rows in
 * `data/permits.json` and normalized through the real normalizer, so the diff is
 * exercised against the field shapes it will see in production rather than
 * against a hand-written fixture (CLAUDE.md hard rule #5).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  contentHash,
  normalizePermit,
  type NormalizedPermit,
} from '@/lib/domain/permit-normalizer';

import {
  actionableKeys,
  deltasWithStatus,
  diffFields,
  diffSnapshots,
  observed,
  summarizeDeltas,
  type ObservedRecord,
  type PreviousSnapshot,
} from './snapshot-diff';

const PERMITS_PATH = fileURLToPath(new URL('../../data/permits.json', import.meta.url));
const RAW_PERMITS = JSON.parse(readFileSync(PERMITS_PATH, 'utf8')) as Record<string, unknown>[];

const OBSERVED_AT = '2026-08-15T09:00:00.000-07:00';

/**
 * The extract carries 10,880 rows across only 10,049 distinct permit numbers:
 * DBI publishes one row per address when a permit covers an address range. The
 * diff keys on permit number, so the snapshot fixtures collapse to one row per
 * key first, exactly the way the ingestion worker has to.
 */
const UNIQUE_ROWS: Record<string, unknown>[] = (() => {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of RAW_PERMITS) {
    const key = String(row.permit_number ?? '');
    if (key.length > 0 && !byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()];
})();

/** First 25 distinct real permits, normalized. Deterministic slice, no randomness. */
const SAMPLE: NormalizedPermit[] = UNIQUE_ROWS.slice(0, 25).map((row) => normalizePermit(row));

function toObserved(permit: NormalizedPermit): ObservedRecord<NormalizedPermit> {
  return observed(permit.permitNumber, contentHash(permit), permit);
}

function toPrevious(permit: NormalizedPermit): PreviousSnapshot<NormalizedPermit> {
  return { key: permit.permitNumber, contentHash: contentHash(permit), fields: permit };
}

function permitAt(index: number): NormalizedPermit {
  const permit = SAMPLE[index];
  if (permit === undefined) throw new Error(`Sample has no permit at index ${index}`);
  return permit;
}

/* -------------------------------------------------------------------------- */

describe('diffSnapshots', () => {
  it('reports nothing when the same real rows come back unchanged', () => {
    const deltas = diffSnapshots({
      previous: SAMPLE.map(toPrevious),
      current: SAMPLE.map(toObserved),
      observedAt: OBSERVED_AT,
    });
    expect(deltas).toEqual([]);
  });

  it('classifies added, changed, and not_observed in one pass', () => {
    // Previous snapshot: rows 0..19. Current pull: rows 1..24, with row 5 moved
    // from filed to issued. So row 0 is unobserved, rows 20..24 are new, row 5
    // changed, and everything else is untouched.
    const previous = SAMPLE.slice(0, 20).map(toPrevious);

    const mutated: NormalizedPermit = {
      ...permitAt(5),
      status: 'issued',
      issuedDate: '2026-08-14T10:15:00.000-07:00',
    };

    const current = [
      ...SAMPLE.slice(1, 5).map(toObserved),
      toObserved(mutated),
      ...SAMPLE.slice(6, 25).map(toObserved),
    ];

    const deltas = diffSnapshots({ previous, current, observedAt: OBSERVED_AT });

    expect(summarizeDeltas(deltas)).toEqual({ added: 5, changed: 1, not_observed: 1 });

    const added = deltasWithStatus(deltas, 'added').map((delta) => delta.key);
    expect(added).toEqual(SAMPLE.slice(20, 25).map((permit) => permit.permitNumber));

    const changed = deltasWithStatus(deltas, 'changed');
    expect(changed.length).toBe(1);
    expect(changed[0]?.key).toBe(permitAt(5).permitNumber);
    expect(changed[0]?.changedFields).toEqual(['issuedDate', 'status']);
    expect(changed[0]?.contentHash).toBe(contentHash(mutated));
    expect(changed[0]?.observedAt).toBe(OBSERVED_AT);

    const notObserved = deltasWithStatus(deltas, 'not_observed');
    expect(notObserved.length).toBe(1);
    expect(notObserved[0]?.key).toBe(permitAt(0).permitNumber);
    expect(notObserved[0]?.changedFields).toEqual([]);
    // not_observed means "did not come back", so the hash is the last one we
    // could stand behind, not a new observation.
    expect(notObserved[0]?.contentHash).toBe(contentHash(permitAt(0)));
  });

  it('does not treat not_observed as deletion or as actionable work', () => {
    const deltas = diffSnapshots({
      previous: SAMPLE.slice(0, 3).map(toPrevious),
      current: [toObserved(permitAt(0))],
      observedAt: OBSERVED_AT,
    });

    const statuses = deltas.map((delta) => delta.status);
    expect(statuses).toEqual(['not_observed', 'not_observed']);
    expect(statuses).not.toContain('deleted');
    expect(actionableKeys(deltas)).toEqual([]);
  });

  it('suppresses not_observed when the pull was deliberately partial', () => {
    const deltas = diffSnapshots({
      previous: SAMPLE.slice(0, 10).map(toPrevious),
      current: [toObserved(permitAt(0))],
      observedAt: OBSERVED_AT,
      reportNotObserved: false,
    });
    expect(deltas).toEqual([]);
  });

  it('detects a change from the hash alone when the previous body is not stored', () => {
    const before = permitAt(2);
    const after: NormalizedPermit = { ...before, valuation: (before.valuation ?? 0) + 1_000 };

    const deltas = diffSnapshots({
      previous: [{ key: before.permitNumber, contentHash: contentHash(before) }],
      current: [toObserved(after)],
      observedAt: OBSERVED_AT,
    });

    expect(deltas.length).toBe(1);
    expect(deltas[0]?.status).toBe('changed');
    // We know THAT it changed; without the old body we do not claim WHAT changed.
    expect(deltas[0]?.changedFields).toEqual([]);
  });

  it('emits added and changed in current order, then not_observed', () => {
    const previous = [toPrevious(permitAt(0)), toPrevious(permitAt(1))];
    const changedFirst: NormalizedPermit = { ...permitAt(1), status: 'complete' };
    const current = [toObserved(permitAt(3)), toObserved(changedFirst)];

    const deltas = diffSnapshots({ previous, current, observedAt: OBSERVED_AT });
    expect(deltas.map((delta) => [delta.key, delta.status])).toEqual([
      [permitAt(3).permitNumber, 'added'],
      [permitAt(1).permitNumber, 'changed'],
      [permitAt(0).permitNumber, 'not_observed'],
    ]);
  });

  it('ignores duplicate keys within a pull, first occurrence wins', () => {
    const duplicate: NormalizedPermit = { ...permitAt(4), status: 'cancelled' };
    const deltas = diffSnapshots({
      previous: [],
      current: [toObserved(permitAt(4)), toObserved(duplicate)],
      observedAt: OBSERVED_AT,
    });
    expect(deltas.length).toBe(1);
    expect(deltas[0]?.contentHash).toBe(contentHash(permitAt(4)));
  });

  it('collapses the real address-range rows that share one permit number', () => {
    // 202304296759 is published twice in the extract, once per street number.
    // Two rows, two hashes, one key: the diff must emit a single delta and must
    // not report the second row as a change to the first.
    const rows = RAW_PERMITS.filter((row) => row.permit_number === '202304296759').map((row) =>
      normalizePermit(row),
    );
    expect(rows.length).toBe(2);
    const [first, second] = rows;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(contentHash(first as NormalizedPermit)).not.toBe(
      contentHash(second as NormalizedPermit),
    );

    const deltas = diffSnapshots({
      previous: [],
      current: rows.map(toObserved),
      observedAt: OBSERVED_AT,
    });
    expect(deltas.length).toBe(1);
    expect(deltas[0]?.status).toBe('added');
    expect(deltas[0]?.contentHash).toBe(contentHash(first as NormalizedPermit));
  });

  it('rejects an observedAt without an offset', () => {
    expect(() =>
      diffSnapshots({ previous: [], current: [], observedAt: '2026-08-15 09:00:00' }),
    ).toThrow();
  });

  it('scales over the full real extract', () => {
    const all = UNIQUE_ROWS.map((row) => normalizePermit(row));
    expect(all.length).toBe(10_049);

    const previous = all.slice(0, 10_000).map(toPrevious);
    const current = all.slice(500).map(toObserved);

    const deltas = diffSnapshots({ previous, current, observedAt: OBSERVED_AT });

    expect(summarizeDeltas(deltas)).toEqual({
      added: all.length - 10_000,
      changed: 0,
      not_observed: 500,
    });
  });
});

describe('diffFields', () => {
  it('names differing fields, sorted, and treats absence as a difference', () => {
    expect(diffFields({ a: 1, b: 2 }, { a: 1, b: 3 })).toEqual(['b']);
    expect(diffFields({ z: 1, a: 1 }, { z: 2, a: 2 })).toEqual(['a', 'z']);
    expect(diffFields({ a: 1 }, {})).toEqual(['a']);
    expect(diffFields({}, { a: null })).toEqual(['a']);
    expect(diffFields({ a: null }, { a: null })).toEqual([]);
  });

  it('compares nested values structurally, not by key order', () => {
    expect(diffFields({ a: { x: 1, y: 2 } }, { a: { y: 2, x: 1 } })).toEqual([]);
    expect(diffFields({ a: { x: 1 } }, { a: { x: 2 } })).toEqual(['a']);
  });
});
