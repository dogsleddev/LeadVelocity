/**
 * One row in the subscriber's inbox.
 *
 * WHAT THIS IS
 * ------------
 * The prototype's inbox card: score pill, relative time, title, subtitle, and a
 * line saying whether the lead has actually been sent. Plus the pure functions
 * that turn a permit record into that title and subtitle, exported here so the
 * opportunity detail screen names the same project the same way.
 *
 * WHAT IT REFUSES TO SHOW
 * -----------------------
 * The prototype's mock card reads "Arcadia Biosciences Lab Conversion, 31,500 SF
 * laboratory tenant improvement". Neither of those facts exists in the data:
 *
 * - There is NO project name. A DataSF permit has an address, a use code, a
 *   permit type and a free-text description. Composing "Arcadia Biosciences" out
 *   of that would be fabricating an entity (CLAUDE.md hard rule #3), and a
 *   contractor who quotes a project name we invented back to a general
 *   contractor has been actively harmed by this product.
 * - There is NO square footage. It appears in 3.8% of descriptions and is absent
 *   from every structured column.
 *
 * So the title is assembled from three real columns, `proposed_use` (falling
 * back to `existing_use`), `permit_type_definition`, and the assembled street
 * address, and the subtitle from the neighbourhood, the valuation and the permit
 * status. Where a column is empty the clause is dropped, and where the valuation
 * is unpublished the card says so rather than printing a zero.
 *
 * THE USE AND TYPE LABELS ARE EXPANSIONS, NOT INTERPRETATIONS
 * -----------------------------------------------------------
 * DataSF writes its vocabulary in a fixed-width field: `clinics-medic/dental`,
 * `warehouse,no frnitur`, `prkng garage/private`. The maps below spell those out
 * and do nothing else. No entry adds a fact the agency did not state, and an
 * unmapped value is title-cased and shown as the agency wrote it rather than
 * dropped, because a use we cannot pretty-print is still a use we observed.
 */
import Link from 'next/link';

import ScoreBadge from '@/app/components/contractor/ScoreBadge';
import { formatProjectValue } from '@/lib/copy/templates';
import type { NormalizedPermit } from '@/lib/domain/permit-normalizer';

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `existing_use` / `proposed_use` written out. Keys are the agency's exact
 * lowercase values, taken from the committed extract (n=10,880).
 */
const USE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  office: 'Office',
  'retail sales': 'Retail',
  'food/beverage hndlng': 'Food and beverage',
  'clinics-medic/dental': 'Medical or dental clinic',
  school: 'School',
  'tourist hotel/motel': 'Hotel',
  'warehouse,no frnitur': 'Warehouse',
  manufacturing: 'Manufacturing',
  church: 'Church',
  'lending institution': 'Lending institution',
  'prkng garage/private': 'Private parking garage',
  'prkng garage/public': 'Public parking garage',
  'barber/beauty salon': 'Salon',
  'health studios & gym': 'Gym',
  'workshop commercial': 'Commercial workshop',
  theater: 'Theater',
  'auto repairs': 'Auto repair',
  'recreation bldg': 'Recreation building',
  'laundry/laundromat': 'Laundry',
  'filling/service stn': 'Service station',
  'power plant': 'Power plant',
  'vacant lot': 'Vacant lot',
});

/**
 * `permit_type_definition` reduced to the work it describes, lowercase so it can
 * follow a use in a sentence: "Office alteration".
 */
const WORK_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'otc alterations permit': 'alteration',
  'additions alterations or repairs': 'addition or alteration',
  'new construction': 'new construction',
  'new construction wood frame': 'new construction',
  demolitions: 'demolition',
  'sign - erect': 'sign',
  'wall or painted sign': 'sign',
  'grade or quarry or fill or excavate': 'site work',
});

/** Permit statuses, capitalised. Anything unlisted is capitalised generically. */
function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

function tidy(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length === 0 ? null : trimmed;
}

/* -------------------------------------------------------------------------- */
/* Title and subtitle                                                         */
/* -------------------------------------------------------------------------- */

/** What the building is used for, written out, or `null` when unstated. */
export function useLabel(permit: Pick<NormalizedPermit, 'proposedUse' | 'existingUse'>): string | null {
  const raw = tidy(permit.proposedUse) ?? tidy(permit.existingUse);
  if (raw === null) return null;
  const key = raw.toLowerCase();
  return USE_LABELS[key] ?? capitalize(raw);
}

/** What kind of work the permit covers, lowercase, or `null` when unstated. */
export function workLabel(permit: Pick<NormalizedPermit, 'permitTypeDefinition'>): string | null {
  const raw = tidy(permit.permitTypeDefinition);
  if (raw === null) return null;
  const key = raw.toLowerCase();
  const mapped = WORK_LABELS[key];
  if (mapped !== undefined) return mapped;
  // Unmapped agency wording, minus the redundant trailing noun.
  return key.replace(/\s+permit$/, '');
}

/**
 * The project, named from real columns only.
 *
 *   "Office alteration, 1045 Sansome St"
 *   "Retail permit, 6001 California St"     (no permit type published)
 *   "Alteration, 388 Market St"             (no use published)
 *   "2 Henry Adams St"                      (neither published)
 *   "Permit 202212098045"                   (no address published)
 *
 * Never a company name, never a project name, never a size.
 */
export function composeLeadTitle(
  permit: Pick<
    NormalizedPermit,
    'proposedUse' | 'existingUse' | 'permitTypeDefinition' | 'address' | 'permitNumber'
  >,
): string {
  const use = useLabel(permit);
  const work = workLabel(permit);
  const address = tidy(permit.address);

  let scope: string | null;
  if (use !== null && work !== null) scope = `${use} ${work}`;
  else if (use !== null) scope = `${use} permit`;
  else if (work !== null) scope = capitalize(work);
  else scope = null;

  if (address === null) {
    return scope === null ? `Permit ${permit.permitNumber}` : `${scope}, permit ${permit.permitNumber}`;
  }
  return scope === null ? address : `${scope}, ${address}`;
}

/**
 * Where it is and what it is worth: "North Beach · $1.1M · Issued".
 *
 * An unpublished valuation is stated as unpublished. DBI writes "0.0" into
 * `revised_cost` on freshly filed permits and the normalizer already turns that
 * into `null`; printing "$0" here would turn a placeholder into a fact about the
 * job's size, which is the one number this subscriber filters on.
 */
export function composeLeadSubtitle(
  permit: Pick<NormalizedPermit, 'neighborhood' | 'valuation' | 'status'>,
): string {
  const parts: string[] = [];

  const neighborhood = tidy(permit.neighborhood);
  if (neighborhood !== null) parts.push(neighborhood);

  const value = formatProjectValue(permit.valuation);
  parts.push(value ?? 'Value not published');

  const status = tidy(permit.status);
  if (status !== null) parts.push(capitalize(status.toLowerCase()));

  return parts.join(' · ');
}

/* -------------------------------------------------------------------------- */
/* Time                                                                       */
/* -------------------------------------------------------------------------- */

/** Calendar day in a named zone, as `{ y, m, d }`, or `null` if unformattable. */
function calendarDay(at: Date, timeZone: string): { y: number; m: number; d: number } | null {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(at);

  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? Number.NaN : Number.parseInt(part.value, 10);
  };

  const day = { y: read('year'), m: read('month'), d: read('day') };
  return Number.isFinite(day.y) && Number.isFinite(day.m) && Number.isFinite(day.d) ? day : null;
}

function clockTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(at);
}

/**
 * When the lead landed, in the words the prototype uses.
 *
 *   "Today, 9:41 AM" | "Yesterday" | "Tuesday" | "Aug 6"
 *
 * Resolved in San Francisco time, because the subscriber, the permits and the
 * job sites are all there and a server in another zone must not shift a lead
 * into yesterday. `now` is a parameter rather than a `new Date()` so a page
 * renders one consistent clock across every row.
 */
export function relativeLeadTime(iso: string | null, now: Date, timeZone: string): string {
  if (iso === null) return 'Date not recorded';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return 'Date not recorded';

  const then = calendarDay(at, timeZone);
  const today = calendarDay(now, timeZone);
  if (then === null || today === null) return 'Date not recorded';

  const daysApart = Math.round(
    (Date.UTC(today.y, today.m - 1, today.d) - Date.UTC(then.y, then.m - 1, then.d)) / 86_400_000,
  );

  if (daysApart === 0) return `Today, ${clockTime(at, timeZone)}`;
  if (daysApart === 1) return 'Yesterday';
  if (daysApart > 1 && daysApart < 7) {
    return new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long' }).format(at);
  }
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'short', day: 'numeric' }).format(at);
}

/* -------------------------------------------------------------------------- */
/* Card                                                                       */
/* -------------------------------------------------------------------------- */

export interface LeadCardProps {
  /** Where the detail screen for this lead lives. */
  href: string;
  score: number;
  title: string;
  subtitle: string;
  /** Already-formatted relative time, from {@link relativeLeadTime}. */
  when: string;
  /**
   * True only when `opportunities.status` is `delivered`. Nothing else may set
   * it: a scored lead that has not been messaged is not a delivered lead, and
   * this flag is what the card's wording and its emphasis both hang on.
   */
  delivered: boolean;
}

/**
 * The row. A link, not a button, so it opens in a new tab on a long press and
 * needs no client JavaScript.
 */
export default function LeadCard({
  href,
  score,
  title,
  subtitle,
  when,
  delivered,
}: LeadCardProps) {
  return (
    <Link className="lv-lead" href={href} data-delivered={delivered ? 'true' : 'false'}>
      <span className="lv-lead-top">
        <ScoreBadge score={score} />
        <span className="lv-lead-when">{when}</span>
      </span>
      <span className="lv-lead-title">{title}</span>
      <span className="lv-lead-subtitle">{subtitle}</span>
      <span className="lv-lead-state" data-delivered={delivered ? 'true' : 'false'}>
        <span className="lv-lead-dot" aria-hidden="true" />
        {delivered ? 'Sent to you' : 'Scored, not sent yet'}
      </span>
    </Link>
  );
}
