/**
 * Findings: every evidence-labeled fact in the system (`findings`).
 *
 * Hard rule #3. A fact enters this codebase in exactly one way, as a Finding
 * carrying an evidence label of `verified | corroborated | inferred | unknown`.
 * There is no path that stores a bare value. A fact we looked for and could not
 * establish is stored as `value: null, evidence: 'unknown'` and stays visible in
 * the UI; it is never dropped and never replaced with a plausible guess.
 *
 * The write rule is monotonic. `(candidate_id, key)` is unique, and on conflict
 * an incoming Finding replaces the stored one ONLY when its evidence is strictly
 * stronger by `isStrongerEvidence` from core.ts. Two consequences worth stating
 * out loud:
 *
 * - Enrichment can run repeatedly and in any order. A CSLB lookup that returns
 *   `verified` wins over the `inferred` guess made from the permit description,
 *   whichever ran first.
 * - Evidence never degrades. A later pass that fails to reach a source cannot
 *   overwrite a `verified` fact with `unknown`, which is exactly the failure mode
 *   that would make the evidence labels untrustworthy.
 *
 * Equal-strength re-observation is a no-op by the same rule: `verified` does not
 * replace `verified`. The first authoritative answer stands, and re-running
 * enrichment cannot silently rewrite history under a judge mid-demo.
 */
import { z } from 'zod';

import {
  type EvidenceLabel,
  type Finding,
  evidenceLabelSchema,
  findingSchema,
  isStrongerEvidence,
} from '@/lib/domain/schemas/core';

import {
  dbTimestamp,
  isUniqueViolation,
  parseRow,
  parseRows,
  requireClient,
  unwrap,
  unwrapMaybe,
} from './client';

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

const findingRowSchema = z.object({
  id: z.string().min(1),
  candidate_id: z.string().min(1),
  key: z.string().min(1),
  label: z.string().min(1),
  // `jsonb` could hold anything; a Finding value may only be a scalar or null.
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  evidence: evidenceLabelSchema,
  source_id: z.string().nullable(),
  note: z.string(),
  observed_at: dbTimestamp,
});

/** A stored Finding: the domain type plus the row identity. */
export type FindingRecord = Omit<Finding, 'id'> & { id: string };

function toFinding(row: unknown, context: string): FindingRecord {
  const parsed = parseRow(findingRowSchema, row, context);
  return {
    id: parsed.id,
    candidateId: parsed.candidate_id,
    key: parsed.key,
    label: parsed.label,
    value: parsed.value,
    evidence: parsed.evidence,
    sourceId: parsed.source_id,
    note: parsed.note,
    observedAt: parsed.observed_at,
  };
}

/**
 * What an upsert did.
 *
 * `kept` is a normal, frequent outcome, not a failure. It means the stored fact
 * was at least as well evidenced as the incoming one.
 */
export type FindingWriteAction = 'inserted' | 'upgraded' | 'kept';

export interface UpsertFindingResult {
  finding: FindingRecord;
  action: FindingWriteAction;
  /** Evidence label already stored, when there was one. */
  previousEvidence: EvidenceLabel | null;
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Store a Finding, upgrading an existing one only on stronger evidence.
 *
 * The unique-violation retry handles the race where two enrichment passes insert
 * the same `(candidate_id, key)` at once: the loser re-reads and re-applies the
 * same monotonic rule, so concurrency cannot produce a weaker stored fact.
 */
export async function upsertFinding(finding: Finding): Promise<UpsertFindingResult> {
  return upsertFindingAttempt(finding, 0);
}

const MAX_RACE_RETRIES = 2;

async function upsertFindingAttempt(
  finding: Finding,
  attempt: number,
): Promise<UpsertFindingResult> {
  const validated = findingSchema.parse(finding);
  const client = requireClient('upsertFinding');

  const existing = await readFinding(validated.candidateId, validated.key);

  if (existing !== null) {
    if (!isStrongerEvidence(validated.evidence, existing.evidence)) {
      return { finding: existing, action: 'kept', previousEvidence: existing.evidence };
    }
    const row = unwrap(
      await client
        .from('findings')
        .update({
          label: validated.label,
          value: validated.value,
          evidence: validated.evidence,
          source_id: validated.sourceId,
          note: validated.note,
          observed_at: validated.observedAt,
        })
        .eq('id', existing.id)
        .select('*')
        .single(),
      'upsertFinding (upgrade)',
    );
    return {
      finding: toFinding(row, 'findings'),
      action: 'upgraded',
      previousEvidence: existing.evidence,
    };
  }

  const insert = await client
    .from('findings')
    .insert({
      candidate_id: validated.candidateId,
      key: validated.key,
      label: validated.label,
      value: validated.value,
      evidence: validated.evidence,
      source_id: validated.sourceId,
      note: validated.note,
      observed_at: validated.observedAt,
    })
    .select('*')
    .single();

  if (isUniqueViolation(insert.error) && attempt < MAX_RACE_RETRIES) {
    // Lost a race with a concurrent enrichment pass. Re-read and let the same
    // monotonic rule decide, rather than clobbering whatever landed first.
    return upsertFindingAttempt(validated, attempt + 1);
  }

  return {
    finding: toFinding(unwrap(insert, 'upsertFinding (insert)'), 'findings'),
    action: 'inserted',
    previousEvidence: null,
  };
}

/**
 * Store several Findings for one candidate.
 *
 * Sequential on purpose: each write reads the stored evidence label first, and
 * running them in parallel would race two facts with the same key against each
 * other for no useful gain at this volume.
 */
export async function upsertFindings(
  findings: readonly Finding[],
): Promise<UpsertFindingResult[]> {
  const results: UpsertFindingResult[] = [];
  for (const finding of findings) {
    results.push(await upsertFinding(finding));
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every fact known about a candidate, ordered by key.
 *
 * Stable ordering matters here: this list is rendered directly in the UI and
 * read by the deterministic scorer, and neither should change behaviour because
 * Postgres returned rows in a different physical order.
 */
export async function listFindings(candidateId: string): Promise<FindingRecord[]> {
  const client = requireClient('listFindings');
  const rows = unwrap(
    await client
      .from('findings')
      .select('*')
      .eq('candidate_id', candidateId)
      .order('key', { ascending: true }),
    'listFindings',
  );
  return parseRows(findingRowSchema, rows, 'findings').map((row) => toFinding(row, 'findings'));
}

/** One fact by candidate and key, or `null` when it has never been observed. */
export async function readFinding(
  candidateId: string,
  key: string,
): Promise<FindingRecord | null> {
  const client = requireClient('readFinding');
  const row = unwrapMaybe(
    await client
      .from('findings')
      .select('*')
      .eq('candidate_id', candidateId)
      .eq('key', key)
      .maybeSingle(),
    'readFinding',
  );
  return row === null ? null : toFinding(row, 'findings');
}
