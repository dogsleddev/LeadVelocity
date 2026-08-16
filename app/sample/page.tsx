/**
 * S1, the public sample: the one screen a contractor sees before they pay.
 *
 * A prospect reaches this page from a text message or from a QR code on a card,
 * on a phone, with no account and no context. It therefore renders standalone,
 * carries no navigation, and answers one question: is this worth a subscription.
 * It answers it by showing a real job.
 *
 * WHY IT LIVES OUTSIDE /app
 * -------------------------
 * Everything under `/app` is for somebody who has already bought. This page is
 * for somebody who has not, so it sits at its own URL with no tab bar and no
 * account chip, and it is the only contractor screen with a price on it. It still
 * wears `.lv-app`, which is what carries the light palette from
 * `app/app/contractor.css`. The operations console is a route group of its own,
 * `app/(owner)/`, so nothing of the owner's reaches this page to be suppressed.
 *
 * WHAT IS ON THE PAGE, AND WHERE IT COMES FROM
 * --------------------------------------------
 * The hero is the highest scoring opportunity in the store, whatever its delivery
 * state, assembled from the permit record and the Findings behind it. The title
 * and subtitle are composed by `composeLeadTitle` and `composeLeadSubtitle` from
 * `LeadCard`, and the score dial and pill are the same components the inbox and
 * the detail screen use, so a prospect who subscribes meets the same job named
 * the same way on the inside. The four rows are the prototype's hero rows:
 *
 *   What it is   normalized.description, quoted from the city
 *   Why it fits  the declared valuation against the subscriber's floor
 *   Who to call  gc.contact_name and gc.firm_name Findings
 *   Why now      permit status and date, plus whether the trade is already taken
 *
 * WHAT IS DELIBERATELY ABSENT (hard rule #3, nothing is fabricated)
 * -----------------------------------------------------------------
 * There is no project name, because permits do not carry one; the address is the
 * name. There is no square footage, because it appears in 3.8 percent of
 * descriptions and in no structured column. There is no job title against the
 * contact, because the contacts dataset publishes roles rather than titles. There
 * is no phone number and therefore no call button, because that dataset has no
 * phone column at all: "who to call" is a name and a firm, and the page claims
 * nothing more. Each gap is rendered as an honest line or left off entirely.
 *
 * THE SCORE IS REPORTED, NOT FLATTERED
 * ------------------------------------
 * The delivery bar is `LEAD_SCORE_THRESHOLD`. If the best job on the board did
 * not clear it, the page says so, because selectivity is the product: a prospect
 * told "this one was held back" learns more about what they are buying than one
 * shown a number with no bar behind it. Nothing is called delivered unless
 * `opportunities.status` is exactly `delivered`.
 *
 * THE ASK NEVER DEAD ENDS
 * -----------------------
 * With `STRIPE_PAYMENT_LINK_URL` set, the button is checkout. Without it, the
 * button becomes the real alternative rather than a dead control: a message to
 * the number this company answers on, which is also how the delivery channel
 * expects first contact to happen. With neither configured, the panel states the
 * price and says plainly that checkout is not open on this deployment, and no
 * button is drawn at all.
 *
 * COPY RULES (hard rule #9): no AI, agent, autonomous, automated or LLM language,
 * and no em dashes. The permit description is quoted from the city and labelled
 * as the city's words, so the agency's own vocabulary is never rewritten.
 */
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/*
 * `useLabel` is aliased on import. It is a plain pure function, but its name
 * matches the React hook convention and calling it from a helper that is not a
 * component would read as a hook call to both a linter and a human.
 */
import {
  composeLeadSubtitle,
  composeLeadTitle,
  useLabel as buildingUseLabel,
} from '@/app/components/contractor/LeadCard';
import { formatUsd, monthlyPriceUsd } from '@/app/components/contractor/ProfileRow';
import ScoreBadge from '@/app/components/contractor/ScoreBadge';
import ScoreGauge from '@/app/components/contractor/ScoreGauge';
import { getSource, isSourceId } from '@/lib/adapters/sources/registry';
import { LEAD_SCORE_THRESHOLD } from '@/lib/calculations/scoring/lead-score';
import { missingKeys, optionalEnv } from '@/lib/config/deployment-env';
import { activeChannel } from '@/lib/delivery/channel';
import { type NormalizedPermit, normalizedPermitSchema } from '@/lib/domain/permit-normalizer';
import type { EvidenceLabel } from '@/lib/domain/schemas/core';
import {
  type CustomerRecord,
  type FindingRecord,
  type OpportunityRecord,
  getCandidate,
  getCustomer,
  getPermit,
  getPrimaryCustomer,
  isStoreReady,
  listFindings,
  listOpportunities,
} from '@/lib/store';

/*
 * The palette, the shell and the suppression of the operations console header and
 * footer all live in the contractor stylesheet. It is imported here rather than
 * copied, so this page cannot drift from the screens it is selling.
 */
import '@/app/app/contractor.css';

/** The board changes as the pipeline runs; this page is never cached. */
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'A project in your territory',
  description:
    'One real San Francisco permit, scored, with the work, the money, and who to call. From permit to pipeline.',
};

/** Ceiling on the scan for the best job. The board is small; this is headroom. */
const SCAN_LIMIT = 200;

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

const DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

function formatDay(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? DAY.format(new Date(ms)) : null;
}

/**
 * First letter up, everything else exactly as the agency published it.
 *
 * Used on the scope description, which is free text rather than controlled
 * vocabulary. Title casing it would rewrite street names and anything else the
 * writer capitalised on purpose, which is editing the record.
 */
function sentenceCase(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return trimmed;

  /*
   * Permit descriptions routinely open on a dotted trade abbreviation: "t.i. for
   * 1st flr", "m.e.p. rough-in". Raising only the first letter turns those into
   * "T.i.", which reads as a typo rather than as the city's shorthand, so a
   * leading abbreviation of that exact shape is raised whole. Nothing else in
   * the string is touched.
   */
  const [first = ''] = trimmed.split(/\s+/, 1);
  if (/^[a-z](?:\.[a-z])+\.?$/.test(first)) {
    return `${first.toUpperCase()}${trimmed.slice(first.length)}`;
  }
  return `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
}

/**
 * End a clause with exactly one full stop.
 *
 * Firm names carry their own: "Build Group Inc." followed by a period we added
 * gives "Inc..", which looks like a rendering bug in the one place on the page a
 * contractor is meant to trust the detail.
 */
function endSentence(value: string): string {
  const trimmed = value.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/**
 * A US number the way it is dialled, when it is a shape we recognise.
 *
 * An unrecognised shape is returned untouched rather than reformatted into
 * something that looks right and is not.
 */
function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

/* -------------------------------------------------------------------------- */
/* Evidence chips                                                             */
/* -------------------------------------------------------------------------- */

const EVIDENCE_WORDS: Readonly<Record<EvidenceLabel, string>> = Object.freeze({
  verified: 'Verified',
  corroborated: 'Corroborated',
  inferred: 'Inferred',
  unknown: 'Unknown',
});

const EVIDENCE_ORDER: readonly EvidenceLabel[] = ['verified', 'corroborated', 'inferred', 'unknown'];

/**
 * The four label colours, matching `EvidenceTable` on the detail screen.
 *
 * Written as class names rather than reusing that component: this screen shows
 * one chip per hero row, not a table of every Finding, and a cold prospect
 * scrolling seventeen rows on a phone is a worse first impression than four
 * labelled facts and a legend. The full table is one subscription away.
 */
function EvidenceChip({ evidence, count }: { evidence: EvidenceLabel; count?: number }) {
  return (
    <span className={`lvs-chip lvs-chip--${evidence}`}>
      {EVIDENCE_WORDS[evidence]}
      {count === undefined ? '' : ` ${count}`}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

function findingFor(findings: readonly FindingRecord[], key: string): FindingRecord | null {
  return findings.find((finding) => finding.key === key) ?? null;
}

function findingText(finding: FindingRecord | null): string | null {
  if (finding === null || finding.value === null) return null;
  const text = String(finding.value).trim();
  return text.length > 0 ? text : null;
}

/* -------------------------------------------------------------------------- */
/* Hero assembly                                                              */
/* -------------------------------------------------------------------------- */

/** One line of the hero card: a labelled fact carrying how well we know it. */
interface HeroRow {
  label: string;
  text: string;
  evidence: EvidenceLabel;
}

interface Hero {
  score: number;
  title: string;
  subtitle: string | null;
  rows: HeroRow[];
  /** True when the scope row is the city's own text rather than our wording. */
  scopeQuoted: boolean;
  /** Count of stored Findings at each evidence label, for the legend. */
  counts: Record<EvidenceLabel, number>;
  provenance: string | null;
  /** One sentence about the bar and what happened to this record. */
  verdict: string;
}

/**
 * "Why it fits", built only from numbers that are on the record.
 *
 * The building use clause appears only when the use really is on the subscriber's
 * list, and the money clause only when the permit declares a valuation. With
 * neither available the row states what the screen is, which is still true.
 */
function buildFitText(permit: NormalizedPermit | null, customer: CustomerRecord | null): string {
  const clauses: string[] = [];

  const use = (permit?.proposedUse ?? permit?.existingUse ?? null)?.toLowerCase() ?? null;
  const wanted = customer?.preferredUses.map((value) => value.toLowerCase()) ?? [];
  if (use !== null && wanted.includes(use)) {
    const label = buildingUseLabel({ proposedUse: use, existingUse: null }) ?? use;
    clauses.push(`${label} is one of the building uses we screen for.`);
  }

  const valuation = permit?.valuation ?? null;
  const floor = customer?.minProjectValue ?? null;
  if (valuation !== null && floor !== null) {
    clauses.push(
      `The permit declares ${formatUsd(valuation)} of work, against a ${formatUsd(floor)} floor.`,
    );
  } else if (valuation !== null) {
    clauses.push(`The permit declares ${formatUsd(valuation)} of work.`);
  }

  if (clauses.length === 0) {
    return 'Commercial work in San Francisco, inside the territory we read every day.';
  }
  return clauses.join(' ');
}

/**
 * "Who to call": a name and a firm.
 *
 * Never a number, because the contacts dataset has no phone or email column, and
 * never a job title, because it publishes roles rather than titles. The licence
 * number is added when the roster carries one, since that is the detail a
 * contractor uses to check who they are dealing with.
 */
function buildContactRow(findings: readonly FindingRecord[]): HeroRow {
  const contact = findingFor(findings, 'gc.contact_name');
  const firm = findingFor(findings, 'gc.firm_name');
  const license = findingText(findingFor(findings, 'gc.license_number'));

  const contactName = findingText(contact);
  const firmName = findingText(firm);
  const suffix = license === null ? '' : ` License ${license}.`;

  if (contactName !== null && firmName !== null) {
    return {
      label: 'Who to call',
      text: `${endSentence(`${contactName} at ${firmName}`)}${suffix}`,
      evidence: contact?.evidence ?? 'unknown',
    };
  }
  if (firmName !== null) {
    return {
      label: 'Who to call',
      text: `${endSentence(firmName)} The permit names the firm but no individual.${suffix}`,
      evidence: firm?.evidence ?? 'unknown',
    };
  }
  return {
    label: 'Who to call',
    text: 'Not established. The permit roster names no contractor for this job yet.',
    evidence: 'unknown',
  };
}

/** "Why now": what the permit is doing, and whether the trade is already taken. */
function buildTimingRow(
  permit: NormalizedPermit | null,
  findings: readonly FindingRecord[],
): HeroRow {
  const clauses: string[] = [];
  let evidence: EvidenceLabel = 'unknown';

  const status = permit?.status ?? null;
  const moved = permit?.statusDate ?? permit?.issuedDate ?? permit?.filedDate ?? null;
  const movedDay = formatDay(moved);
  if (status !== null && movedDay !== null) {
    clauses.push(`Permit ${status.toLowerCase()} on ${movedDay}.`);
    evidence = 'verified';
  } else if (status !== null) {
    clauses.push(`Permit status is ${status.toLowerCase()}.`);
    evidence = 'verified';
  }

  const named = findingFor(findings, 'permit.electrical_sub_named');
  if (named !== null && named.value === false) {
    clauses.push('No electrical contractor is named on the permit roster.');
    evidence = named.evidence;
  } else if (named !== null && named.value === true) {
    clauses.push('An electrical contractor is already named on the permit roster.');
    evidence = named.evidence;
  }

  if (clauses.length === 0) {
    return {
      label: 'Why now',
      text: 'Not established. The city has published no dated movement on this permit.',
      evidence: 'unknown',
    };
  }
  return { label: 'Why now', text: clauses.join(' '), evidence };
}

/**
 * What happened to this record, said plainly.
 *
 * `pending` is a scored job that has not been messaged yet and is described that
 * way. Only `delivered` is called delivered.
 */
function buildVerdict(opportunity: OpportunityRecord): string {
  const score = Math.round(opportunity.score);
  const bar = LEAD_SCORE_THRESHOLD;

  if (opportunity.fatalFlags.length > 0) {
    return 'This job carries a disqualifying condition, so it is held back whatever the number says. Every job goes through the same filter.';
  }
  if (score < bar) {
    return `Our bar is ${bar} out of 100. This one scored ${score}, so it was not sent. Subscribers only hear about the jobs that clear the bar, and that is most of what they are paying for.`;
  }
  if (opportunity.status === 'delivered') {
    const day = formatDay(opportunity.deliveredAt);
    return day === null
      ? `Our bar is ${bar} out of 100. This one cleared it and went to the subscriber who covers this work.`
      : `Our bar is ${bar} out of 100. This one cleared it and went out on ${day} to the subscriber who covers this work.`;
  }
  return `Our bar is ${bar} out of 100. This one cleared it and is waiting to go out to the subscriber who covers this work.`;
}

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

type LoadResult =
  | { state: 'unconfigured'; missing: string[] }
  | { state: 'failed'; message: string }
  | { state: 'empty' }
  | { state: 'ok'; hero: Hero };

/**
 * Highest score wins, newest breaks a tie.
 *
 * Delivery state is deliberately not a filter. A scored job that has not been
 * messaged is still a real scored job, and the page reports its state rather than
 * pretending it went out.
 */
function pickBest(opportunities: readonly OpportunityRecord[]): OpportunityRecord | null {
  const sorted = [...opportunities].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
  return sorted[0] ?? null;
}

async function load(): Promise<LoadResult> {
  if (!isStoreReady()) return { state: 'unconfigured', missing: missingKeys('supabase') };

  try {
    const opportunity = pickBest(await listOpportunities({ limit: SCAN_LIMIT }));
    if (opportunity === null) return { state: 'empty' };

    const candidate = await getCandidate(opportunity.candidateId);
    const permitRecord = candidate === null ? null : await getPermit(candidate.permitNumber);

    let permit: NormalizedPermit | null = null;
    if (permitRecord !== null) {
      const parsed = normalizedPermitSchema.safeParse(permitRecord.normalized);
      permit = parsed.success ? parsed.data : null;
    }

    const [findings, customer] = await Promise.all([
      candidate === null ? Promise.resolve<FindingRecord[]>([]) : listFindings(candidate.id),
      getCustomer(opportunity.customerId).then((found) =>
        found === null ? getPrimaryCustomer() : found,
      ),
    ]);

    /* Scope, quoted from the city rather than reworded by us. */
    const description = permit?.description ?? null;
    const scopeQuoted = description !== null && description.trim().length > 0;
    const scopeRow: HeroRow = scopeQuoted
      ? { label: 'What it is', text: sentenceCase(description ?? ''), evidence: 'verified' }
      : {
          label: 'What it is',
          text: 'Not published. The city recorded no scope description on this permit.',
          evidence: 'unknown',
        };

    const counts: Record<EvidenceLabel, number> = {
      verified: 0,
      corroborated: 0,
      inferred: 0,
      unknown: 0,
    };
    for (const finding of findings) counts[finding.evidence] += 1;

    const provenanceRecord = permitRecord?.provenance ?? null;
    const registry =
      provenanceRecord !== null && isSourceId(provenanceRecord.sourceId)
        ? getSource(provenanceRecord.sourceId)
        : null;
    const provenanceParts: string[] = [];
    if (candidate !== null) provenanceParts.push(`Permit ${candidate.permitNumber}`);
    if (registry !== null) {
      provenanceParts.push(`${registry.agency}, ${registry.name} (dataset ${registry.datasetId})`);
    }
    if (provenanceRecord !== null && provenanceRecord.replayed) {
      provenanceParts.push('Released from the committed extract of real San Francisco permits');
    }

    /*
     * The title and subtitle need the permit's own columns. Without a readable
     * permit there is nothing honest to compose them from, so the permit number
     * stands in and the subtitle is dropped rather than invented.
     */
    const title =
      permit === null
        ? candidate === null
          ? 'A San Francisco commercial project'
          : `Permit ${candidate.permitNumber}`
        : composeLeadTitle(permit);

    return {
      state: 'ok',
      hero: {
        score: Math.round(opportunity.score),
        title,
        subtitle: permit === null ? null : composeLeadSubtitle(permit),
        rows: [
          scopeRow,
          { label: 'Why it fits', text: buildFitText(permit, customer), evidence: 'inferred' },
          buildContactRow(findings),
          buildTimingRow(permit, findings),
        ],
        scopeQuoted,
        counts,
        provenance: provenanceParts.length === 0 ? null : `${provenanceParts.join('. ')}.`,
        verdict: buildVerdict(opportunity),
      },
    };
  } catch (error) {
    return { state: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* The ask                                                                    */
/* -------------------------------------------------------------------------- */

type Ask =
  | { kind: 'checkout'; href: string }
  | { kind: 'message'; href: string; display: string }
  | { kind: 'unavailable' };

/**
 * What the button does, decided by what is actually configured.
 *
 * There is no fourth branch in which a button is drawn that goes nowhere. The
 * channel is asked which number is live rather than the two env keys being read
 * in a fixed order, so the number shown is the one that would answer.
 */
function resolveAsk(): Ask {
  const checkout = optionalEnv('STRIPE_PAYMENT_LINK_URL');
  if (checkout !== null) return { kind: 'checkout', href: checkout };

  const number =
    activeChannel() === 'linq'
      ? optionalEnv('LINQ_FROM_NUMBER')
      : optionalEnv('TWILIO_FROM_NUMBER');
  if (number !== null) {
    return {
      kind: 'message',
      href: `sms:${number.replace(/\s/g, '')}`,
      display: formatPhone(number),
    };
  }

  return { kind: 'unavailable' };
}

function PricePanel() {
  const ask = resolveAsk();
  const price = formatUsd(monthlyPriceUsd());

  return (
    <aside className="lvs-price">
      <p className="lvs-price-line">
        Jobs like this one, as the permits land. <strong>{price} per month.</strong>
      </p>

      {ask.kind === 'checkout' ? (
        <a className="lvs-cta" href={ask.href}>
          Start my subscription
        </a>
      ) : null}

      {ask.kind === 'message' ? (
        <>
          <a className="lvs-cta" href={ask.href}>
            Text {ask.display} to start
          </a>
          <p className="lvs-price-note">
            Send anything at all. We reply with the next job in your territory, and the terms.
          </p>
        </>
      ) : null}

      {ask.kind === 'unavailable' ? (
        <p className="lvs-price-note">
          Checkout is not open on this deployment yet, so there is nothing here to press. The price
          above is the whole price.
        </p>
      ) : null}

      <p className="lvs-price-fine">Cancel anytime.</p>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The standalone shell.
 *
 * `.lv-app` is what makes this page part of the contractor surface: it declares
 * the light palette and it paints the light ground. There is no frame, no tab bar
 * and no `data-lv-screen` marker, because none of those belong in front of
 * somebody who has not subscribed.
 */
function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="lv-app">
      <SampleStyles />
      <div className="lvs-page">
        <header className="lvs-brand">
          <p className="lvs-brand-name">
            Lead<span className="lvs-brand-mark">Velocity</span>
          </p>
          <p className="lvs-brand-tag">From permit to pipeline.</p>
        </header>

        <div className="lvs-cols">
          <div className="lvs-main">
            <h1 className="lvs-h1">A project in your territory worth a look.</h1>
            {children}
          </div>
          <div className="lvs-side">
            <PricePanel />
          </div>
        </div>
      </div>
    </div>
  );
}

/** A degraded hero. The offer below it still stands, so the page never ends. */
function Fallback({ title, body }: { title: string; body: string }) {
  return (
    <Shell>
      <div className="lvs-card">
        <p className="lvs-card-title">{title}</p>
        <p className="lvs-card-body">{body}</p>
      </div>
    </Shell>
  );
}

export default async function PublicSamplePage() {
  const result = await load();

  if (result.state === 'unconfigured') {
    return (
      <Fallback
        title="Today's job is not on the board"
        body={`This page reads live records and cannot reach them right now, so it is showing you nothing rather than something made up. Missing configuration: ${result.missing.join(', ')}. The offer stands.`}
      />
    );
  }

  if (result.state === 'failed') {
    return (
      <Fallback
        title="Today's job could not be loaded"
        body={`Reading the record failed on this request: ${result.message}. Rather than put an invented example in front of you, the page says so. The offer stands.`}
      />
    );
  }

  if (result.state === 'empty') {
    return (
      <Fallback
        title="Nothing has been scored yet"
        body="No permit in this territory has been through the reading yet, and we will not show you a job that does not exist. Start now and the first one that clears the bar goes straight to your phone."
      />
    );
  }

  const { hero } = result;

  return (
    <Shell>
      <article className="lvs-card">
        <div className="lvs-hero-head">
          <ScoreGauge score={hero.score} />
          <ScoreBadge score={hero.score} />
        </div>

        <div>
          <h2 className="lvs-hero-title">{hero.title}</h2>
          {hero.subtitle === null ? null : <p className="lvs-hero-sub">{hero.subtitle}</p>}
        </div>

        <div className="lvs-rows">
          {hero.rows.map((row) => (
            <div className="lvs-row" key={row.label}>
              <div className="lvs-row-label">{row.label}</div>
              <div className="lvs-row-text">
                {row.text} <EvidenceChip evidence={row.evidence} />
              </div>
            </div>
          ))}
        </div>

        {hero.scopeQuoted ? (
          <p className="lvs-fine">
            The scope line is quoted from the permit record, in the city&apos;s own words.
          </p>
        ) : null}

        <div className="lvs-legend">
          {EVIDENCE_ORDER.map((label) => (
            <EvidenceChip key={label} evidence={label} count={hero.counts[label]} />
          ))}
        </div>
        <p className="lvs-fine">
          Every fact we hold on this job carries how well we know it, including the ones we could
          not establish. Those stay on the page as unknown rather than being filled in.
        </p>

        {hero.provenance === null ? null : <p className="lvs-fine">{hero.provenance}</p>}
      </article>

      <p className="lvs-verdict">{hero.verdict}</p>
    </Shell>
  );
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Only what `contractor.css` does not already provide. Every colour and radius is
 * one of its `--lv-` tokens, declared on `.lv-app` and merely consumed here, so
 * this page holds no second copy of the palette. The literals are fallbacks.
 *
 * Layout follows the prototype: one column on a phone, and from 900px the desktop
 * split of hero card beside the price panel, which is the shape the closing slide
 * of the pitch is watched in.
 */
const SAMPLE_CSS = `
.lvs-page { width: 100%; max-width: 960px; padding: 0 18px 24px; }
@media (max-width: 439px) {
  .lvs-page { padding: 24px 18px 40px; }
}
.lvs-brand { margin-bottom: 18px; }
.lvs-brand-name { margin: 0; font-size: 18px; font-weight: 800; letter-spacing: -0.02em; }
.lvs-brand-mark { color: var(--lv-accent, #2878f0); }
.lvs-brand-tag {
  margin: 2px 0 0;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: .02em;
  color: var(--lv-muted, #66788a);
}
.lvs-cols { display: grid; grid-template-columns: 1fr; gap: 20px; align-items: start; }
.lvs-main { display: flex; flex-direction: column; gap: 16px; min-width: 0; }
.lvs-h1 {
  margin: 0;
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.25;
  text-wrap: pretty;
}
.lvs-card {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 18px 16px;
  border: 1px solid var(--lv-line, #d9e3ec);
  border-radius: 16px;
  background: var(--lv-card, #ffffff);
}
.lvs-card-title { margin: 0; font-size: 16px; font-weight: 700; }
.lvs-card-body {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--lv-ink-2, #3a4c61);
  text-wrap: pretty;
}
.lvs-hero-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.lvs-hero-title {
  margin: 0;
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -0.01em;
  line-height: 1.3;
  text-wrap: pretty;
}
.lvs-hero-sub { margin: 3px 0 0; font-size: 13px; color: var(--lv-muted, #66788a); }
.lvs-rows { display: flex; flex-direction: column; gap: 10px; }
.lvs-row {
  display: grid;
  grid-template-columns: 86px 1fr;
  gap: 10px;
  font-size: 13px;
  line-height: 1.5;
}
.lvs-row-label { color: var(--lv-muted, #66788a); font-weight: 600; }
.lvs-row-text { color: var(--lv-ink-2, #3a4c61); text-wrap: pretty; }
.lvs-legend { display: flex; flex-wrap: wrap; gap: 6px; }
.lvs-chip {
  display: inline-block;
  padding: 3px 10px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 700;
  white-space: nowrap;
}
.lvs-chip--verified {
  background: var(--lv-green-soft, #e9f6ef);
  color: var(--lv-green, #24966a);
  border-color: var(--lv-green-line, #bee3cf);
}
.lvs-chip--corroborated {
  background: var(--lv-accent-soft, #e9f1fd);
  color: var(--lv-accent, #2878f0);
  border-color: var(--lv-accent-line, #c4dbfa);
}
.lvs-chip--inferred { background: #fbf4e3; color: #a9741d; border-color: #e8d3a4; }
.lvs-chip--unknown {
  background: transparent;
  color: var(--lv-muted, #66788a);
  border-color: #c7d4e0;
}
.lvs-fine {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--lv-faint, #7d8a97);
  text-wrap: pretty;
}
.lvs-verdict {
  margin: 0;
  padding: 14px 16px;
  border-radius: var(--lv-radius-sm, 12px);
  background: var(--lv-hair, #edf3f9);
  font-size: 13px;
  line-height: 1.55;
  color: var(--lv-ink-2, #3a4c61);
  text-wrap: pretty;
}
.lvs-price {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 24px 20px;
  border-radius: 16px;
  background: var(--lv-accent-soft, #e9f1fd);
  text-align: center;
}
.lvs-price-line {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.45;
  color: var(--lv-accent-strong, #16407f);
  text-wrap: pretty;
}
.lvs-cta {
  display: block;
  min-height: 48px;
  padding: 14px;
  border-radius: 12px;
  background: var(--lv-accent, #2878f0);
  color: #ffffff;
  font-size: 15px;
  font-weight: 700;
  text-decoration: none;
}
.lvs-cta:hover { background: #1e63d0; color: #ffffff; }
.lvs-price-note {
  margin: 0;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--lv-ink-2, #3a4c61);
  text-wrap: pretty;
}
.lvs-price-fine { margin: 0; font-size: 12px; color: var(--lv-muted, #66788a); }
@media (min-width: 900px) {
  .lvs-cols { grid-template-columns: 1.15fr .85fr; gap: 28px; }
  .lvs-h1 { font-size: 28px; }
  .lvs-price { margin-top: 58px; }
}
`;

function SampleStyles() {
  return <style dangerouslySetInnerHTML={{ __html: SAMPLE_CSS }} />;
}
