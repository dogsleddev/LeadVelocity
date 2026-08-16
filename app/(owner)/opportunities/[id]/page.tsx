/**
 * One opportunity, in full. This is the screen shown on stage.
 *
 * It is laid out in the order a contractor's trust is actually built, and the
 * order is not negotiable:
 *
 *   1. The public record that triggered it, named and sourced. Before anything is
 *      claimed, the reader sees the permit, the address, the money, and the
 *      dataset it came out of. Nothing on this page was generated from roaming
 *      the web (hard rule #1).
 *   2. Everything we established about it, each fact carrying its evidence label.
 *      Facts we could not establish are on the page as unknowns rather than
 *      quietly missing (hard rule #3).
 *   3. The score, broken into the signed contributions that produced it. The
 *      arithmetic is deterministic and reproducible (hard rule #2); this page
 *      shows the working, not just the answer.
 *   4. The best path in, and 5. the single recommended action.
 *
 * COPY RULES (hard rule #9): everything rendered here is customer-facing. The
 * words AI, agent, autonomous, and LLM do not appear, nothing describes the
 * machinery, and there are no em dashes. The page sells the job and the opening,
 * which is what the reader is paying for.
 *
 * Nothing here is fabricated. Absent fields render as "not published" against the
 * permit and as "not established" against a Finding, and the two are different
 * claims: the first is about the city's record, the second is about our research.
 */
import type { ReactNode } from 'react';

import EvidenceBadge, { EvidenceLegend } from '@/app/components/EvidenceBadge';
import ReplayBadge from '@/app/components/ReplayBadge';
import ScoreDrivers from '@/app/components/ScoreDrivers';
import { getSource, isSourceId } from '@/lib/adapters/sources/registry';
import { LEAD_SCORE_THRESHOLD } from '@/lib/calculations/scoring/lead-score';
import { missingKeys } from '@/lib/config/deployment-env';
import {
  type NormalizedPermit,
  normalizedPermitSchema,
} from '@/lib/domain/permit-normalizer';
import type { Finding } from '@/lib/domain/schemas/core';
import {
  getCandidate,
  getCustomer,
  getOpportunity,
  getPermit,
  isStoreReady,
  type CustomerRecord,
  type OpportunityRecord,
  type PermitRecord,
  listFindings,
} from '@/lib/store';

export const dynamic = 'force-dynamic';

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

/** Calendar date in San Francisco time, e.g. `Mar 23, 2026`. */
const DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
});

/** Date and time in San Francisco time, for provenance lines. */
const MOMENT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function formatDay(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? DAY.format(new Date(ms)) : iso;
}

function formatMoment(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? `${MOMENT.format(new Date(ms))} SF time` : iso;
}

/** Whole dollars, grouped by hand so the output cannot drift with host locale. */
function usd(amount: number): string {
  const digits = Math.round(Math.abs(amount)).toString();
  let grouped = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ',';
    grouped += digits.charAt(index);
  }
  return `${amount < 0 ? '-' : ''}$${grouped}`;
}

/** Title case for the lowercased controlled vocabulary the city publishes. */
function titleCase(value: string): string {
  return value.replace(/\b[a-z]/g, (character) => character.toUpperCase());
}

/** A Finding value rendered for a table cell. `null` is a first-class answer. */
function renderValue(value: Finding['value']): ReactNode {
  if (value === null) return <span className="value-unknown">not established</span>;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return <span className="table-num">{value}</span>;
  return value;
}

/* -------------------------------------------------------------------------- */
/* Small presentational pieces                                                */
/* -------------------------------------------------------------------------- */

function Field({
  label,
  value,
  big = false,
}: {
  label: string;
  value: string | null;
  big?: boolean;
}) {
  return (
    <div className="record-field">
      <p className="record-label">{label}</p>
      <p className={big ? 'record-value record-value--big' : 'record-value'}>
        {value === null ? <span className="value-unknown">not published</span> : value}
      </p>
    </div>
  );
}

function Missing({ title, body }: { title: string; body: string }) {
  return (
    <>
      <div className="page-head">
        <h1 className="page-title">Opportunity</h1>
      </div>
      <div className="empty">
        <p className="empty-title">{title}</p>
        <p className="empty-body">{body}</p>
      </div>
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

interface OpportunityView {
  opportunity: OpportunityRecord;
  permit: PermitRecord | null;
  normalized: NormalizedPermit | null;
  findings: Finding[];
  customer: CustomerRecord | null;
  permitNumber: string | null;
  shortlistReason: string | null;
}

type LoadResult =
  | { state: 'unconfigured'; missing: string[] }
  | { state: 'failed'; message: string }
  | { state: 'not_found' }
  | { state: 'ok'; view: OpportunityView };

async function load(id: string): Promise<LoadResult> {
  if (!isStoreReady()) return { state: 'unconfigured', missing: missingKeys('supabase') };

  try {
    const opportunity = await getOpportunity(id);
    if (opportunity === null) return { state: 'not_found' };

    const candidate = await getCandidate(opportunity.candidateId);
    const permit = candidate === null ? null : await getPermit(candidate.permitNumber);

    let normalized: NormalizedPermit | null = null;
    if (permit !== null) {
      const parsed = normalizedPermitSchema.safeParse(permit.normalized);
      normalized = parsed.success ? parsed.data : null;
    }

    const [findings, customer] = await Promise.all([
      listFindings(opportunity.candidateId),
      getCustomer(opportunity.customerId),
    ]);

    return {
      state: 'ok',
      view: {
        opportunity,
        permit,
        normalized,
        findings,
        customer,
        permitNumber: candidate?.permitNumber ?? null,
        shortlistReason: candidate?.shortlistReason ?? null,
      },
    };
  } catch (error) {
    return { state: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

export default async function OpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const result = await load(id);

  if (result.state === 'unconfigured') {
    return (
      <Missing
        title="Persistence is not configured"
        body={`This record lives in Supabase, which this deployment cannot reach. Missing keys: ${result.missing.join(', ')}.`}
      />
    );
  }

  if (result.state === 'failed') {
    return <Missing title="This record could not be read" body={result.message} />;
  }

  if (result.state === 'not_found') {
    return (
      <Missing
        title="No opportunity with that reference"
        body={`Nothing is stored under ${id}. Rather than showing a similar record, the page says so.`}
      />
    );
  }

  const { opportunity, permit, normalized, findings, customer, permitNumber, shortlistReason } =
    result.view;

  const provenance = permit?.provenance ?? null;
  const registry =
    provenance !== null && isSourceId(provenance.sourceId) ? getSource(provenance.sourceId) : null;

  const clearedBar = opportunity.score >= LEAD_SCORE_THRESHOLD;
  const disqualified = opportunity.fatalFlags.length > 0;
  const heading = normalized?.address ?? (permitNumber === null ? 'Opportunity' : `Permit ${permitNumber}`);

  const place = [normalized?.neighborhood, normalized?.zipcode]
    .filter((piece): piece is string => typeof piece === 'string' && piece.length > 0)
    .join(', ');

  /*
   * The permit readout, assembled as data rather than as seventeen JSX elements.
   * Every entry is `string | null`, and `null` renders as "not published": the
   * city's silence is a fact about the record and is shown as one.
   */
  const permitFields: { label: string; value: string | null; big?: boolean }[] = [
    { label: 'Permit number', value: permitNumber, big: true },
  ];
  if (normalized !== null) {
    permitFields.push(
      {
        label: 'Project valuation',
        value: normalized.valuation === null ? null : usd(normalized.valuation),
        big: true,
      },
      { label: 'Status', value: normalized.status === null ? null : titleCase(normalized.status) },
      { label: 'Address', value: normalized.address },
      { label: 'Neighborhood', value: normalized.neighborhood },
      { label: 'Supervisor district', value: normalized.supervisorDistrict },
      { label: 'Zip', value: normalized.zipcode },
      { label: 'Filed', value: formatDay(normalized.filedDate) },
      { label: 'Issued', value: formatDay(normalized.issuedDate) },
      { label: 'Approved', value: formatDay(normalized.approvedDate) },
      { label: 'Completed', value: formatDay(normalized.completedDate) },
      {
        label: 'Permit type',
        value:
          normalized.permitTypeDefinition === null
            ? null
            : titleCase(normalized.permitTypeDefinition),
      },
      {
        label: 'Existing use',
        value: normalized.existingUse === null ? null : titleCase(normalized.existingUse),
      },
      {
        label: 'Proposed use',
        value: normalized.proposedUse === null ? null : titleCase(normalized.proposedUse),
      },
      { label: 'Occupancy', value: normalized.existingOccupancy },
      {
        label: 'Stories',
        value: normalized.storiesExisting === null ? null : String(normalized.storiesExisting),
      },
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{heading}</h1>
          <p className="page-sub">
            {place.length > 0 ? `${place}. ` : ''}
            {customer === null
              ? 'San Francisco.'
              : `Matched for ${customer.businessName}, ${customer.trade} work in San Francisco.`}
          </p>
        </div>
        <div className="page-head-side">
          <span className={`pill pill--${opportunity.status}`}>{opportunity.status}</span>
          {provenance !== null && provenance.replayed ? <ReplayBadge mode="replayed" /> : null}
        </div>
      </div>

      {opportunity.summary === null ? null : <p className="scope">{opportunity.summary}</p>}

      {/* ---------------------------------------------------------------- */}
      {/* 1. The record that triggered this                                 */}
      {/* ---------------------------------------------------------------- */}
      <section className="section">
        <h2 className="section-title">The permit that started this</h2>

        {normalized === null && permit === null ? (
          <div className="empty">
            <p className="empty-body">
              The permit behind this record is no longer in the store, so none of its fields are
              shown. The findings and the score below are still the ones that were computed from it.
            </p>
          </div>
        ) : (
          <>
            <div className="record">
              {permitFields.map((field) => (
                <Field key={field.label} label={field.label} value={field.value} big={field.big} />
              ))}
            </div>

            {normalized === null || normalized.description === null ? null : (
              <p className="scope">
                <strong>Scope of work as filed: </strong>
                {normalized.description}
              </p>
            )}

            {normalized !== null && normalized.valuation !== null ? (
              <p className="section-note">
                Valuation is the larger of the two cost columns the city publishes, taken here from
                the {normalized.valuationSource} cost figure.
              </p>
            ) : null}

            {provenance === null ? null : (
              <p className="provenance">
                <strong>Source: </strong>
                {registry === null ? 'DataSF Building Permits' : `${registry.agency}, ${registry.name}`}{' '}
                <span className="provenance-strong">{provenance.datasetId}</span>
                <br />
                Endpoint <span className="provenance-strong">{provenance.endpoint}</span>
                <br />
                Retrieved {formatMoment(provenance.retrievedAt) ?? provenance.retrievedAt}
                {provenance.dataAsOf === null
                  ? ''
                  : `. City reports the record current as of ${formatMoment(provenance.dataAsOf) ?? provenance.dataAsOf}`}
                {permit === null ? '' : `. Change status on last observation: ${permit.snapshotStatus.replace('_', ' ')}`}
                {provenance.replayed
                  ? '. This record was released by the replay harness from the committed extract of real San Francisco permits.'
                  : '.'}
              </p>
            )}

            {shortlistReason === null ? null : (
              <p className="section-note">
                <strong>Why this permit was picked up: </strong>
                {shortlistReason}
              </p>
            )}
          </>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 2. Findings                                                       */}
      {/* ---------------------------------------------------------------- */}
      <section className="section">
        <h2 className="section-title">What we established, and how well</h2>

        {findings.length === 0 ? (
          <div className="empty">
            <p className="empty-body">
              No facts have been recorded against this project yet. The score below was computed
              without them, which the evidence component reflects.
            </p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Fact</th>
                  <th scope="col">Value</th>
                  <th scope="col">Evidence</th>
                  <th scope="col">Observed</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((finding) => (
                  <tr key={finding.key}>
                    <td>
                      {finding.label}
                      <span className="table-key">{finding.key}</span>
                    </td>
                    <td>
                      {renderValue(finding.value)}
                      {finding.note.length === 0 ? null : (
                        <span className="value-note">{finding.note}</span>
                      )}
                    </td>
                    <td>
                      <EvidenceBadge evidence={finding.evidence} />
                    </td>
                    <td className="table-num">{formatDay(finding.observedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <EvidenceLegend />
        <p className="section-note">
          Anything we looked for and could not establish stays on this page as unknown. It is never
          filled in with a plausible value.
        </p>
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 3. Score                                                          */}
      {/* ---------------------------------------------------------------- */}
      <section className="section">
        <h2 className="section-title">Score, and every point behind it</h2>

        <div className="score-head">
          <span
            className={`score-figure ${clearedBar && !disqualified ? 'score-figure--over' : 'score-figure--under'}`}
          >
            {Math.round(opportunity.score)}
          </span>
          <span className="score-scale">
            out of 100. The delivery bar is {LEAD_SCORE_THRESHOLD}.{' '}
            {disqualified
              ? 'This project carries a disqualifying condition, so it is held back whatever the number says.'
              : clearedBar
                ? 'This project cleared the bar and was sent.'
                : 'This project did not clear the bar, so it was not sent.'}
            <br />
            Five components: fit 30, demand 25, timing 20, value 15, evidence 10. The same inputs
            always produce the same number.
          </span>
        </div>

        <ScoreDrivers drivers={opportunity.drivers} score={Math.round(opportunity.score)} />

        {opportunity.fatalFlags.length === 0 ? null : (
          <div className="notice-list">
            {opportunity.fatalFlags.map((flag, index) => (
              <p className="notice notice--fatal" key={`${index}-${flag.code}`}>
                <strong>Disqualifying: </strong>
                {flag.message}
              </p>
            ))}
          </div>
        )}

        {opportunity.warnings.length === 0 ? null : (
          <div className="notice-list">
            {opportunity.warnings.map((warning, index) => (
              <p className="notice notice--warning" key={`${index}-${warning}`}>
                {warning}
              </p>
            ))}
          </div>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* 4 and 5. Path in, and what to do                                  */}
      {/* ---------------------------------------------------------------- */}
      <section className="section">
        <div className="grid grid-2">
          <div className="card">
            <p className="card-title">Best path in</p>
            <p className="card-body">
              {opportunity.bestPathIn === null ? (
                <span className="value-unknown">
                  No contact path has been established for this project yet.
                </span>
              ) : (
                opportunity.bestPathIn
              )}
            </p>
          </div>
          <div className="card">
            <p className="card-title">Recommended action</p>
            <p className="card-body">
              {opportunity.recommendedAction === null ? (
                <span className="value-unknown">No next step has been recorded yet.</span>
              ) : (
                opportunity.recommendedAction
              )}
            </p>
          </div>
        </div>

        {opportunity.deliveredAt === null ? null : (
          <p className="section-note">
            Sent to the subscriber on {formatMoment(opportunity.deliveredAt)}.
            {opportunity.feedback === null
              ? ''
              : ` Reply on file: ${opportunity.feedback.replace('_', ' ')}.`}
          </p>
        )}
      </section>
    </>
  );
}
