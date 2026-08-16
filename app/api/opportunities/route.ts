/**
 * Opportunity feed. `GET /api/opportunities`
 *
 * The product, as JSON. One row per scored candidate, carrying everything a
 * dashboard card needs without a second request: the project it came off, the
 * deterministic score with the drivers that produced it, the customer-facing
 * copy, and where it sits in the pipeline.
 *
 * Four things this route is careful about:
 *
 * - **The score is reported, never computed.** The arithmetic lives in
 *   `lib/calculations/scoring/lead-score.ts` and ran long before this request
 *   (hard rule #2). All that happens here is comparing the stored score against
 *   the shared threshold constant so the UI and the Lead Agent cannot drift
 *   apart on what "delivered" means.
 * - **Fatal flags travel beside the score, never inside it.** They are a
 *   separate field in the response for the same reason they are a separate
 *   column: a disqualifier that gets averaged into a number stops being a
 *   disqualifier.
 * - **Replay is labelled.** Every permit block carries `replayed` straight off
 *   the stored provenance, which is what lets the UI badge the demo feed as
 *   real records on an accelerated clock (hard rule #5).
 * - **Unknowns stay visible.** A permit field the city never published comes
 *   back as `null`, and `?include=findings` returns each fact with its evidence
 *   label attached (hard rule #3). Nothing is filled in.
 *
 * Query parameters:
 *   `status`     `pending | delivered | archived`, default all
 *   `customerId` uuid, default all
 *   `limit`      1 to 50, default 25
 *   `include`    `findings` to attach the evidence list to each row
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { missingKeys } from '@/lib/config/deployment-env';
import { LEAD_SCORE_THRESHOLD, meetsDeliveryBar } from '@/lib/calculations/scoring/lead-score';
import { normalizedPermitSchema } from '@/lib/domain/permit-normalizer';
import { opportunityStatusSchema } from '@/lib/domain/schemas/core';
import {
  type CandidateRecord,
  type OpportunityRecord,
  type PermitRecord,
  getCandidate,
  getPermit,
  isStoreReady,
  listFindings,
  listOpportunities,
} from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* -------------------------------------------------------------------------- */
/* Query                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `limit` is capped at 50 because each row fans out into a candidate read and a
 * permit read. The cap is what keeps a card feed from turning into a hundred
 * round trips.
 */
const querySchema = z.object({
  status: opportunityStatusSchema.optional(),
  customerId: z.string().uuid('customerId must be a uuid').optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  include: z.enum(['findings']).optional(),
});

function jsonResponse(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/* -------------------------------------------------------------------------- */
/* Projection                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The permit facts a card shows, taken from the normalized projection rather
 * than the raw row so the reader never has to know that DataSF ships every
 * value, costs included, as a string.
 */
function permitBlock(permit: PermitRecord): Record<string, unknown> {
  const parsed = normalizedPermitSchema.safeParse(permit.normalized);

  const base = {
    permitNumber: permit.permitNumber,
    snapshotStatus: permit.snapshotStatus,
    /* Hard rule #5: the UI must be able to say when a record was replayed. */
    replayed: permit.provenance.replayed,
    sourceId: permit.provenance.sourceId,
    datasetId: permit.provenance.datasetId,
    retrievedAt: permit.provenance.retrievedAt,
    dataAsOf: permit.dataAsOf,
    firstSeenAt: permit.firstSeenAt,
    lastSeenAt: permit.lastSeenAt,
  };

  if (!parsed.success) {
    /* A projection written by an older normalizer is reported as unreadable
     * rather than patched up from the raw row, which would be a guess. */
    console.warn(`[opportunities] permit ${permit.permitNumber} has an unreadable projection`);
    return { ...base, normalizedReadable: false };
  }

  const normalized = parsed.data;
  return {
    ...base,
    normalizedReadable: true,
    address: normalized.address,
    neighborhood: normalized.neighborhood,
    supervisorDistrict: normalized.supervisorDistrict,
    zipcode: normalized.zipcode,
    latitude: normalized.latitude,
    longitude: normalized.longitude,
    status: normalized.status,
    permitTypeDefinition: normalized.permitTypeDefinition,
    description: normalized.description,
    existingUse: normalized.existingUse,
    proposedUse: normalized.proposedUse,
    storiesExisting: normalized.storiesExisting,
    valuation: normalized.valuation,
    /* Which cost column won, so a $0 revised_cost cannot masquerade as a fact. */
    valuationSource: normalized.valuationSource,
    filedDate: normalized.filedDate,
    issuedDate: normalized.issuedDate,
    approvedDate: normalized.approvedDate,
  };
}

function opportunityBlock(
  opportunity: OpportunityRecord,
  candidate: CandidateRecord | null,
  permit: PermitRecord | null,
  findings: Record<string, unknown>[] | null,
): Record<string, unknown> {
  const block: Record<string, unknown> = {
    id: opportunity.id,
    candidateId: opportunity.candidateId,
    customerId: opportunity.customerId,
    status: opportunity.status,
    score: opportunity.score,
    /* Same constant the Lead Agent gates on. One source of truth for "80". */
    threshold: LEAD_SCORE_THRESHOLD,
    meetsDeliveryBar: meetsDeliveryBar({
      score: opportunity.score,
      drivers: opportunity.drivers,
      warnings: opportunity.warnings,
      fatalFlags: opportunity.fatalFlags,
    }),
    drivers: opportunity.drivers,
    warnings: opportunity.warnings,
    fatalFlags: opportunity.fatalFlags,
    summary: opportunity.summary,
    bestPathIn: opportunity.bestPathIn,
    recommendedAction: opportunity.recommendedAction,
    deliveredAt: opportunity.deliveredAt,
    feedback: opportunity.feedback,
    feedbackAt: opportunity.feedbackAt,
    createdAt: opportunity.createdAt,
    stage: candidate === null ? null : candidate.stage,
    shortlistReason: candidate === null ? null : candidate.shortlistReason,
    permit: permit === null ? null : permitBlock(permit),
  };
  if (findings !== null) block['findings'] = findings;
  return block;
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

export async function GET(request: Request): Promise<NextResponse> {
  const params = new URL(request.url).searchParams;
  const parsed = querySchema.safeParse({
    status: params.get('status') ?? undefined,
    customerId: params.get('customerId') ?? undefined,
    limit: params.get('limit') ?? undefined,
    include: params.get('include') ?? undefined,
  });

  if (!parsed.success) {
    return jsonResponse(
      {
        error: 'invalid_query',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      400,
    );
  }

  if (!isStoreReady()) {
    return jsonResponse(
      {
        error: 'store_unconfigured',
        message: 'Persistence is not configured, so there are no opportunities to read.',
        missing: missingKeys('supabase'),
      },
      503,
    );
  }

  const { status, customerId, limit, include } = parsed.data;

  try {
    const opportunities = await listOpportunities({
      ...(status === undefined ? {} : { status }),
      ...(customerId === undefined ? {} : { customerId }),
      limit,
    });

    /* Candidates and permits are fetched once each and shared across rows: a
     * rescored permit can back several opportunities over a demo. */
    const candidateIds = [...new Set(opportunities.map((row) => row.candidateId))];
    const candidateEntries = await Promise.all(
      candidateIds.map(async (id) => [id, await getCandidate(id)] as const),
    );
    const candidateById = new Map(candidateEntries);

    const permitNumbers = [
      ...new Set(
        candidateEntries
          .map(([, candidate]) => candidate)
          .filter((candidate): candidate is CandidateRecord => candidate !== null)
          .map((candidate) => candidate.permitNumber),
      ),
    ];
    const permitByNumber = new Map(
      await Promise.all(permitNumbers.map(async (key) => [key, await getPermit(key)] as const)),
    );

    const rows = await Promise.all(
      opportunities.map(async (opportunity) => {
        const candidate = candidateById.get(opportunity.candidateId) ?? null;
        const permit =
          candidate === null ? null : (permitByNumber.get(candidate.permitNumber) ?? null);

        const findings =
          include === 'findings'
            ? (await listFindings(opportunity.candidateId)).map((finding) => ({
                key: finding.key,
                label: finding.label,
                value: finding.value,
                /* verified | corroborated | inferred | unknown, always shown. */
                evidence: finding.evidence,
                sourceId: finding.sourceId,
                note: finding.note,
                observedAt: finding.observedAt,
              }))
            : null;

        return opportunityBlock(opportunity, candidate, permit, findings);
      }),
    );

    return jsonResponse(
      {
        opportunities: rows,
        count: rows.length,
        limit,
        threshold: LEAD_SCORE_THRESHOLD,
        filters: {
          status: status ?? null,
          customerId: customerId ?? null,
          include: include ?? null,
        },
        generatedAt: new Date().toISOString(),
      },
      200,
    );
  } catch (error) {
    console.error('[opportunities] read failed:', error);
    return jsonResponse(
      { error: 'store_unavailable', message: 'Opportunities could not be read.' },
      503,
    );
  }
}
