/**
 * San Francisco building permit normalizer.
 *
 * Origin: normalizer/content-hash pattern adapted from SiteVelocity
 * (https://github.com/samshanmukh/SiteVelocity).
 *
 * Turns one raw DataSF row (Socrata dataset `i98e-djp9`) into a `NormalizedPermit`:
 * a stable, typed, hashable projection that the shortlist filters, the scoring
 * arithmetic, and the snapshot diff all read instead of touching raw JSON.
 *
 * This module is PURE (CLAUDE.md conventions): no network, no clock, no fs, no
 * randomness. `contentHash` uses `node:crypto` only as a deterministic digest,
 * and the timezone resolution uses `Intl`, which is a pure function of its input.
 *
 * Measured realities of the committed extract (n=10,880) that this file is built
 * around, rather than assumed away:
 *
 * - Every Socrata value arrives as a STRING, including costs and dates. Nothing
 *   here trusts `typeof`; every field goes through an explicit coercion.
 * - `revised_cost` is populated 96.0% and is sometimes `"0.0"` on a freshly filed
 *   permit; `estimated_cost` is populated 99.1%. Valuation is the larger of the
 *   two after coercion, and which one won is recorded in `valuationSource`.
 * - `issued_date` 82.2%, `approved_date` 76.4%, `completed_date` 30.0% populated.
 *   Absence is `null`. It is never backfilled from a sibling date, because a
 *   guessed date is a fabricated fact (CLAUDE.md hard rule #3).
 * - Agency timestamps are floating (no offset) and are San Francisco wall time.
 *   They are resolved against `America/Los_Angeles`, DST included, so a February
 *   permit gets `-08:00` and an April permit gets `-07:00`.
 * - 3 of 10,880 rows carry no `location`; those normalize to null coordinates.
 * - `unit` is frequently `"0"`, which means "no unit" and is dropped from the
 *   assembled address.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Timezone primitives                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The zone DataSF publishes its floating timestamps in. Exported because the
 * Socrata adapter has to convert cursors back into the same wall-clock space
 * when it builds a `$where` predicate.
 */
export const SF_TIME_ZONE = 'America/Los_Angeles';

/**
 * `Intl.DateTimeFormat` construction is expensive and its output depends only on
 * its inputs, so instances are memoized. This keeps the module pure in the sense
 * that matters: same input, same output, no observable side effects.
 */
const ZONE_FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = ZONE_FORMATTERS.get(timeZone);
  if (cached !== undefined) return cached;
  const created = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  ZONE_FORMATTERS.set(timeZone, created);
  return created;
}

/** Wall-clock components of an instant, as seen in `timeZone`. */
export interface WallClock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly millisecond: number;
}

function wallClockInZone(utcMs: number, timeZone: string): WallClock | null {
  const parts = zoneFormatter(timeZone).formatToParts(new Date(utcMs));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part === undefined ? Number.NaN : Number.parseInt(part.value, 10);
  };
  const hour = read('hour');
  const clock: WallClock = {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    // Some ICU builds render midnight as hour 24 under h23; normalize it.
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
    millisecond: ((utcMs % 1000) + 1000) % 1000,
  };
  const finite = Object.values(clock).every((value) => Number.isFinite(value));
  return finite ? clock : null;
}

/** Offset of `timeZone` at a given instant, in minutes east of UTC. */
export function zoneOffsetMinutes(utcMs: number, timeZone: string): number | null {
  const clock = wallClockInZone(utcMs, timeZone);
  if (clock === null) return null;
  const asUtc = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
  );
  const wholeSeconds = utcMs - (((utcMs % 1000) + 1000) % 1000);
  return Math.round((asUtc - wholeSeconds) / 60_000);
}

/**
 * Resolve a wall-clock reading in `timeZone` to an instant.
 *
 * Two passes: guess the offset by pretending the reading is UTC, then re-resolve
 * at the corrected instant so a DST boundary lands on the right side. Times that
 * do not exist (spring forward) resolve to the instant the clock jumped to;
 * times that occur twice (fall back) resolve to the first occurrence. Both are
 * deterministic, which is what the content hash needs.
 */
function wallClockToInstant(clock: WallClock, timeZone: string): number | null {
  const naive = Date.UTC(
    clock.year,
    clock.month - 1,
    clock.day,
    clock.hour,
    clock.minute,
    clock.second,
    clock.millisecond,
  );
  const firstOffset = zoneOffsetMinutes(naive, timeZone);
  if (firstOffset === null) return null;
  const firstGuess = naive - firstOffset * 60_000;
  const secondOffset = zoneOffsetMinutes(firstGuess, timeZone);
  if (secondOffset === null) return null;
  return secondOffset === firstOffset ? firstGuess : naive - secondOffset * 60_000;
}

function pad(value: number, width: number): string {
  return String(Math.abs(value)).padStart(width, '0');
}

function formatOffset(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  const absolute = Math.abs(offsetMinutes);
  return `${sign}${pad(Math.floor(absolute / 60), 2)}:${pad(absolute % 60, 2)}`;
}

function formatWallClock(clock: WallClock, offsetMinutes: number): string {
  return (
    `${pad(clock.year, 4)}-${pad(clock.month, 2)}-${pad(clock.day, 2)}` +
    `T${pad(clock.hour, 2)}:${pad(clock.minute, 2)}:${pad(clock.second, 2)}` +
    `.${pad(clock.millisecond, 3)}${formatOffset(offsetMinutes)}`
  );
}

/**
 * Accepts the shapes DataSF actually emits plus defensively an already-offset
 * timestamp:
 *   2026-03-23T14:30:55.000   floating, SF wall time  (100% of the extract)
 *   2026-03-23                date only
 *   2026-03-23T14:30:55Z      absolute
 *   2026-03-23T14:30:55-07:00 absolute
 */
const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Normalize one agency timestamp to ISO-8601 with an explicit offset.
 *
 * Floating readings are interpreted as wall time in `timeZone`. Values that
 * carry their own offset are re-expressed in `timeZone` so every stored
 * timestamp is comparable. Anything unparseable returns `null` rather than a
 * best guess.
 */
export function normalizeAgencyTimestamp(
  value: unknown,
  timeZone: string = SF_TIME_ZONE,
): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;

  const match = TIMESTAMP_PATTERN.exec(trimmed);
  if (match === null) return null;

  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fractionText, zoneText] =
    match;
  if (yearText === undefined || monthText === undefined || dayText === undefined) return null;

  const clock: WallClock = {
    year: Number.parseInt(yearText, 10),
    month: Number.parseInt(monthText, 10),
    day: Number.parseInt(dayText, 10),
    hour: hourText === undefined ? 0 : Number.parseInt(hourText, 10),
    minute: minuteText === undefined ? 0 : Number.parseInt(minuteText, 10),
    second: secondText === undefined ? 0 : Number.parseInt(secondText, 10),
    millisecond:
      fractionText === undefined ? 0 : Number.parseInt(fractionText.slice(0, 3).padEnd(3, '0'), 10),
  };

  if (clock.month < 1 || clock.month > 12) return null;
  if (clock.day < 1 || clock.day > 31) return null;
  if (clock.hour > 23 || clock.minute > 59 || clock.second > 59) return null;

  if (zoneText === undefined) {
    const instant = wallClockToInstant(clock, timeZone);
    if (instant === null || !Number.isFinite(instant)) return null;
    const offset = zoneOffsetMinutes(instant, timeZone);
    if (offset === null) return null;
    return formatWallClock(clock, offset);
  }

  // Already absolute: re-express it in the target zone.
  const instant = Date.parse(trimmed);
  if (!Number.isFinite(instant)) return null;
  return instantToIsoInZone(instant, timeZone);
}

/** Render an instant as ISO-8601 with the offset in force in `timeZone`. */
export function instantToIsoInZone(utcMs: number, timeZone: string = SF_TIME_ZONE): string | null {
  const clock = wallClockInZone(utcMs, timeZone);
  const offset = zoneOffsetMinutes(utcMs, timeZone);
  if (clock === null || offset === null) return null;
  return formatWallClock(clock, offset);
}

/**
 * Render a timestamp as the floating (offset-free) form Socrata compares
 * against in a SoQL `$where`. Values that already float pass through unchanged.
 */
export function toFloatingTimestamp(value: string, timeZone: string = SF_TIME_ZONE): string | null {
  const normalized = normalizeAgencyTimestamp(value, timeZone);
  if (normalized === null) return null;
  // Strip the trailing offset: SoQL floating_timestamp literals carry none.
  return normalized.slice(0, 23);
}

/* -------------------------------------------------------------------------- */
/* Value coercion                                                             */
/* -------------------------------------------------------------------------- */

/** String-ish value or `null`. Empty and whitespace-only collapse to `null`. */
export function coerceText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return null;
}

/** Lowercased controlled vocabulary (status, use, permit type definition). */
function coerceVocabulary(value: unknown): string | null {
  const text = coerceText(value);
  return text === null ? null : text.toLowerCase();
}

/**
 * Numeric coercion that assumes nothing about the JSON type.
 *
 * Socrata sends `"8285917.0"`; a future export could send `8285917`. Currency
 * decoration (`$`, thousands separators) is tolerated because it costs one regex
 * and prevents a silent zero.
 */
export function coerceNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/[$,\s]/g, '');
  if (cleaned.length === 0) return null;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Whole-number coercion for story counts, which arrive as `"52"` or `"4.0"`. */
export function coerceInteger(value: unknown): number | null {
  const numeric = coerceNumber(value);
  return numeric === null ? null : Math.trunc(numeric);
}

/* -------------------------------------------------------------------------- */
/* Address assembly                                                           */
/* -------------------------------------------------------------------------- */

/** `unit` values that mean "the whole building", not a unit. */
const NON_UNIT_VALUES = new Set(['0', '0.0', 'none', 'n/a', 'na']);

/**
 * Assemble the street address from the five columns DataSF splits it across.
 *
 * `street_number` + `street_number_suffix` join without a space (`1310B Scott St`),
 * which is how the city writes them. A unit is appended only when it is a real
 * unit designation.
 */
export function assembleAddress(parts: {
  streetNumber?: unknown;
  streetNumberSuffix?: unknown;
  streetName?: unknown;
  streetSuffix?: unknown;
  unit?: unknown;
  unitSuffix?: unknown;
}): string | null {
  const number = coerceText(parts.streetNumber);
  const numberSuffix = coerceText(parts.streetNumberSuffix);
  const name = coerceText(parts.streetName);
  const suffix = coerceText(parts.streetSuffix);

  const house = number === null ? null : `${number}${numberSuffix ?? ''}`;
  const street = [name, suffix].filter((piece): piece is string => piece !== null).join(' ');

  const base = [house, street.length > 0 ? street : null]
    .filter((piece): piece is string => piece !== null && piece.length > 0)
    .join(' ');

  const unitValue = coerceText(parts.unit);
  const unitSuffixValue = coerceText(parts.unitSuffix);
  const unitCore =
    unitValue !== null && !NON_UNIT_VALUES.has(unitValue.toLowerCase()) ? unitValue : null;
  const unitLabel = [unitCore, unitSuffixValue]
    .filter((piece): piece is string => piece !== null)
    .join(' ');

  const assembled = unitLabel.length > 0 ? `${base} Unit ${unitLabel}` : base;
  const collapsed = assembled.replace(/\s+/g, ' ').trim();
  return collapsed.length > 0 ? collapsed : null;
}

/* -------------------------------------------------------------------------- */
/* Raw row                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The 53 columns live-inspected on `i98e-djp9`, declared so the mapping is
 * reviewable against the dataset (CLAUDE.md hard rule #8).
 *
 * Every column except the primary key is `unknown`: the schema's job here is to
 * document the contract and guarantee an object with a usable key, not to assert
 * types the agency never promised. Coercion happens field by field below, and
 * `.passthrough()` keeps columns the agency adds later instead of dropping them.
 */
export const rawPermitRowSchema = z
  .object({
    permit_number: z
      .union([z.string(), z.number()])
      .transform((value) => String(value).trim())
      .refine((value) => value.length > 0, { message: 'permit_number is required' }),
    record_id: z.unknown().optional(),
    permit_type: z.unknown().optional(),
    permit_type_definition: z.unknown().optional(),
    permit_creation_date: z.unknown().optional(),
    block: z.unknown().optional(),
    lot: z.unknown().optional(),
    street_number: z.unknown().optional(),
    street_number_suffix: z.unknown().optional(),
    street_name: z.unknown().optional(),
    street_suffix: z.unknown().optional(),
    unit: z.unknown().optional(),
    unit_suffix: z.unknown().optional(),
    description: z.unknown().optional(),
    status: z.unknown().optional(),
    status_date: z.unknown().optional(),
    filed_date: z.unknown().optional(),
    issued_date: z.unknown().optional(),
    completed_date: z.unknown().optional(),
    approved_date: z.unknown().optional(),
    first_construction_document_date: z.unknown().optional(),
    last_permit_activity_date: z.unknown().optional(),
    structural_notification: z.unknown().optional(),
    number_of_existing_stories: z.unknown().optional(),
    number_of_proposed_stories: z.unknown().optional(),
    voluntary_soft_story_retrofit: z.unknown().optional(),
    fire_only_permit: z.unknown().optional(),
    estimated_cost: z.unknown().optional(),
    revised_cost: z.unknown().optional(),
    existing_use: z.unknown().optional(),
    existing_units: z.unknown().optional(),
    proposed_use: z.unknown().optional(),
    proposed_units: z.unknown().optional(),
    plansets: z.unknown().optional(),
    tidf_compliance: z.unknown().optional(),
    existing_occupancy: z.unknown().optional(),
    proposed_occupancy: z.unknown().optional(),
    existing_construction_type: z.unknown().optional(),
    existing_construction_type_description: z.unknown().optional(),
    proposed_construction_type: z.unknown().optional(),
    proposed_construction_type_description: z.unknown().optional(),
    site_permit: z.unknown().optional(),
    application_submission_method: z.unknown().optional(),
    adu: z.unknown().optional(),
    primary_address_flag: z.unknown().optional(),
    supervisor_district: z.unknown().optional(),
    neighborhoods_analysis_boundaries: z.unknown().optional(),
    zipcode: z.unknown().optional(),
    location: z.unknown().optional(),
    point_source: z.unknown().optional(),
    reroof: z.unknown().optional(),
    data_as_of: z.unknown().optional(),
    data_loaded_at: z.unknown().optional(),
  })
  .passthrough();
export type RawPermitRow = z.infer<typeof rawPermitRowSchema>;

/** GeoJSON Point as Socrata renders `location`. Coordinates are `[lon, lat]`. */
const geoPointSchema = z
  .object({
    type: z.unknown().optional(),
    coordinates: z.array(z.unknown()).optional(),
  })
  .passthrough();

interface Coordinates {
  readonly longitude: number | null;
  readonly latitude: number | null;
}

/** Pull `[lon, lat]` out of the GeoJSON blob, tolerating every absent shape. */
export function extractCoordinates(location: unknown): Coordinates {
  const parsed = geoPointSchema.safeParse(location);
  if (!parsed.success) return { longitude: null, latitude: null };

  const type = coerceText(parsed.data.type);
  if (type !== null && type.toLowerCase() !== 'point') return { longitude: null, latitude: null };

  const coordinates = parsed.data.coordinates;
  if (coordinates === undefined || coordinates.length < 2) {
    return { longitude: null, latitude: null };
  }
  const longitude = coerceNumber(coordinates[0]);
  const latitude = coerceNumber(coordinates[1]);
  if (longitude === null || latitude === null) return { longitude: null, latitude: null };
  if (Math.abs(longitude) > 180 || Math.abs(latitude) > 90) {
    return { longitude: null, latitude: null };
  }
  return { longitude, latitude };
}

/* -------------------------------------------------------------------------- */
/* Normalized permit                                                          */
/* -------------------------------------------------------------------------- */

/** Which cost column produced `valuation`. `none` means we do not know the value. */
export const valuationSourceSchema = z.enum(['revised', 'estimated', 'none']);
export type ValuationSource = z.infer<typeof valuationSourceSchema>;

const isoTimestamp = z.string().datetime({ offset: true }).nullable();

export const normalizedPermitSchema = z.object({
  permitNumber: z.string().min(1),
  recordId: z.string().nullable(),

  address: z.string().nullable(),
  neighborhood: z.string().nullable(),
  supervisorDistrict: z.string().nullable(),
  zipcode: z.string().nullable(),
  latitude: z.number().nullable(),
  longitude: z.number().nullable(),

  status: z.string().nullable(),
  statusDate: isoTimestamp,
  filedDate: isoTimestamp,
  issuedDate: isoTimestamp,
  approvedDate: isoTimestamp,
  completedDate: isoTimestamp,

  description: z.string().nullable(),
  permitTypeDefinition: z.string().nullable(),
  existingUse: z.string().nullable(),
  proposedUse: z.string().nullable(),
  existingOccupancy: z.string().nullable(),
  proposedOccupancy: z.string().nullable(),
  storiesExisting: z.number().nullable(),
  storiesProposed: z.number().nullable(),

  valuation: z.number().nullable(),
  valuationSource: valuationSourceSchema,

  dataAsOf: isoTimestamp,
  dataLoadedAt: isoTimestamp,
});
export type NormalizedPermit = z.infer<typeof normalizedPermitSchema>;

interface Valuation {
  readonly valuation: number | null;
  readonly valuationSource: ValuationSource;
}

/**
 * Project valuation is the larger of the two cost columns after coercion.
 *
 * A coerced `0` is treated as an absence, not as a zero-dollar project: DBI
 * writes `"0.0"` into `revised_cost` on freshly filed permits (687 rows in the
 * committed extract). Reporting that as a $0 valuation would push a real project
 * to the bottom of the value component on the strength of a placeholder. When
 * neither column carries a positive number the answer is `null` / `none`, which
 * downstream renders as an unknown rather than a number nobody can defend.
 */
export function resolveValuation(revisedRaw: unknown, estimatedRaw: unknown): Valuation {
  const revised = coerceNumber(revisedRaw);
  const estimated = coerceNumber(estimatedRaw);
  const revisedUsable = revised !== null && revised > 0 ? revised : null;
  const estimatedUsable = estimated !== null && estimated > 0 ? estimated : null;

  if (revisedUsable === null && estimatedUsable === null) {
    return { valuation: null, valuationSource: 'none' };
  }
  if (estimatedUsable === null) {
    return { valuation: revisedUsable, valuationSource: 'revised' };
  }
  if (revisedUsable === null) {
    return { valuation: estimatedUsable, valuationSource: 'estimated' };
  }
  // Both usable: take the larger, and credit `revised` on a tie because it is
  // the column the city updates last.
  return revisedUsable >= estimatedUsable
    ? { valuation: revisedUsable, valuationSource: 'revised' }
    : { valuation: estimatedUsable, valuationSource: 'estimated' };
}

/**
 * Raw DataSF permit row to `NormalizedPermit`.
 *
 * Throws only when the row has no usable `permit_number`, because a permit we
 * cannot name cannot be deduped, hashed, or joined to its contacts. Every other
 * gap is represented, never invented.
 */
export function normalizePermit(
  raw: unknown,
  timeZone: string = SF_TIME_ZONE,
): NormalizedPermit {
  const row = rawPermitRowSchema.parse(raw);
  const { longitude, latitude } = extractCoordinates(row.location);
  const { valuation, valuationSource } = resolveValuation(row.revised_cost, row.estimated_cost);

  const normalized: NormalizedPermit = {
    permitNumber: row.permit_number,
    recordId: coerceText(row.record_id),

    address: assembleAddress({
      streetNumber: row.street_number,
      streetNumberSuffix: row.street_number_suffix,
      streetName: row.street_name,
      streetSuffix: row.street_suffix,
      unit: row.unit,
      unitSuffix: row.unit_suffix,
    }),
    neighborhood: coerceText(row.neighborhoods_analysis_boundaries),
    supervisorDistrict: coerceText(row.supervisor_district),
    zipcode: coerceText(row.zipcode),
    latitude,
    longitude,

    status: coerceVocabulary(row.status),
    statusDate: normalizeAgencyTimestamp(row.status_date, timeZone),
    filedDate: normalizeAgencyTimestamp(row.filed_date, timeZone),
    issuedDate: normalizeAgencyTimestamp(row.issued_date, timeZone),
    approvedDate: normalizeAgencyTimestamp(row.approved_date, timeZone),
    completedDate: normalizeAgencyTimestamp(row.completed_date, timeZone),

    description: coerceText(row.description),
    permitTypeDefinition: coerceVocabulary(row.permit_type_definition),
    existingUse: coerceVocabulary(row.existing_use),
    proposedUse: coerceVocabulary(row.proposed_use),
    // Occupancy codes are case-bearing ("R-2,F-1", "B"); do not fold them.
    existingOccupancy: coerceText(row.existing_occupancy),
    proposedOccupancy: coerceText(row.proposed_occupancy),
    storiesExisting: coerceInteger(row.number_of_existing_stories),
    storiesProposed: coerceInteger(row.number_of_proposed_stories),

    valuation,
    valuationSource,

    dataAsOf: normalizeAgencyTimestamp(row.data_as_of, timeZone),
    dataLoadedAt: normalizeAgencyTimestamp(row.data_loaded_at, timeZone),
  };

  return normalizedPermitSchema.parse(normalized);
}

/** Non-throwing variant for bulk ingestion, where one bad row must not stop a page. */
export function safeNormalizePermit(
  raw: unknown,
  timeZone: string = SF_TIME_ZONE,
): { ok: true; permit: NormalizedPermit } | { ok: false; reason: string } {
  try {
    return { ok: true, permit: normalizePermit(raw, timeZone) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Content hashing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Recursively sort object keys so two structurally equal values serialize
 * identically regardless of insertion order. `undefined` members are dropped,
 * matching `JSON.stringify`, and non-finite numbers collapse to `null` so a
 * `NaN` can never produce an unserializable hash input.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const member = canonicalize(source[key]);
      if (member === undefined) continue;
      sorted[key] = member;
    }
    return sorted;
  }
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  if (typeof value === 'bigint') return value.toString();
  return value;
}

/**
 * Deterministic JSON with sorted keys. Also used by the snapshot diff to compare
 * individual field values, which is why it is exported rather than private.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? 'null';
}

/** Lowercase hex SHA-256 of a string. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Stable content hash of a normalized permit.
 *
 * Change detection compares hashes, so the hash must depend on the normalized
 * projection and nothing else: not on key order, not on provenance, not on when
 * we happened to fetch the row. Re-fetching an unchanged permit must produce a
 * byte-identical hash, otherwise the decision log fills with phantom changes.
 */
export function contentHash(normalized: NormalizedPermit): string {
  return sha256Hex(canonicalJson(normalized));
}
