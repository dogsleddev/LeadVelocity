/**
 * S3, the inbox: every scored project this subscriber has, newest first.
 *
 * WHAT THIS SCREEN IS FOR
 * -----------------------
 * It answers one question in the two seconds a contractor gives it on a job
 * site: is there anything here worth my afternoon? So it is a short list of real
 * rows, each with the number that got it here, when it landed, what and where it
 * is, and whether it has actually been sent.
 *
 * DELIVERY STATE IS REPORTED, NEVER ASSUMED
 * -----------------------------------------
 * The pipeline can score a lead without messaging it: delivery is a separate
 * step with its own switch, and right now it is off, so real scored rows sit at
 * `status = 'pending'`. Those are not fictional and they are not failures. They
 * are leads this subscriber owns that have not gone out by text yet, and hiding
 * them would make the screen emptier than the truth.
 *
 * What must never happen is the reverse. A card says "Sent to you" only when
 * `opportunities.status` is exactly `delivered`; everything else says so plainly.
 * The list is therefore built from the delivered and pending rows together and
 * `delivered` is passed down as a fact read off the row, not inferred from its
 * presence on the screen.
 *
 * ARCHIVED IS SHOWN, BECAUSE IT IS THE ARGUMENT
 * ---------------------------------------------
 * A lead service that forwards everything it sees is a mailing list. The count
 * of projects that were scored and turned down is the evidence that a bar is
 * being enforced, and it is the reason an empty inbox is a good day rather than
 * a broken product. It appears on this screen in both states, full and empty.
 *
 * NOTHING HERE IS INVENTED
 * ------------------------
 * Titles are assembled by `composeLeadTitle` from the permit's own columns and
 * carry no project or company name, because DataSF publishes neither. A permit
 * with no published valuation says so. A row whose permit cannot be read renders
 * as a row whose permit cannot be read. An unconfigured store says which keys are
 * missing and shows no leads at all rather than a plausible looking zero.
 */
import LeadCard, {
  composeLeadSubtitle,
  composeLeadTitle,
  relativeLeadTime,
} from '@/app/components/contractor/LeadCard';
import { LEAD_SCORE_THRESHOLD } from '@/lib/calculations/scoring/lead-score';
import { missingKeys } from '@/lib/config/deployment-env';
import { SF_TIME_ZONE, normalizedPermitSchema } from '@/lib/domain/permit-normalizer';
import {
  type OpportunityRecord,
  getCandidate,
  getPermit,
  getPrimaryCustomer,
  isStoreReady,
  listOpportunities,
} from '@/lib/store';

/** Leads change as the pipeline runs; nothing on this screen may be cached. */
export const dynamic = 'force-dynamic';

/**
 * Ceiling on a single status query, matching the operations console. A count
 * that reaches it renders as "N+" rather than as a precise number it is not.
 */
const LIST_CAP = 250;

/** How many cards the inbox renders. Beyond this the tail is summarised. */
const VISIBLE_LEADS = 25;

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

interface LeadView {
  id: string;
  score: number;
  title: string;
  subtitle: string;
  /** When the lead landed: its delivery time when sent, its scoring time when not. */
  landedAt: string;
  delivered: boolean;
}

interface InboxData {
  businessName: string;
  leads: LeadView[];
  hiddenLeads: number;
  archivedCount: number;
}

type LoadResult =
  | { state: 'unconfigured'; missing: string[] }
  | { state: 'failed'; message: string }
  | { state: 'no-subscriber' }
  | { state: 'ok'; data: InboxData };

/**
 * Resolve one opportunity to the permit it came from and name it.
 *
 * Two hops, opportunity to candidate to permit, done only for the rows actually
 * rendered. The store exposes no join and writing SQL inside a page component to
 * avoid the round trips would put database access somewhere it does not belong,
 * so the read is kept small instead of clever.
 *
 * Every failure along the way degrades to an honest row. A missing candidate, a
 * missing permit and a stored projection that no longer validates each produce a
 * different sentence, because they are different facts about what we know.
 */
async function toLead(opportunity: OpportunityRecord): Promise<LeadView> {
  const delivered = opportunity.status === 'delivered';
  const base = {
    id: opportunity.id,
    score: opportunity.score,
    landedAt: opportunity.deliveredAt ?? opportunity.createdAt,
    delivered,
  };

  const candidate = await getCandidate(opportunity.candidateId);
  if (candidate === null) {
    return { ...base, title: 'Project record not available', subtitle: 'Permit not on file' };
  }

  const permit = await getPermit(candidate.permitNumber);
  if (permit === null) {
    return {
      ...base,
      title: `Permit ${candidate.permitNumber}`,
      subtitle: 'Permit record not on file',
    };
  }

  // The projection is stored as `jsonb`, so it is re-validated on the way out.
  const parsed = normalizedPermitSchema.safeParse(permit.normalized);
  if (!parsed.success) {
    return {
      ...base,
      title: `Permit ${candidate.permitNumber}`,
      subtitle: 'Project details could not be read',
    };
  }

  return {
    ...base,
    title: composeLeadTitle(parsed.data),
    subtitle: composeLeadSubtitle(parsed.data),
  };
}

async function load(): Promise<LoadResult> {
  if (!isStoreReady()) {
    return { state: 'unconfigured', missing: missingKeys('supabase') };
  }

  try {
    const customer = await getPrimaryCustomer();
    if (customer === null) return { state: 'no-subscriber' };

    const [delivered, pending, archived] = await Promise.all([
      listOpportunities({ status: 'delivered', customerId: customer.id, limit: LIST_CAP }),
      listOpportunities({ status: 'pending', customerId: customer.id, limit: LIST_CAP }),
      listOpportunities({ status: 'archived', customerId: customer.id, limit: LIST_CAP }),
    ]);

    // Each status arrives newest first on its own; merged, they need re-sorting
    // on the moment the lead actually landed for this subscriber.
    const inbox = [...delivered, ...pending].sort((a, b) => {
      const left = a.deliveredAt ?? a.createdAt;
      const right = b.deliveredAt ?? b.createdAt;
      return right.localeCompare(left);
    });

    const leads = await Promise.all(inbox.slice(0, VISIBLE_LEADS).map(toLead));

    return {
      state: 'ok',
      data: {
        businessName: customer.businessName,
        leads,
        hiddenLeads: Math.max(0, inbox.length - leads.length),
        archivedCount: archived.length,
      },
    };
  } catch (error) {
    return { state: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Pieces                                                                     */
/* -------------------------------------------------------------------------- */

/** A count that may have hit the query ceiling says so instead of lying. */
function capped(count: number): string {
  return count >= LIST_CAP ? `${LIST_CAP}+` : String(count);
}

/**
 * The selectivity line, and where every line on this screen came from.
 *
 * Both sentences are load bearing. The first is the reason the list is short.
 * The second is the reason to believe any of it, and it has to live inside this
 * surface because the operations console footer that normally carries the
 * provenance is not part of the contractor shell.
 */
function ProvenanceNote({ archivedCount }: { archivedCount: number }) {
  return (
    <p className="lv-foot-note">
      {archivedCount > 0 && (
        <>
          <strong>{capped(archivedCount)}</strong>{' '}
          {archivedCount === 1
            ? 'other project was scored and turned down.'
            : 'other projects were scored and turned down.'}{' '}
          You only see the ones that clear {LEAD_SCORE_THRESHOLD} out of 100.{' '}
        </>
      )}
      Every project here comes from a San Francisco building permit record.
    </p>
  );
}

function EmptyInbox({ archivedCount }: { archivedCount: number }) {
  return (
    <>
      <div className="lv-empty">
        <div className="lv-empty-glyph" aria-hidden="true">
          &#10003;
        </div>
        <p className="lv-empty-body">
          Nothing cleared the bar today. We deliver quality, not noise.
        </p>
        {archivedCount > 0 && (
          <p className="lv-empty-note">
            {capped(archivedCount)}{' '}
            {archivedCount === 1
              ? 'project was scored and turned down for you.'
              : 'projects were scored and turned down for you.'}
          </p>
        )}
      </div>
      <p className="lv-foot-note">
        Every project we look at comes from a San Francisco building permit record.
      </p>
    </>
  );
}

function Notice({
  title,
  body,
  keys,
}: {
  title: string;
  body: string;
  keys?: readonly string[];
}) {
  return (
    <div className="lv-screen-fill">
      <div className="lv-notice">
        <p className="lv-notice-title">{title}</p>
        <p className="lv-notice-body">{body}</p>
        {keys !== undefined && keys.length > 0 && (
          <p className="lv-notice-keys">Missing keys: {keys.join(', ')}</p>
        )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                     */
/* -------------------------------------------------------------------------- */

export default async function LeadsScreen() {
  const result = await load();
  const now = new Date();

  if (result.state === 'unconfigured') {
    return (
      <section className="lv-screen-fill" data-lv-screen="leads">
        <Notice
          title="Your leads are not reachable"
          body="This deployment has no connection to the records store, so nothing can be shown. An empty list would look like a quiet week, and this is not one."
          keys={result.missing}
        />
      </section>
    );
  }

  if (result.state === 'failed') {
    return (
      <section className="lv-screen-fill" data-lv-screen="leads">
        <Notice title="Your leads could not be loaded" body={result.message} />
      </section>
    );
  }

  if (result.state === 'no-subscriber') {
    return (
      <section className="lv-screen-fill" data-lv-screen="leads">
        <Notice
          title="No account on file"
          body="There is no subscriber profile to show leads for yet. Once a profile exists, the projects scored against it appear here."
        />
      </section>
    );
  }

  const { leads, hiddenLeads, archivedCount } = result.data;

  if (leads.length === 0) {
    return (
      <section className="lv-screen-fill" data-lv-screen="leads">
        <EmptyInbox archivedCount={archivedCount} />
      </section>
    );
  }

  return (
    <section className="lv-screen-fill" data-lv-screen="leads">
      <div className="lv-screen-head">
        <h1 className="lv-screen-title">Your leads</h1>
        <p className="lv-screen-sub">
          {leads.length}
          {hiddenLeads > 0 ? ` of ${leads.length + hiddenLeads}` : ''} scored{' '}
          {leads.length === 1 && hiddenLeads === 0 ? 'project' : 'projects'}, newest first.
        </p>
      </div>

      <div className="lv-list">
        {leads.map((lead) => (
          <LeadCard
            key={lead.id}
            href={`/app/leads/${lead.id}`}
            score={lead.score}
            title={lead.title}
            subtitle={lead.subtitle}
            when={relativeLeadTime(lead.landedAt, now, SF_TIME_ZONE)}
            delivered={lead.delivered}
          />
        ))}
      </div>

      <ProvenanceNote archivedCount={archivedCount} />
    </section>
  );
}
