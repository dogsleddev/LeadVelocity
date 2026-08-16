/**
 * The operating view: what the company is doing, right now.
 *
 * This is the screen a judge looks at while the loop runs. It answers four
 * questions in one glance and nothing else:
 *
 *   Is it running?          the kill switch state and the live decision log
 *   Is it real?             the provenance badge and the permit count
 *   Is it selective?        delivered against archived, side by side
 *   Is it a business?       subscribers and recurring revenue
 *
 * Archives are given equal billing with deliveries on purpose. A lead service
 * that delivers everything it sees is a mailing list; the archived column is the
 * evidence that a threshold is being enforced, and each archived row carries the
 * score it was archived at.
 *
 * Every read is guarded. An unconfigured store renders a configuration notice
 * naming the missing keys (presence only, never values), a failed read renders
 * the failure, and an empty store renders an honest empty state. This page never
 * invents a number to fill a card.
 */
import DecisionLogFeed, { AgentLegend } from '@/app/components/DecisionLogFeed';
import KillSwitch from '@/app/components/KillSwitch';
import ReplayBadge, {
  type ProvenanceMode,
  resolveProvenanceMode,
} from '@/app/components/ReplayBadge';
import { missingKeys, monthlyPriceUsd } from '@/lib/config/deployment-env';
import { LEAD_SCORE_THRESHOLD } from '@/lib/calculations/scoring/lead-score';
import { normalizedPermitSchema } from '@/lib/domain/permit-normalizer';
import type { AgentEvent } from '@/lib/domain/schemas/core';
import {
  countPermits,
  getCandidate,
  getPermit,
  getSettings,
  isStoreReady,
  listCustomers,
  listEvents,
  listOpportunities,
  listRecentPermits,
  getSubscriptionByCustomer,
  type OpportunityRecord,
} from '@/lib/store';

/** The demo runs on live state; nothing on this page may be cached between ticks. */
export const dynamic = 'force-dynamic';

/** Ceiling on a single status query. Counts at or above this render as "N+". */
const LIST_CAP = 250;

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

/** One opportunity, resolved far enough to name the job it belongs to. */
interface OpportunityCard {
  id: string;
  score: number;
  address: string | null;
  permitNumber: string | null;
  valuation: number | null;
}

interface OperationsData {
  killSwitch: boolean;
  events: AgentEvent[];
  deliveredCount: number;
  archivedCount: number;
  pendingCount: number;
  activeSubscribers: number;
  customerCount: number;
  permitCount: number;
  provenance: ProvenanceMode;
  deliveredCards: OpportunityCard[];
  archivedCards: OpportunityCard[];
}

type LoadResult =
  | { state: 'unconfigured'; missing: string[] }
  | { state: 'failed'; message: string }
  | { state: 'ok'; data: OperationsData };

/**
 * Resolve a handful of opportunities to their permits.
 *
 * Two hops (opportunity to candidate to permit) done only for the rows actually
 * rendered. The store has no join helper and inventing one here would put SQL in
 * a page component, so the read is kept deliberately small instead.
 */
async function toCards(opportunities: readonly OpportunityRecord[]): Promise<OpportunityCard[]> {
  const cards: OpportunityCard[] = [];

  for (const opportunity of opportunities) {
    const candidate = await getCandidate(opportunity.candidateId);
    const permit = candidate === null ? null : await getPermit(candidate.permitNumber);

    let address: string | null = null;
    let valuation: number | null = null;
    if (permit !== null) {
      // The stored projection is `jsonb`, so it is re-validated on the way out.
      // A projection this page cannot read degrades to an unnamed row, never to
      // a crash and never to a made-up address.
      const parsed = normalizedPermitSchema.safeParse(permit.normalized);
      if (parsed.success) {
        address = parsed.data.address;
        valuation = parsed.data.valuation;
      }
    }

    cards.push({
      id: opportunity.id,
      score: opportunity.score,
      permitNumber: candidate?.permitNumber ?? null,
      address,
      valuation,
    });
  }

  return cards;
}

async function load(): Promise<LoadResult> {
  if (!isStoreReady()) {
    return { state: 'unconfigured', missing: missingKeys('supabase') };
  }

  try {
    const [settings, events, delivered, archived, pending, customers, recentPermits, permitCount] =
      await Promise.all([
        getSettings(),
        listEvents({ limit: 25 }),
        listOpportunities({ status: 'delivered', limit: LIST_CAP }),
        listOpportunities({ status: 'archived', limit: LIST_CAP }),
        listOpportunities({ status: 'pending', limit: LIST_CAP }),
        listCustomers(),
        listRecentPermits(10),
        countPermits(),
      ]);

    const subscriptions = await Promise.all(
      customers.map((customer) => getSubscriptionByCustomer(customer.id)),
    );

    const [deliveredCards, archivedCards] = await Promise.all([
      toCards(delivered.slice(0, 6)),
      toCards(archived.slice(0, 4)),
    ]);

    return {
      state: 'ok',
      data: {
        killSwitch: settings.killSwitch,
        events,
        deliveredCount: delivered.length,
        archivedCount: archived.length,
        pendingCount: pending.length,
        activeSubscribers: subscriptions.filter(
          (subscription) => subscription !== null && subscription.status === 'active',
        ).length,
        customerCount: customers.length,
        permitCount,
        provenance: resolveProvenanceMode({
          replayActive: settings.replayActive,
          observedRecords: permitCount,
          anyReplayed: recentPermits.some((permit) => permit.provenance.replayed),
        }),
        deliveredCards,
        archivedCards,
      },
    };
  } catch (error) {
    return { state: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/** Whole dollars with thousands separators, written out rather than localized. */
function usd(amount: number): string {
  const digits = Math.round(Math.abs(amount)).toString();
  let grouped = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ',';
    grouped += digits.charAt(index);
  }
  return `${amount < 0 ? '-' : ''}$${grouped}`;
}

/** A count that may have hit the query ceiling says so instead of lying. */
function capped(count: number): string {
  return count >= LIST_CAP ? `${LIST_CAP}+` : String(count);
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

function OpportunityRows({
  cards,
  emptyBody,
}: {
  cards: readonly OpportunityCard[];
  emptyBody: string;
}) {
  if (cards.length === 0) {
    return (
      <div className="empty">
        <p className="empty-body">{emptyBody}</p>
      </div>
    );
  }

  return (
    <div className="rows">
      {cards.map((card) => (
        <a className="row-link" href={`/opportunities/${card.id}`} key={card.id}>
          <span className="row-score">{Math.round(card.score)}</span>
          <span>
            <span className="row-title">{card.address ?? 'Address not published'}</span>
            <span className="row-meta">
              Permit {card.permitNumber ?? 'unknown'}
              {card.valuation === null ? '' : ` | ${usd(card.valuation)}`}
            </span>
          </span>
          <span className="pill">Open</span>
        </a>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default async function OperationsPage() {
  const result = await load();

  if (result.state === 'unconfigured') {
    return (
      <>
        <div className="page-head">
          <div>
            <h1 className="page-title">Operations</h1>
            <p className="page-sub">
              The live view of the company: what it decided, what it delivered, and what it turned
              down.
            </p>
          </div>
        </div>
        <div className="empty">
          <p className="empty-title">Persistence is not configured</p>
          <p className="empty-body">
            Every screen reads from Supabase, and this deployment has no connection to it. Nothing
            is being displayed in its place, because a dashboard filled with placeholder numbers is
            worse than an empty one.
          </p>
          <p className="empty-keys">Missing keys: {result.missing.join(', ')}</p>
        </div>
      </>
    );
  }

  if (result.state === 'failed') {
    return (
      <>
        <div className="page-head">
          <h1 className="page-title">Operations</h1>
        </div>
        <div className="empty empty--fatal">
          <p className="empty-title">The store could not be read</p>
          <p className="empty-body">{result.message}</p>
        </div>
      </>
    );
  }

  const data = result.data;
  const price = monthlyPriceUsd();
  const mrr = data.activeSubscribers * price;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Operations</h1>
          <p className="page-sub">
            The live view of the company: what it decided, what it delivered, and what it turned
            down.
          </p>
        </div>
        <div className="page-head-side">
          <ReplayBadge mode={data.provenance} />
        </div>
      </div>

      <div className="grid grid-stats">
        <div className="stat">
          <p className="stat-label">Delivered</p>
          <p className="stat-value stat-value--positive">{capped(data.deliveredCount)}</p>
          <p className="stat-note">Opportunities that cleared the bar and reached a subscriber</p>
        </div>
        <div className="stat">
          <p className="stat-label">Archived</p>
          <p className="stat-value">{capped(data.archivedCount)}</p>
          <p className="stat-note">
            Scored, then turned down. Selectivity is the product, so this number is shown, not
            hidden.
          </p>
        </div>
        <div className="stat">
          <p className="stat-label">Permits observed</p>
          <p className="stat-value">{data.permitCount}</p>
          <p className="stat-note">
            Real records in the store. {capped(data.pendingCount)} scored and awaiting a delivery
            decision.
          </p>
        </div>
        <div className="stat">
          <p className="stat-label">Paying subscribers</p>
          <p className="stat-value">{data.activeSubscribers}</p>
          <p className="stat-note">
            {data.customerCount} account{data.customerCount === 1 ? '' : 's'} on file
          </p>
        </div>
        <div className="stat">
          <p className="stat-label">Recurring revenue</p>
          <p className="stat-value stat-value--accent">{usd(mrr)}</p>
          <p className="stat-note">Per month, at {usd(price)} per subscriber</p>
        </div>
      </div>

      <div className="section split">
        <div>
          <h2 className="section-title">Decision log, newest first</h2>
          <DecisionLogFeed events={data.events} />
          <AgentLegend />
          <p className="section-note">
            Every decision the company makes writes one line here as it happens. The full history,
            filterable, is on the <a href="/log">decision log</a>.
          </p>
        </div>
        <div>
          <KillSwitch initialOn={data.killSwitch} available />
        </div>
      </div>

      <div className="section">
        <h2 className="section-title">Delivered opportunities</h2>
        <OpportunityRows
          cards={data.deliveredCards}
          emptyBody={`Nothing has cleared the ${LEAD_SCORE_THRESHOLD} point bar yet. On a quiet week that is the correct output, and no filler is shown in its place.`}
        />
      </div>

      <div className="section">
        <h2 className="section-title">Archived, with the score they were archived at</h2>
        <OpportunityRows
          cards={data.archivedCards}
          emptyBody="Nothing has been archived yet. Once scoring runs, the projects that did not clear the bar are listed here with their numbers."
        />
        <p className="section-note">
          A project is archived when it scores under {LEAD_SCORE_THRESHOLD} or carries a
          disqualifying condition, such as a cancelled permit or a job under the subscriber's
          minimum. Each archived record keeps its full reasoning.
        </p>
      </div>
    </>
  );
}
