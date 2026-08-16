/**
 * The CEO Agent: read the company's own numbers, make one allocation call.
 *
 * WHAT THIS IS
 * ------------
 * The only agent that looks at the business rather than at a record. Once every
 * few minutes it reads three tables (`subscriptions`, `opportunities`, and the
 * permits behind them) plus the decision log, computes segment economics from
 * what actually happened, and makes exactly ONE decision: which building-use
 * segment the Sales Agent should target next.
 *
 * ONE DECISION, ON PURPOSE
 * ------------------------
 * A CEO that emits eight observations per tick is a dashboard, not an executive.
 * The tick logs the economics it computed and then commits to a single
 * reallocation, which is the thing the rest of the company can actually act on.
 *
 * REAL RUN DATA ONLY
 * ------------------
 * Every number here is counted from rows this company produced. There is no
 * canned example, no illustrative segment, and no projection. When there is not
 * enough run data to separate two segments, the tick says so and holds the
 * previous allocation rather than inventing a preference (hard rules #3 and #5).
 *
 * WHERE THE DECISION IS PERSISTED
 * -------------------------------
 * In `events`, as an `allocation.set` row whose `refs` carry the segment and the
 * numbers that chose it. That is deliberate rather than lazy: the events table is
 * append-only, indexed on (agent, ts), already read by the dashboard, and it
 * makes the allocation history free. {@link readCurrentAllocation} is the typed
 * accessor the dashboard uses, so no caller has to know the shape of a ref bag.
 *
 * DETERMINISTIC
 * -------------
 * No model is called. {@link rankSegments} and {@link chooseAllocation} are pure
 * functions of the counted rows, so "why that segment" is answerable by
 * arithmetic a judge can redo from the numbers in the summary.
 */
import { envInt, monthlyPriceUsd } from '@/lib/config/deployment-env';
import { normalizedPermitSchema } from '@/lib/domain/permit-normalizer';
import type { Feedback } from '@/lib/domain/schemas/core';
import {
  getCandidate,
  getPermit,
  getSubscriptionByCustomer,
  listCustomers,
  listEvents,
  listOpportunities,
  type OpportunityRecord,
} from '@/lib/store';

import { formatUsd, round2, runTick, type TickContext, type TickResult } from './tick';

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

/** How many opportunities the economics pass reads. */
const sampleSize = (): number => envInt('CEO_SAMPLE_SIZE', 60);

/** How far back `readCurrentAllocation` scans the log. */
const historyLimit = (): number => envInt('CEO_HISTORY_LIMIT', 100);

/** Label used when a permit publishes no building use at all. */
export const UNPUBLISHED_SEGMENT = 'use not published';

/* -------------------------------------------------------------------------- */
/* Counted economics                                                          */
/* -------------------------------------------------------------------------- */

/** What the company earned and produced, counted from its own rows. */
export interface CompanyEconomics {
  /** Customers with a Stripe subscription in `active`. */
  activeSubscribers: number;
  /** Customers on the books in any state. */
  totalCustomers: number;
  /** Monthly recurring revenue in whole dollars: active subscribers times price. */
  mrrUsd: number;
  delivered: number;
  archived: number;
  pending: number;
  /** Delivered opportunities carrying a reply. */
  replies: number;
  /** Replies of `good`. */
  accepted: number;
  /** Opportunities the segment pass could attribute to a building use. */
  attributed: number;
  /** Opportunities read this pass. */
  sampled: number;
}

/** One building-use segment's record, counted from delivered and archived rows. */
export interface SegmentEconomics {
  /** The building use as the agency publishes it, e.g. `office`, `retail sales`. */
  segment: string;
  delivered: number;
  archived: number;
  accepted: number;
  /** Replies of `too_small` or `wrong_scope`. */
  rejected: number;
  /** Mean score of the delivered opportunities in this segment. */
  meanScore: number;
  /** Deterministic ranking score. See {@link SEGMENT_WEIGHTS}. */
  rank: number;
}

/**
 * Weights behind the ranking score, stated as constants so the arithmetic in the
 * decision summary can be checked against them.
 *
 * A delivered opportunity is a unit of production. An accepted one is worth three
 * of those, because a reply of `good` is the only direct evidence the company has
 * that a segment converts. A rejection costs two, because a subscriber telling us
 * a segment is wrong is equally direct evidence in the other direction. An
 * archive costs a quarter: it means effort spent on a permit that never shipped,
 * which is real but cheap.
 */
export const SEGMENT_WEIGHTS = Object.freeze({
  delivered: 1,
  accepted: 3,
  rejected: -2,
  archived: -0.25,
});

/** The allocation the company is currently running on. */
export interface Allocation {
  segment: string;
  rank: number;
  delivered: number;
  accepted: number;
  archived: number;
  /** When the decision was written. */
  decidedAt: string;
}

/* -------------------------------------------------------------------------- */
/* Pure ranking                                                               */
/* -------------------------------------------------------------------------- */

/** Accumulator used while walking the opportunity sample. */
interface SegmentTally {
  delivered: number;
  archived: number;
  accepted: number;
  rejected: number;
  scoreSum: number;
  scored: number;
}

/**
 * Turn per-segment tallies into a ranked table.
 *
 * PURE. Sorted by rank descending, then by delivered count, then by segment name,
 * so identical inputs always produce the same order and the same winner.
 */
export function rankSegments(tallies: ReadonlyMap<string, SegmentTally>): SegmentEconomics[] {
  const rows: SegmentEconomics[] = [];
  for (const [segment, tally] of tallies) {
    rows.push({
      segment,
      delivered: tally.delivered,
      archived: tally.archived,
      accepted: tally.accepted,
      rejected: tally.rejected,
      meanScore: tally.scored === 0 ? 0 : round2(tally.scoreSum / tally.scored),
      rank: round2(
        tally.delivered * SEGMENT_WEIGHTS.delivered +
          tally.accepted * SEGMENT_WEIGHTS.accepted +
          tally.rejected * SEGMENT_WEIGHTS.rejected +
          tally.archived * SEGMENT_WEIGHTS.archived,
      ),
    });
  }
  return rows.sort(
    (a, b) => b.rank - a.rank || b.delivered - a.delivered || a.segment.localeCompare(b.segment),
  );
}

/**
 * Pick the segment Sales targets next, or `null` when the data cannot support a
 * choice.
 *
 * PURE. Returns `null` in exactly two cases, both of them honest: no segment has
 * been observed at all, or every observed segment ranks identically, which means
 * the run data does not yet distinguish them. Choosing arbitrarily in either case
 * would dress a coin flip up as a strategy.
 */
export function chooseAllocation(ranked: readonly SegmentEconomics[]): SegmentEconomics | null {
  const best = ranked[0];
  if (best === undefined) return null;
  if (ranked.length > 1 && ranked.every((row) => row.rank === best.rank)) return null;
  return best;
}

/* -------------------------------------------------------------------------- */
/* Reading the allocation back                                                */
/* -------------------------------------------------------------------------- */

/**
 * The most recent allocation this agent committed to, or `null` when it has not
 * made one yet. This is the dashboard's read path.
 */
export async function readCurrentAllocation(): Promise<Allocation | null> {
  const history = await listEvents({ agent: 'ceo', limit: historyLimit() });
  for (const event of history) {
    if (event.decision !== 'allocation.set') continue;
    const segment = event.refs['segment'];
    if (segment === undefined || segment.length === 0) continue;
    return {
      segment,
      rank: Number.parseFloat(event.refs['rank'] ?? '0') || 0,
      delivered: Number.parseInt(event.refs['delivered'] ?? '0', 10) || 0,
      accepted: Number.parseInt(event.refs['accepted'] ?? '0', 10) || 0,
      archived: Number.parseInt(event.refs['archived'] ?? '0', 10) || 0,
      decidedAt: event.ts,
    };
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Attribution                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The building use behind one opportunity, or `null` when the chain is broken.
 *
 * opportunity -> candidate -> permit_records.normalized -> existing/proposed use.
 * A permit cache is threaded through so a segment pass over sixty opportunities
 * does not re-read the same permit repeatedly.
 */
async function segmentOf(
  opportunity: OpportunityRecord,
  cache: Map<string, string | null>,
): Promise<string | null> {
  const candidate = await getCandidate(opportunity.candidateId);
  if (candidate === null) return null;

  const cached = cache.get(candidate.permitNumber);
  if (cached !== undefined) return cached;

  const permit = await getPermit(candidate.permitNumber);
  if (permit === null) {
    cache.set(candidate.permitNumber, null);
    return null;
  }

  const parsed = normalizedPermitSchema.safeParse(permit.normalized);
  if (!parsed.success) {
    cache.set(candidate.permitNumber, null);
    return null;
  }

  const use = parsed.data.existingUse ?? parsed.data.proposedUse ?? UNPUBLISHED_SEGMENT;
  cache.set(candidate.permitNumber, use);
  return use;
}

const REJECTIONS: ReadonlySet<Feedback> = new Set<Feedback>(['too_small', 'wrong_scope']);

/* -------------------------------------------------------------------------- */
/* The tick                                                                   */
/* -------------------------------------------------------------------------- */

/** What one CEO tick concluded, for the scheduler's console line. */
export interface CeoTickSummary {
  economics: CompanyEconomics;
  segments: SegmentEconomics[];
  allocation: Allocation | null;
}

/**
 * One CEO Agent tick.
 *
 * Counts the company's own rows, ranks the building-use segments by what those
 * rows actually did, and commits to one target segment. Two decisions land in the
 * log: the economics with their numbers, and the allocation with the arithmetic
 * that chose it.
 */
export async function ceoAgentTick(): Promise<TickResult<CeoTickSummary>> {
  return runTick('ceo', async (ctx) => runCeoTick(ctx));
}

async function runCeoTick(ctx: TickContext): Promise<CeoTickSummary> {
  /* --- 2. pull work: the company's own rows ------------------------------ */
  const customers = await listCustomers();
  let activeSubscribers = 0;
  for (const customer of customers) {
    const subscription = await getSubscriptionByCustomer(customer.id);
    if (subscription !== null && subscription.status === 'active') activeSubscribers += 1;
  }

  const limit = sampleSize();
  const opportunities = await listOpportunities({ limit });

  const economics: CompanyEconomics = {
    activeSubscribers,
    totalCustomers: customers.length,
    mrrUsd: activeSubscribers * monthlyPriceUsd(),
    delivered: 0,
    archived: 0,
    pending: 0,
    replies: 0,
    accepted: 0,
    attributed: 0,
    sampled: opportunities.length,
  };

  const tallies = new Map<string, SegmentTally>();
  const permitCache = new Map<string, string | null>();

  for (const opportunity of opportunities) {
    if (opportunity.status === 'delivered') economics.delivered += 1;
    else if (opportunity.status === 'archived') economics.archived += 1;
    else economics.pending += 1;

    if (opportunity.feedback !== null) {
      economics.replies += 1;
      if (opportunity.feedback === 'good') economics.accepted += 1;
    }

    const segment = await segmentOf(opportunity, permitCache);
    if (segment === null) continue;
    economics.attributed += 1;

    const tally = tallies.get(segment) ?? {
      delivered: 0,
      archived: 0,
      accepted: 0,
      rejected: 0,
      scoreSum: 0,
      scored: 0,
    };
    if (opportunity.status === 'delivered') {
      tally.delivered += 1;
      tally.scoreSum += opportunity.score;
      tally.scored += 1;
    } else if (opportunity.status === 'archived') {
      tally.archived += 1;
    }
    if (opportunity.feedback === 'good') tally.accepted += 1;
    else if (opportunity.feedback !== null && REJECTIONS.has(opportunity.feedback)) tally.rejected += 1;
    tallies.set(segment, tally);
  }

  /* --- 3. decide: report the economics ----------------------------------- */
  const acceptanceRate =
    economics.replies === 0 ? null : round2((economics.accepted / economics.replies) * 100);

  await ctx.decide({
    decision: 'economics.computed',
    summary:
      `${economics.activeSubscribers} of ${economics.totalCustomers} customers are paying, so recurring revenue stands at ${formatUsd(economics.mrrUsd)} a month. ` +
      `Across the last ${economics.sampled} opportunities: ${economics.delivered} delivered, ${economics.archived} archived, ${economics.pending} still pending, ` +
      `${economics.replies} replies of which ${economics.accepted} were positive` +
      `${acceptanceRate === null ? '' : ` (${acceptanceRate}% acceptance)`}.`,
    refs: {
      mrr: economics.mrrUsd,
      subscribers: economics.activeSubscribers,
      delivered: economics.delivered,
      archived: economics.archived,
      replies: economics.replies,
      accepted: economics.accepted,
      segments: tallies.size,
    },
  });

  const ranked = rankSegments(tallies);

  /* --- 4. act: one allocation decision ----------------------------------- */
  if (ranked.length === 0) {
    await ctx.decide({
      decision: 'allocation.held',
      summary: `No opportunity in the last ${economics.sampled} could be traced back to a building use, so there is no run data to reallocate on and the previous target stands.`,
      refs: { sampled: economics.sampled },
    });
    return { economics, segments: ranked, allocation: await readCurrentAllocation() };
  }

  const table = ranked
    .slice(0, 5)
    .map(
      (row) =>
        `${row.segment} scores ${row.rank} (${row.delivered} delivered, ${row.accepted} accepted, ${row.rejected} rejected, ${row.archived} archived)`,
    )
    .join('; ');

  const chosen = chooseAllocation(ranked);
  if (chosen === null) {
    await ctx.decide({
      decision: 'allocation.held',
      summary: `The ${ranked.length} observed segments are still tied on the run data, so the target is held rather than picked at random. ${table}`,
      refs: { sampled: economics.sampled, segments: ranked.length },
    });
    return { economics, segments: ranked, allocation: await readCurrentAllocation() };
  }

  const previous = await readCurrentAllocation();
  const movement =
    previous === null
      ? 'This is the first allocation the company has made.'
      : previous.segment === chosen.segment
        ? `The target is unchanged from the last review.`
        : `The target moves off ${previous.segment}, which now scores below it.`;

  await ctx.decide({
    decision: 'allocation.set',
    summary: `Sales targets ${chosen.segment} next. It scores ${chosen.rank} on ${chosen.delivered} delivered, ${chosen.accepted} accepted, ${chosen.rejected} rejected and ${chosen.archived} archived, at a mean score of ${chosen.meanScore}. ${movement} Full table: ${table}`,
    refs: {
      segment: chosen.segment,
      rank: chosen.rank,
      delivered: chosen.delivered,
      accepted: chosen.accepted,
      rejected: chosen.rejected,
      archived: chosen.archived,
      meanScore: chosen.meanScore,
      previous: previous?.segment ?? null,
    },
  });

  return {
    economics,
    segments: ranked,
    allocation: {
      segment: chosen.segment,
      rank: chosen.rank,
      delivered: chosen.delivered,
      accepted: chosen.accepted,
      archived: chosen.archived,
      decidedAt: ctx.nowIso,
    },
  };
}
