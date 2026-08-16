/**
 * S2, the lead detail screen. The thing the subscription actually buys.
 *
 * Everything upstream exists to produce this page: one real permit, scored, with
 * the evidence behind the number and the name of the person to chase. It is laid
 * out in the order the settled v4 prototype uses, which is the order a
 * contractor's attention moves:
 *
 *   back to the inbox -> the number -> what and where the job is -> the four
 *   questions (what it is, why it fits, who to call, why now) -> where the points
 *   came from -> every fact with its evidence label -> the next step -> the three
 *   verdict buttons.
 *
 * WHAT THIS PAGE IS NOT ALLOWED TO SHOW
 * -------------------------------------
 * The prototype's mock lead had a project name, a square footage, a job title and
 * a phone number. The real data has none of those, so none of them appear here
 * (hard rule #3):
 *
 * - NO PROJECT NAME. The heading comes from `composeLeadTitle`, the same function
 *   the inbox card uses, so the row you tapped and the screen you land on name the
 *   project identically, out of the permit's own columns.
 * - NO SQUARE FOOTAGE. It appears in 3.8% of descriptions and in no column.
 * - NO PHONE NUMBER, AND NO AFFORDANCE THAT IMPLIES ONE. The DataSF permit
 *   contacts dataset has neither a phone nor an email column. "Who to call" is
 *   therefore a person, a firm and the role the agency publishes, and the page
 *   says out loud that there is no number to dial.
 *
 * DELIVERY STATE IS REPORTED, NEVER IMPLIED
 * -----------------------------------------
 * A lead says it was sent only when `opportunities.status` is exactly
 * `delivered`. A scored row that has not been messaged says that instead, and an
 * archived row says it was held back and why. Being on this screen is not
 * evidence of anything.
 *
 * COPY (hard rule #9): every word here is customer facing. Nothing names the
 * technology and there are no em dashes. Notes written for engineers are filtered
 * inside `EvidenceTable` rather than shown raw.
 *
 * AUTH: there is none, by design. `getPrimaryCustomer()` IS the signed-in
 * subscriber for this build, and a lead belonging to another account is declined
 * rather than rendered.
 *
 * Server component. The feedback bar is the only interactive part.
 */
import Link from 'next/link';
import type { ReactNode } from 'react';

import DriverBars from '@/app/components/contractor/DriverBars';
import EvidenceTable from '@/app/components/contractor/EvidenceTable';
import FeedbackBar from '@/app/components/contractor/FeedbackBar';
import {
  composeLeadSubtitle,
  composeLeadTitle,
  useLabel as expandUseLabel,
} from '@/app/components/contractor/LeadCard';
import ScoreBadge from '@/app/components/contractor/ScoreBadge';
import ScoreGauge, { gaugeAccent } from '@/app/components/contractor/ScoreGauge';
import { getSource, isSourceId } from '@/lib/adapters/sources/registry';
import { LEAD_SCORE_THRESHOLD } from '@/lib/calculations/scoring/lead-score';
import { missingKeys } from '@/lib/config/deployment-env';
import { isCustomerSafe } from '@/lib/copy/templates';
import {
  type NormalizedPermit,
  SF_TIME_ZONE,
  normalizedPermitSchema,
} from '@/lib/domain/permit-normalizer';
import {
  type CustomerRecord,
  type FindingRecord,
  type OpportunityRecord,
  type PermitRecord,
  getCandidate,
  getOpportunity,
  getPermit,
  getPrimaryCustomer,
  isStoreReady,
  listFindings,
} from '@/lib/store';

/** One subscriber's own lead. Nothing on this screen may be cached. */
export const dynamic = 'force-dynamic';

/** The inbox this lead came from. */
const INBOX_HREF = '/app/leads';

/**
 * How far the action bar sits above the bottom of the viewport.
 *
 * The shell's tab bar is sticky at the bottom of the frame, so an action bar
 * stuck at zero would cover it. This is the tab bar's height, and it only has any
 * effect on a narrow screen: on the desktop frame `.lv-frame` clips its overflow,
 * which makes both bars inert and lets them stack in normal flow.
 */
const TABBAR_HEIGHT = 60;

/* -------------------------------------------------------------------------- */
/* Formatting (pure, zone-pinned)                                             */
/* -------------------------------------------------------------------------- */

const DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: SF_TIME_ZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

const MOMENT = new Intl.DateTimeFormat('en-US', {
  timeZone: SF_TIME_ZONE,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

const MS_PER_DAY = 86_400_000;

function formatDay(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? DAY.format(new Date(ms)) : null;
}

function formatMoment(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? MOMENT.format(new Date(ms)) : null;
}

/** Whole dollars, grouped by hand so output cannot drift with the host locale. */
function usd(amount: number): string {
  const digits = Math.round(Math.abs(amount)).toString();
  let grouped = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ',';
    grouped += digits.charAt(index);
  }
  return `${amount < 0 ? '-' : ''}$${grouped}`;
}

function sentenceCase(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * "2.9 times" from 2.956.
 *
 * Truncated rather than rounded, deliberately. This number is an argument for
 * spending an afternoon on a bid and it must never read larger than the
 * arithmetic supports.
 */
function formatMultiple(ratio: number): string {
  if (!Number.isFinite(ratio)) return 'above';
  if (ratio >= 10) return `${Math.floor(ratio)} times`;
  return `${(Math.floor(ratio * 10) / 10).toFixed(1)} times`;
}

function dayPhrase(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

/* -------------------------------------------------------------------------- */
/* Reading the record                                                         */
/* -------------------------------------------------------------------------- */

/** A single agency use value written out: "retail sales" becomes "Retail". */
function expandUse(raw: string | null): string | null {
  return raw === null ? null : expandUseLabel({ proposedUse: raw, existingUse: null });
}

/** The building use as a phrase, naming a change of use when there is one. */
function useSentence(permit: NormalizedPermit): string | null {
  const existing = expandUse(permit.existingUse);
  const proposed = expandUse(permit.proposedUse);
  if (existing !== null && proposed !== null && existing !== proposed) {
    return `${existing} to ${proposed}`;
  }
  return proposed ?? existing;
}

/** The most recent date the record carries, or `null` when it carries none. */
function lastMoved(permit: NormalizedPermit): string | null {
  const dates = [permit.statusDate, permit.issuedDate, permit.approvedDate, permit.filedDate];
  let best: { iso: string; ms: number } | null = null;
  for (const iso of dates) {
    if (iso === null) continue;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    if (best === null || ms > best.ms) best = { iso, ms };
  }
  return best === null ? null : best.iso;
}

function daysSince(iso: string, now: number): number | null {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor((now - ms) / MS_PER_DAY));
}

/** One Finding by key, or `null`. */
function finding(findings: readonly FindingRecord[], key: string): FindingRecord | null {
  return findings.find((row) => row.key === key) ?? null;
}

/** A Finding's value as a non-empty string, or `null` when it is not established. */
function findingText(findings: readonly FindingRecord[], key: string): string | null {
  const row = finding(findings, key);
  if (row === null || row.value === null) return null;
  const text = String(row.value).trim();
  return text.length > 0 ? text : null;
}

/* -------------------------------------------------------------------------- */
/* The four questions                                                         */
/* -------------------------------------------------------------------------- */

/**
 * "What it is".
 *
 * The stored `summary` is the answer for a live lead: the drafting layer writes
 * it as the scope of work plus the address. On an ARCHIVED row that same column
 * holds the reason the lead was held back, which is a true sentence about the
 * decision and a wrong answer to "what is this job", so the city's own
 * description is used instead and the archive reason is reported under the score.
 *
 * The description is written by permit applicants and is not under our editorial
 * control, so it goes through the copy policy before it is shown.
 */
function whatItIs(opportunity: OpportunityRecord, permit: NormalizedPermit | null): string {
  const summary = opportunity.summary?.trim() ?? '';
  if (opportunity.status !== 'archived' && summary.length > 0) return summary;

  const description = permit?.description?.trim() ?? '';
  if (description.length > 0 && isCustomerSafe(description)) return description;

  if (permit !== null) {
    const work = permit.permitTypeDefinition;
    const use = useSentence(permit);
    if (work !== null && use !== null) return `${sentenceCase(work)} on a ${use.toLowerCase()} building.`;
    if (work !== null) return `${sentenceCase(work)}.`;
    if (use !== null) return `Permitted work on a ${use.toLowerCase()} building.`;
  }
  if (summary.length > 0) return summary;
  return 'The permit publishes no description of the work.';
}

/**
 * "Why it fits", from the fit and value signals in plain words.
 *
 * Use and valuation come off the permit and the subscriber's own profile, so both
 * sentences are checkable against both records. The scope sentence is read from
 * the fit driver the scorer recorded, because whether the trade is actually named
 * in the scope of work is the one fit signal that is not a raw permit column.
 */
function whyItFits(
  opportunity: OpportunityRecord,
  permit: NormalizedPermit | null,
  customer: CustomerRecord | null,
): string {
  const clauses: string[] = [];

  /* --- the building ------------------------------------------------------ */
  const use = permit === null ? null : useSentence(permit);
  if (permit === null || use === null) {
    clauses.push('The permit publishes no building use, so the match on building type is unconfirmed.');
  } else if (customer === null) {
    clauses.push(`Building use is ${use.toLowerCase()}.`);
  } else {
    const preferred = new Set(customer.preferredUses.map((entry) => entry.trim().toLowerCase()));
    const matched =
      (permit.existingUse !== null && preferred.has(permit.existingUse)) ||
      (permit.proposedUse !== null && preferred.has(permit.proposedUse));
    clauses.push(
      matched
        ? `${use} is on the list of work you asked for.`
        : `${use} is not on the list of work you asked for.`,
    );
  }

  /* --- the money --------------------------------------------------------- */
  const valuation = permit?.valuation ?? null;
  const floor = customer?.minProjectValue ?? null;
  if (valuation === null) {
    clauses.push(
      floor === null
        ? 'The permit publishes no cost figure, so the size of the job is unconfirmed.'
        : `The permit publishes no cost figure, so size against your ${usd(floor)} minimum is unconfirmed.`,
    );
  } else if (floor === null || floor <= 0) {
    clauses.push(`Declared at ${usd(valuation)}.`);
  } else if (valuation >= floor) {
    clauses.push(`${usd(valuation)} is ${formatMultiple(valuation / floor)} your ${usd(floor)} minimum.`);
  } else {
    clauses.push(`${usd(valuation)} is under your ${usd(floor)} minimum.`);
  }

  /* --- the scope of work, as the scorer read it -------------------------- */
  const trade = customer?.trade ?? 'electrical';
  const scopeDriver = opportunity.drivers.find(
    (driver) =>
      driver.reason.startsWith('Scope of work names') ||
      driver.reason.startsWith('Permit carries no description'),
  );
  if (scopeDriver !== undefined) {
    if (scopeDriver.reason.startsWith('Permit carries no description')) {
      clauses.push(`The permit carries no scope of work, so ${trade} content could not be read.`);
    } else if (scopeDriver.reason.includes('does not fit')) {
      clauses.push(`The scope of work as filed names no ${trade} work.`);
    } else {
      clauses.push(`The scope of work names ${scopeDriver.reason.slice('Scope of work names '.length)}.`);
    }
  }

  return clauses.join(' ');
}

/**
 * "Why now", from the permit clock and the gap on the contact roster.
 *
 * The opening is the interesting half. DBI names subcontractors on 3 of 22,148
 * contact rows, so a roster that lists a builder and no electrical firm is a real
 * signal that the package is still open. That reading is already stored as a
 * Finding and is quoted here rather than recomputed.
 */
function whyNow(
  permit: NormalizedPermit | null,
  findings: readonly FindingRecord[],
  now: number,
): string {
  const clauses: string[] = [];

  const status = permit?.status ?? null;
  const moved = permit === null ? null : lastMoved(permit);
  const days = moved === null ? null : daysSince(moved, now);

  if (status !== null && days !== null) {
    clauses.push(`Permit is ${status} and last moved ${dayPhrase(days)}.`);
  } else if (status !== null) {
    clauses.push(`Permit is ${status}. The record carries no usable date, so how recently it moved is unknown.`);
  } else if (days !== null) {
    clauses.push(`The permit last moved ${dayPhrase(days)}.`);
  } else {
    clauses.push('The permit publishes no status or date, so how recently it moved is unknown.');
  }

  const named = finding(findings, 'permit.electrical_sub_named');
  if (named !== null) {
    if (named.value === false) {
      clauses.push('No electrical contractor is named on the permit yet.');
    } else if (named.value === true) {
      clauses.push('An electrical firm is already named on the permit.');
    } else {
      clauses.push('Whether an electrical contractor is already on the job could not be established.');
    }
  }

  return clauses.join(' ');
}

/* -------------------------------------------------------------------------- */
/* Loading                                                                    */
/* -------------------------------------------------------------------------- */

interface LeadView {
  opportunity: OpportunityRecord;
  permit: PermitRecord | null;
  normalized: NormalizedPermit | null;
  findings: FindingRecord[];
  customer: CustomerRecord | null;
  permitNumber: string | null;
}

type LoadResult =
  | { state: 'unconfigured'; missing: string[] }
  | { state: 'failed' }
  | { state: 'not_found' }
  | { state: 'other_account' }
  | { state: 'ok'; view: LeadView };

async function load(id: string): Promise<LoadResult> {
  if (!isStoreReady()) return { state: 'unconfigured', missing: missingKeys('supabase') };

  try {
    const opportunity = await getOpportunity(id);
    if (opportunity === null) return { state: 'not_found' };

    /* The demo's single subscriber stands in for the signed-in account, so a lead
     * belonging to someone else is declined rather than rendered. */
    const customer = await getPrimaryCustomer();
    if (customer !== null && customer.id !== opportunity.customerId) {
      return { state: 'other_account' };
    }

    const candidate = await getCandidate(opportunity.candidateId);
    const [permit, findings] = await Promise.all([
      candidate === null ? Promise.resolve(null) : getPermit(candidate.permitNumber),
      listFindings(opportunity.candidateId),
    ]);

    // The projection is stored as `jsonb`, so it is re-validated on the way out.
    let normalized: NormalizedPermit | null = null;
    if (permit !== null) {
      const parsed = normalizedPermitSchema.safeParse(permit.normalized);
      normalized = parsed.success ? parsed.data : null;
    }

    return {
      state: 'ok',
      view: {
        opportunity,
        permit,
        normalized,
        findings,
        customer,
        permitNumber: candidate?.permitNumber ?? null,
      },
    };
  } catch (error) {
    /* The reason belongs in the server log, not on a subscriber's screen. */
    console.error('[lead detail] load failed:', error);
    return { state: 'failed' };
  }
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Only what this screen adds. The palette, the font, the frame and the tab bar
 * all come from `contractor.css`, which this file does not own and does not
 * touch: every rule below is a new `lv-ld-` class reading the existing `--lv-`
 * tokens, so nothing here can repaint another screen.
 */
const STYLES = `
.lv-ld-back { padding: 14px 16px 0; }
.lv-ld-back a {
  display: inline-block;
  padding: 6px 4px;
  color: var(--lv-accent);
  font-size: 13px;
  font-weight: 600;
  text-decoration: none;
}
.lv-ld-back a:hover { text-decoration: underline; }

.lv-ld-head { display: flex; flex-direction: column; gap: 10px; padding: 6px 20px 0; }
.lv-ld-dial { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.lv-ld-title {
  margin: 0;
  font-size: 19px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.3;
  color: var(--lv-ink);
  text-wrap: pretty;
}
.lv-ld-sub { margin: 3px 0 0; font-size: 13px; line-height: 1.45; color: var(--lv-muted); }
.lv-ld-state { margin: 0; font-size: 12.5px; line-height: 1.45; color: var(--lv-muted); }
.lv-ld-state[data-delivered="true"] { color: var(--lv-green); font-weight: 600; }
.lv-ld-flag {
  margin: 0;
  padding: 10px 12px;
  border: 1px solid #f0cfc9;
  border-radius: var(--lv-radius-sm);
  background: #fceded;
  font-size: 12.5px;
  line-height: 1.45;
  color: #8c3a31;
}
.lv-ld-flag strong { font-weight: 700; }

.lv-ld-grid { display: grid; grid-template-columns: 86px 1fr; gap: 10px; margin: 4px 0 0; font-size: 13px; }
.lv-ld-grid dt { color: var(--lv-muted); font-weight: 600; line-height: 1.45; }
.lv-ld-grid dd { margin: 0; color: var(--lv-ink-2); line-height: 1.45; overflow-wrap: anywhere; }
.lv-ld-strong { color: var(--lv-ink); font-weight: 700; }
.lv-ld-quiet { color: var(--lv-faint); }

.lv-ld-bars { padding: 10px 0 2px; }

.lv-ld-section { padding: 16px 20px 0; }
.lv-ld-section h2 {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--lv-muted);
}
.lv-ld-action { margin: 0; font-size: 13px; line-height: 1.55; color: var(--lv-ink-2); }

.lv-ld-prov {
  margin: 0;
  padding: 18px 20px 20px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--lv-faint);
  overflow-wrap: anywhere;
}
.lv-ld-prov strong { color: var(--lv-muted); font-weight: 700; }

.lv-ld-notice-back { margin: 0 14px 14px; font-size: 13px; }
.lv-ld-notice-back a { color: var(--lv-accent); font-weight: 600; text-decoration: none; }
.lv-ld-notice-back a:hover { text-decoration: underline; }
`;

/* -------------------------------------------------------------------------- */
/* Shell pieces                                                               */
/* -------------------------------------------------------------------------- */

function Screen({ children }: { children: ReactNode }) {
  return (
    <section className="lv-screen-fill" data-lv-screen="leads">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      {children}
    </section>
  );
}

function Notice({ title, body, keys }: { title: string; body: string; keys?: readonly string[] }) {
  return (
    <Screen>
      <div className="lv-notice">
        <p className="lv-notice-title">{title}</p>
        <p className="lv-notice-body">{body}</p>
        {keys !== undefined && keys.length > 0 ? (
          <p className="lv-notice-keys">Missing keys: {keys.join(', ')}</p>
        ) : null}
      </div>
      <p className="lv-ld-notice-back">
        <Link href={INBOX_HREF}>&#8592; Back to your leads</Link>
      </p>
    </Screen>
  );
}

/* -------------------------------------------------------------------------- */
/* Screen                                                                     */
/* -------------------------------------------------------------------------- */

export default async function LeadDetailScreen({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await load(id);

  if (result.state === 'unconfigured') {
    return (
      <Notice
        title="This lead is not reachable"
        body="This deployment has no connection to the records store, so the project behind this link cannot be read. Nothing is being hidden from you; there is nothing to read."
        keys={result.missing}
      />
    );
  }
  if (result.state === 'failed') {
    return (
      <Notice
        title="This lead could not be loaded"
        body="Something went wrong reading the record. Nothing has been changed. Try again in a moment."
      />
    );
  }
  if (result.state === 'not_found') {
    return (
      <Notice
        title="No lead with that reference"
        body="Nothing is stored under this link. Rather than show you a similar project, this screen says so."
      />
    );
  }
  if (result.state === 'other_account') {
    return (
      <Notice
        title="That lead is not on your account"
        body="This link points at a project scored for a different subscriber, so it is not shown here."
      />
    );
  }

  const { opportunity, permit, normalized, findings, customer, permitNumber } = result.view;

  const score = Math.round(opportunity.score);
  const accent = gaugeAccent(score);
  const now = Date.now();
  const delivered = opportunity.status === 'delivered';

  /* Named by the same function as the inbox row, so the two never disagree. */
  const title = normalized === null ? `Permit ${permitNumber ?? 'not on file'}` : composeLeadTitle(normalized);
  const subtitle = normalized === null ? null : composeLeadSubtitle(normalized);

  /* --- delivery state, stated rather than assumed ------------------------ */
  const deliveredOn = formatMoment(opportunity.deliveredAt);
  const stateLine = delivered
    ? deliveredOn === null
      ? 'Sent to you.'
      : `Sent to you ${deliveredOn}.`
    : opportunity.status === 'pending'
      ? 'Scored for you and not sent yet. You are seeing it before the message goes out.'
      : `Held back, not sent.${opportunity.summary === null ? '' : ` ${opportunity.summary}`}`;

  /* --- who to call ------------------------------------------------------- */
  const contactName = findingText(findings, 'gc.contact_name');
  const firmName = findingText(findings, 'gc.firm_name');
  const licenseNumber = findingText(findings, 'gc.license_number');
  const firmFinding = finding(findings, 'gc.firm_name');

  /* --- provenance -------------------------------------------------------- */
  const provenance = permit?.provenance ?? null;
  const permitSource =
    provenance !== null && isSourceId(provenance.sourceId)
      ? getSource(provenance.sourceId)
      : getSource('datasf.building_permits');
  const datasetId = provenance?.datasetId ?? permitSource.datasetId;
  const retrieved = formatMoment(provenance?.retrievedAt ?? null);
  const currentAs = formatDay(provenance?.dataAsOf ?? null);

  return (
    <Screen>
      {/* 1. back to the inbox */}
      <div className="lv-ld-back">
        <Link href={INBOX_HREF}>&#8592; Inbox</Link>
      </div>

      <div className="lv-ld-head">
        {/* 2. the number */}
        <div className="lv-ld-dial">
          <ScoreGauge score={score} />
          <ScoreBadge score={score} />
        </div>

        {/* 3. what and where the job is, from the permit's own columns */}
        <div>
          <h1 className="lv-ld-title">{title}</h1>
          {subtitle === null ? null : <p className="lv-ld-sub">{subtitle}</p>}
        </div>

        <p className="lv-ld-state" data-delivered={delivered ? 'true' : 'false'}>
          {stateLine}
        </p>

        {opportunity.fatalFlags.map((flag) => (
          <p className="lv-ld-flag" key={flag.code}>
            <strong>Worth knowing: </strong>
            {flag.message}
          </p>
        ))}

        {/* 4. the four questions */}
        <dl className="lv-ld-grid">
          <dt>What it is</dt>
          <dd>{whatItIs(opportunity, normalized)}</dd>

          <dt>Why it fits</dt>
          <dd>{whyItFits(opportunity, normalized, customer)}</dd>

          <dt>Who to call</dt>
          <dd>
            {firmName === null ? (
              <span className="lv-ld-quiet">
                No contractor of record is named on this permit yet.
                {firmFinding === null || firmFinding.note.trim().length === 0
                  ? ''
                  : ` ${firmFinding.note.trim()}.`}
              </span>
            ) : (
              <>
                {contactName === null ? null : (
                  <>
                    <span className="lv-ld-strong">{contactName}</span> at{' '}
                  </>
                )}
                <span className="lv-ld-strong">{firmName}</span>, listed on the permit as the
                contractor.
                {contactName === null ? ' No individual is named on the contractor row.' : ''}
                {licenseNumber === null ? '' : ` License ${licenseNumber}.`}{' '}
                <span className="lv-ld-quiet">
                  The permit contact record carries a name and a firm and no phone number, so there
                  is no number to dial from this screen.
                </span>
              </>
            )}
          </dd>

          <dt>Why now</dt>
          <dd>{whyNow(normalized, findings, now)}</dd>
        </dl>

        {/* 5. where the points came from */}
        <div className="lv-ld-bars">
          <DriverBars subtotals={opportunity.componentSubtotals} accent={accent} />
        </div>
      </div>

      {/* 6. every fact, with the label that says how well we know it */}
      <section className="lv-ld-section">
        <h2>Evidence</h2>
        <EvidenceTable findings={findings} />
      </section>

      {/* 7. the next step */}
      <section className="lv-ld-section">
        <h2>Recommended action</h2>
        <p className="lv-ld-action">
          {opportunity.recommendedAction === null ? (
            <span className="lv-ld-quiet">
              {opportunity.status === 'archived'
                ? `No next step was written for this one. It scored ${score} against a bar of ${LEAD_SCORE_THRESHOLD}, so it was held back rather than sent to you.`
                : 'No next step has been written for this lead yet.'}
            </span>
          ) : (
            opportunity.recommendedAction
          )}
        </p>
      </section>

      {/* Provenance, so the record can be checked against the city's own copy */}
      <p className="lv-ld-prov">
        <strong>Source: </strong>
        DataSF {permitSource.name}, dataset {datasetId}
        {permitNumber === null ? '.' : `. Permit ${permitNumber}.`}
        {retrieved === null ? '' : ` Retrieved ${retrieved} San Francisco time.`}
        {currentAs === null ? '' : ` The city reports this record current as of ${currentAs}.`}
        {provenance?.replayed === true
          ? ' Released from a committed extract of real San Francisco permits, on the demo clock.'
          : ''}
      </p>

      {/* 8. the verdict */}
      <FeedbackBar
        opportunityId={opportunity.id}
        initialFeedback={opportunity.feedback}
        bottomOffset={TABBAR_HEIGHT}
      />
    </Screen>
  );
}
