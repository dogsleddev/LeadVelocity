/**
 * The CEO view: is this a company, and is it getting better at being one?
 *
 * Four blocks, in the order the question gets answered:
 *
 *   1. The money. Recurring revenue, accounts, and how selective the service was
 *      in getting there.
 *   2. Per-account economics. What each subscriber pays, what they received, and
 *      what they said about it. One row per account, with no averaging: at this
 *      size an average would be hiding a single number behind arithmetic.
 *   3. The before and after from the message study. Three drafted variants, the
 *      panel's numbers, and the copy the company adopted as a result. This is
 *      read straight out of `message_studies`. If no study has completed, the
 *      block says exactly that. It never renders a placeholder result, because a
 *      fabricated panel number would be the single worst thing on this screen.
 *   4. The decisions the company made about itself, from the log.
 *
 * Every figure on this page is derived from stored rows. The only constant that
 * is not read from the database is the published subscription price, which is
 * declared once below and cited.
 */
import DecisionLogFeed from '@/app/components/DecisionLogFeed';
import { missingKeys, monthlyPriceUsd } from '@/lib/config/deployment-env';
import { LEAD_SCORE_THRESHOLD } from '@/lib/calculations/scoring/lead-score';
import type { AgentEvent, Feedback } from '@/lib/domain/schemas/core';
import { STUDY_PREAMBLE, STUDY_QUESTIONS } from '@/lib/integrations/terac';
import {
  getCompletedStudy,
  getLatestStudy,
  getSubscriptionByCustomer,
  isStoreReady,
  listCustomers,
  listEvents,
  listOpportunities,
  type CustomerRecord,
  type MessageStudy,
  type SubscriptionStatus,
} from '@/lib/store';

export const dynamic = 'force-dynamic';

/** Ceiling on the per-account opportunity read. */
const ACCOUNT_LIMIT = 500;

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

/** One row of the per-account contribution table. */
interface AccountLine {
  id: string;
  businessName: string;
  profileStatus: CustomerRecord['status'];
  billingStatus: SubscriptionStatus | null;
  monthlyUsd: number;
  delivered: number;
  archived: number;
  pending: number;
  feedback: Record<Feedback, number>;
}

interface DashboardData {
  accounts: AccountLine[];
  mrr: number;
  payingAccounts: number;
  totalDelivered: number;
  totalArchived: number;
  study: MessageStudy | null;
  latestStudy: MessageStudy | null;
  ceoEvents: AgentEvent[];
}

type LoadResult =
  | { state: 'unconfigured'; missing: string[] }
  | { state: 'failed'; message: string }
  | { state: 'ok'; data: DashboardData };

async function load(): Promise<LoadResult> {
  if (!isStoreReady()) return { state: 'unconfigured', missing: missingKeys('supabase') };

  try {
    const [customers, study, latestStudy, ceoEvents] = await Promise.all([
      listCustomers(),
      getCompletedStudy(),
      getLatestStudy(),
      listEvents({ limit: 12, agent: 'ceo' }),
    ]);

    const accounts: AccountLine[] = [];
    for (const customer of customers) {
      const [subscription, opportunities] = await Promise.all([
        getSubscriptionByCustomer(customer.id),
        listOpportunities({ customerId: customer.id, limit: ACCOUNT_LIMIT }),
      ]);

      const feedback: Record<Feedback, number> = { good: 0, too_small: 0, wrong_scope: 0 };
      let delivered = 0;
      let archived = 0;
      let pending = 0;
      for (const opportunity of opportunities) {
        if (opportunity.status === 'delivered') delivered += 1;
        else if (opportunity.status === 'archived') archived += 1;
        else pending += 1;
        if (opportunity.feedback !== null) feedback[opportunity.feedback] += 1;
      }

      const billingStatus = subscription === null ? null : subscription.status;
      accounts.push({
        id: customer.id,
        businessName: customer.businessName,
        profileStatus: customer.status,
        billingStatus,
        // Revenue follows the billing row, not the profile status. A profile
        // marked active without an active subscription is not revenue.
        monthlyUsd: billingStatus === 'active' ? monthlyPriceUsd() : 0,
        delivered,
        archived,
        pending,
        feedback,
      });
    }

    return {
      state: 'ok',
      data: {
        accounts,
        mrr: accounts.reduce((total, account) => total + account.monthlyUsd, 0),
        payingAccounts: accounts.filter((account) => account.billingStatus === 'active').length,
        totalDelivered: accounts.reduce((total, account) => total + account.delivered, 0),
        totalArchived: accounts.reduce((total, account) => total + account.archived, 0),
        study,
        latestStudy,
        ceoEvents,
      },
    };
  } catch (error) {
    return { state: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

function usd(amount: number): string {
  const digits = Math.round(Math.abs(amount)).toString();
  let grouped = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ',';
    grouped += digits.charAt(index);
  }
  return `${amount < 0 ? '-' : ''}$${grouped}`;
}

const FEEDBACK_LABEL: Readonly<Record<Feedback, string>> = {
  good: 'good',
  too_small: 'too small',
  wrong_scope: 'wrong scope',
};

/** "2 good, 1 too small", or null when the subscriber has not replied. */
function summarizeFeedback(feedback: Record<Feedback, number>): string | null {
  const parts = (Object.keys(FEEDBACK_LABEL) as Feedback[])
    .filter((key) => feedback[key] > 0)
    .map((key) => `${feedback[key]} ${FEEDBACK_LABEL[key]}`);
  return parts.length === 0 ? null : parts.join(', ');
}

/** Selectivity as a percentage of everything that was scored. */
function selectivity(delivered: number, archived: number): string | null {
  const scored = delivered + archived;
  if (scored === 0) return null;
  return `${Math.round((delivered / scored) * 100)}%`;
}

/** A reported share (0..1) as a whole percentage. */
function share(fraction: number | undefined): string {
  if (fraction === undefined || !Number.isFinite(fraction)) return '';
  return `${Math.round(fraction * 100)}%`;
}

/**
 * The exact question behind a column, for its tooltip.
 *
 * Read from `STUDY_QUESTIONS` rather than retyped here, so the header on this
 * screen cannot drift from the question the panel was actually asked.
 */
function questionText(key: string): string {
  return STUDY_QUESTIONS.find((question) => question.key === key)?.text ?? key;
}

/* -------------------------------------------------------------------------- */
/* Study block                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The before and after.
 *
 * "Before" is the three variants as drafted, recorded before the panel saw them.
 * "After" is the panel's numbers and the copy the company adopted. Winner
 * selection is deterministic and happens in code, so this block reports a result
 * rather than making one.
 */
function StudyBlock({
  study,
  latest,
}: {
  study: MessageStudy | null;
  latest: MessageStudy | null;
}) {
  if (study === null) {
    const status = latest === null ? null : latest.status;
    return (
      <div className="empty">
        <p className="empty-title">No completed study yet</p>
        <p className="empty-body">
          {status === null
            ? 'No message study has been created, so there are no panel numbers to show. Nothing is displayed in place of them.'
            : `A study exists and its status is "${status}". Panel results have not been recorded, so no numbers are shown. A study that has not reported is not evidence yet.`}
        </p>
        {latest === null ? null : (
          <>
            <p className="empty-body">
              The {latest.variants.length} variants below are the drafts already on record, written
              before the panel was asked. They are the "before" half of this block.
            </p>
            <div className="variants" style={{ marginTop: '14px' }}>
              {latest.variants.map((variant) => (
                <div className="variant" key={variant.id}>
                  <p className="variant-id">Variant {variant.id}</p>
                  <p className="variant-text">{variant.text}</p>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    );
  }

  const results = study.results ?? [];
  const winnerId = study.winner?.variantId ?? null;

  return (
    <>
      <div className="variants">
        {study.variants.map((variant) => (
          <div
            className={variant.id === winnerId ? 'variant variant--winner' : 'variant'}
            key={variant.id}
          >
            <p className="variant-id">
              Variant {variant.id}
              {variant.id === winnerId ? ' | adopted' : ''}
            </p>
            <p className="variant-text">{variant.text}</p>
          </div>
        ))}
      </div>

      {results.length === 0 ? (
        <p className="section-note">
          The study is marked complete but carries no per-variant numbers, so none are shown.
        </p>
      ) : (
        <div className="table-scroll" style={{ marginTop: '16px' }}>
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Message</th>
                <th scope="col" title={questionText('trust')}>
                  Most trusted
                </th>
                <th scope="col" title={questionText('clarity')}>
                  Clearest
                </th>
                <th scope="col" title={questionText('reply')}>
                  Would reply
                </th>
                <th scope="col">Total picks</th>
              </tr>
            </thead>
            <tbody>
              {results.map((result) => (
                <tr key={result.variantId}>
                  <td>
                    {result.label === '' ? result.variantId : result.label}
                    {result.variantId === winnerId ? ' (adopted)' : ''}
                    <span className="table-key">variant {result.variantId}</span>
                  </td>
                  {['trust', 'clarity', 'reply'].map((key) => (
                    <td className="table-num" key={key}>
                      {result.selections[key] ?? 0}
                      <span className="table-key">{share(result.shares[key])}</span>
                    </td>
                  ))}
                  <td className="table-num">{result.totalSelections}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <p className="section-note">
        Each number is how many people picked that message as the most trustworthy, the clearest, or
        the one they would reply to, with that share of the panel underneath. The winner is the
        message with the most picks overall, with the trust question breaking a tie, chosen in code
        rather than by judgement.
      </p>
      <p className="section-note">
        <strong>What every respondent read first: </strong>
        {STUDY_PREAMBLE}
      </p>

      {study.winner === null ? null : (
        <div className="adopted">
          <p className="variant-id">Copy now in use</p>
          <p style={{ marginTop: '8px' }}>{study.winner.text}</p>
        </div>
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default async function DashboardPage() {
  const result = await load();

  if (result.state === 'unconfigured') {
    return (
      <>
        <div className="page-head">
          <h1 className="page-title">Company</h1>
        </div>
        <div className="empty">
          <p className="empty-title">Persistence is not configured</p>
          <p className="empty-body">
            Revenue, accounts, and the study all live in Supabase, which this deployment cannot
            reach. No figures are shown in their place.
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
          <h1 className="page-title">Company</h1>
        </div>
        <div className="empty empty--fatal">
          <p className="empty-title">The company numbers could not be read</p>
          <p className="empty-body">{result.message}</p>
        </div>
      </>
    );
  }

  const data = result.data;
  const rate = selectivity(data.totalDelivered, data.totalArchived);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Company</h1>
          <p className="page-sub">
            What the business earns, what it delivered to earn it, and what it changed about itself
            after asking real people.
          </p>
        </div>
      </div>

      <div className="grid grid-stats">
        <div className="stat">
          <p className="stat-label">Recurring revenue</p>
          <p className="stat-value stat-value--accent">{usd(data.mrr)}</p>
          <p className="stat-note">Per month, {usd(monthlyPriceUsd())} per paying account</p>
        </div>
        <div className="stat">
          <p className="stat-label">Paying accounts</p>
          <p className="stat-value">{data.payingAccounts}</p>
          <p className="stat-note">
            of {data.accounts.length} on file, counted from billing state rather than intent
          </p>
        </div>
        <div className="stat">
          <p className="stat-label">Delivered</p>
          <p className="stat-value stat-value--positive">{data.totalDelivered}</p>
          <p className="stat-note">Opportunities that cleared {LEAD_SCORE_THRESHOLD} points</p>
        </div>
        <div className="stat">
          <p className="stat-label">Archived</p>
          <p className="stat-value">{data.totalArchived}</p>
          <p className="stat-note">
            {rate === null
              ? 'Nothing scored yet'
              : `${rate} of everything scored was worth sending`}
          </p>
        </div>
      </div>

      <section className="section">
        <h2 className="section-title">Per-account contribution</h2>
        {data.accounts.length === 0 ? (
          <div className="empty">
            <p className="empty-body">
              No accounts on file yet. The table fills the moment a subscriber profile exists.
            </p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Account</th>
                  <th scope="col">Billing</th>
                  <th scope="col">Monthly</th>
                  <th scope="col">Delivered</th>
                  <th scope="col">Archived</th>
                  <th scope="col">Replies</th>
                </tr>
              </thead>
              <tbody>
                {data.accounts.map((account) => {
                  const replies = summarizeFeedback(account.feedback);
                  return (
                    <tr key={account.id}>
                      <td>
                        {account.businessName}
                        <span className="table-key">profile {account.profileStatus}</span>
                      </td>
                      <td>
                        <span
                          className={
                            account.billingStatus === 'active' ? 'pill pill--delivered' : 'pill'
                          }
                        >
                          {account.billingStatus ?? 'no subscription'}
                        </span>
                      </td>
                      <td className="table-num">{usd(account.monthlyUsd)}</td>
                      <td className="table-num">
                        {account.delivered}
                        {account.pending === 0 ? null : (
                          <span className="table-key">{account.pending} awaiting a decision</span>
                        )}
                      </td>
                      <td className="table-num">{account.archived}</td>
                      <td>
                        {replies === null ? (
                          <span className="value-unknown">none yet</span>
                        ) : (
                          replies
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="section-note">
          Revenue is counted from the billing row, so an account whose profile says active but whose
          subscription is not will show zero. The two are kept apart on purpose.
        </p>
      </section>

      <section className="section">
        <h2 className="section-title">Outreach copy, before and after the panel</h2>
        <StudyBlock study={data.study} latest={data.latestStudy} />
      </section>

      <section className="section">
        <h2 className="section-title">Decisions the company made about itself</h2>
        <DecisionLogFeed
          events={data.ceoEvents}
          emptyTitle="No company-level decisions recorded yet"
          emptyBody="Decisions about pricing, acquisition, and where to spend effort are written to the log as they happen. None have been made yet."
        />
      </section>
    </>
  );
}
