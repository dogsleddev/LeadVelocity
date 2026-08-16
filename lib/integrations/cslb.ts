/**
 * CSLB: contractor license verification, and the prospect universe.
 *
 * Origin: the evidence-labeled adapter shape follows SiteVelocity
 * (https://github.com/samshanmukh/SiteVelocity).
 *
 * The kickoff wants one CSLB integration serving both sides of the company: the
 * Sales Agent's prospect universe, and per-license verification during
 * enrichment. This file provides both, but they are not equally solid, and the
 * difference is worth stating plainly.
 *
 * ==========================================================================
 * WHY THE PROSPECT POOL DOES NOT COME FROM CSLB
 * ==========================================================================
 * The CSLB list-by-classification tool at
 * `www2.cslb.ca.gov/onlineservices/dataportal/ListByClassification` is an ASP.NET
 * WebForms page. Getting a C-10 / San Francisco county list out of it requires
 * replaying `__VIEWSTATE`, `__VIEWSTATEGENERATOR` and `__EVENTVALIDATION` from a
 * prior GET into a POST postback, and the tokens are bound to the session that
 * issued them. That was not obtainable non-interactively while building this, so
 * no C-10 list was retrieved and none is invented here.
 *
 * The seed is therefore `loadProspectPoolFromExtract()`: contractors pulled from
 * the REAL DataSF building permit contacts already committed at
 * `data/contacts.json`. These are firms demonstrably pulling permits in San
 * Francisco right now, which is arguably a better acquisition list than a
 * classification roster anyway, because activity is observed rather than
 * registered.
 *
 * What that seed CANNOT tell us is the CSLB classification. The contacts dataset
 * has no classification column, so every seeded prospect carries
 * `classification: null` and `licenseStatus: null`. They are not guessed, not
 * defaulted to C-10, and not inferred from the firm name. `verifyLicense()`
 * upgrades a single prospect's evidence when CSLB is reachable; until then the
 * unknown stays visible, per CLAUDE.md hard rule #3.
 * ==========================================================================
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { envInt, envOr, optionalEnv } from '@/lib/config/deployment-env';
import { type EvidenceLabel, type SourceDescriptor, sourceDescriptorSchema } from '@/lib/domain/schemas/core';

/** See `AnthropicResult` for why "skipped" and "failed" stay distinguishable. */
export type CslbResult<T> =
  | { ok: true; skipped: false; value: T }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; reason: string };

/* -------------------------------------------------------------------------- */
/* Source identity                                                            */
/* -------------------------------------------------------------------------- */

/** Registry key stamped on every prospect derived from the permit contacts. */
export const PROSPECT_POOL_SOURCE_ID = 'datasf.building_permit_contacts';

/** Provenance for the extract-derived pool. Endpoint matches `data/manifest.json`. */
export const PROSPECT_POOL_SOURCE: SourceDescriptor = sourceDescriptorSchema.parse({
  id: PROSPECT_POOL_SOURCE_ID,
  agency: 'City and County of San Francisco (DataSF / DBI)',
  datasetId: '3pee-9qhc',
  name: 'Building Permits Contacts',
  endpoint: 'https://data.sfgov.org/resource/3pee-9qhc.json',
  kind: 'replay',
  updateCadence: 'weekly',
});

/** Registry key for a live CSLB license lookup. */
export const CSLB_SOURCE_ID = 'cslb.license_lookup';

/* -------------------------------------------------------------------------- */
/* (a) License verification                                                   */
/* -------------------------------------------------------------------------- */

/* ========================================================================== */
/* UNVERIFIED CSLB PAGE CONTRACT                                              */
/* The CSLB detail page was not live-inspected while building this, so the     */
/* label patterns below are guesses and are quarantined here. A field is only  */
/* reported when its pattern actually matched; otherwise it stays null and the */
/* evidence label stays `unknown`. Reconcile against the live page before      */
/* relying on any value from this path.                                       */
/* ========================================================================== */

const DEFAULT_LOOKUP_URL = 'https://www.cslb.ca.gov/OnlineServices/CheckLicenseII/LicenseDetail.aspx?LicNum={license}';

/** Label to capture pattern. Applied to the tag-stripped page text. */
const FIELD_PATTERNS: Readonly<Record<'businessName' | 'status' | 'expiresOn', RegExp>> = Object.freeze({
  businessName: /Business Information\s*[:\-]?\s*([^\n]{3,120}?)\s{2,}/i,
  status: /\b(?:License\s+)?Status\s*[:\-]?\s*(Active|Inactive|Expired|Suspended|Revoked|Cancelled|Canceled)\b/i,
  expiresOn: /Expiration\s*(?:Date)?\s*[:\-]?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i,
});

/** Classification codes as CSLB writes them, e.g. `C-10`, `B`, `A`. */
const CLASSIFICATION_PATTERN = /\b([ABC](?:-\d{1,2})?)\b(?=\s*[-–]\s*[A-Z])/g;

/* ========================================================================== */
/* END UNVERIFIED BLOCK                                                       */
/* ========================================================================== */

/**
 * Result of a license lookup. Always returned, never thrown.
 *
 * `evidence` is `verified` only when CSLB answered 200, echoed the license number
 * back, and a status was actually parsed. Every other outcome (unreachable, non
 * 200, unrecognized layout, lookup disabled) is `unknown` with the reason in
 * `note`. There is no third state where we half-believe something.
 */
export interface LicenseVerification {
  licenseNumber: string;
  /** e.g. "Active". Null when not parsed. */
  status: string | null;
  /** Registered business name. Null when not parsed. */
  businessName: string | null;
  /** Classification codes found on the page, e.g. ["C-10"]. Empty when none parsed. */
  classifications: string[];
  /** Expiration as printed, MM/DD/YYYY. Null when not parsed. */
  expiresOn: string | null;
  evidence: EvidenceLabel;
  sourceId: string;
  /** The exact URL queried, for the provenance note under the Finding. */
  endpoint: string;
  checkedAt: string;
  /** Human readable provenance or failure reason. Rendered in the UI. */
  note: string;
}

/** True unless the lookup has been explicitly switched off. */
export function cslbLookupEnabled(): boolean {
  const flag = envOr('CSLB_LOOKUP_ENABLED', 'on').toLowerCase();
  return !['off', 'false', '0', 'no'].includes(flag);
}

function unknownVerification(
  licenseNumber: string,
  endpoint: string,
  note: string,
  checkedAt: string,
): LicenseVerification {
  return {
    licenseNumber,
    status: null,
    businessName: null,
    classifications: [],
    expiresOn: null,
    evidence: 'unknown',
    sourceId: CSLB_SOURCE_ID,
    endpoint,
    checkedAt,
    note,
  };
}

/**
 * Best-effort live CSLB lookup for one license number.
 *
 * Never throws and never guesses. CSLB is a credential-free public page, so there
 * is no capability key to gate on; the gate is `CSLB_LOOKUP_ENABLED` (default on)
 * plus a short timeout, because on a venue network a slow HTML fetch blocking the
 * enrichment tick is worse than an honest `unknown`.
 *
 * @param now Injected clock, so a caller can make the stamp deterministic.
 */
export async function verifyLicense(licenseNumber: string, now: Date = new Date()): Promise<LicenseVerification> {
  const checkedAt = now.toISOString();
  const license = licenseNumber.trim();
  const template = envOr('CSLB_LOOKUP_URL', DEFAULT_LOOKUP_URL);
  const endpoint = template.replace('{license}', encodeURIComponent(license));

  if (!/^\d{3,10}$/.test(license)) {
    return unknownVerification(license, endpoint, 'not a CSLB-shaped license number, no lookup attempted', checkedAt);
  }
  if (!cslbLookupEnabled()) {
    return unknownVerification(license, endpoint, 'CSLB lookup disabled by CSLB_LOOKUP_ENABLED', checkedAt);
  }

  let html: string;
  try {
    const response = await fetch(endpoint, {
      method: 'GET',
      headers: { accept: 'text/html', 'user-agent': 'LeadVelocity/0.1 (permit research)' },
      signal: AbortSignal.timeout(envInt('CSLB_TIMEOUT_MS', 6_000)),
    });
    if (!response.ok) {
      return unknownVerification(license, endpoint, `CSLB returned HTTP ${response.status}`, checkedAt);
    }
    html = await response.text();
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
    return unknownVerification(license, endpoint, `CSLB unreachable (${message})`, checkedAt);
  }

  const text = stripTags(html);
  if (!text.includes(license)) {
    return unknownVerification(license, endpoint, 'CSLB page did not echo the license number back', checkedAt);
  }

  const status = FIELD_PATTERNS.status.exec(text)?.[1] ?? null;
  const businessName = FIELD_PATTERNS.businessName.exec(text)?.[1]?.trim() ?? null;
  const expiresOn = FIELD_PATTERNS.expiresOn.exec(text)?.[1] ?? null;
  const classifications = [...new Set([...text.matchAll(CLASSIFICATION_PATTERN)].map((m) => m[1] ?? ''))].filter(
    (c) => c.length > 0,
  );

  if (status === null) {
    return unknownVerification(
      license,
      endpoint,
      'CSLB page reached but the status field did not match the expected layout; reconcile the page contract block in lib/integrations/cslb.ts',
      checkedAt,
    );
  }

  return {
    licenseNumber: license,
    status,
    businessName,
    classifications,
    expiresOn,
    evidence: 'verified',
    sourceId: CSLB_SOURCE_ID,
    endpoint,
    checkedAt,
    note: `CSLB license detail page read at ${checkedAt}`,
  };
}

/** Crude tag strip. Enough to run label patterns over, not a parser. */
function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '  ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/[ \t]{3,}/g, '  ');
}

/* -------------------------------------------------------------------------- */
/* (b) Prospect pool from the committed real extract                          */
/* -------------------------------------------------------------------------- */

/**
 * Only the contact columns this module reads, validated at the boundary.
 *
 * Everything from Socrata arrives as a string, including numbers and dates, so
 * every field is typed as an optional string and coerced explicitly. `passthrough`
 * keeps the other 15 columns available without asserting anything about them.
 */
const rawContactSchema = z
  .object({
    permit_number: z.string().optional(),
    role: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    firm_name: z.string().optional(),
    license1: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    agent_zipcode: z.string().optional(),
    firm_city: z.string().optional(),
    firm_state: z.string().optional(),
    firm_zipcode: z.string().optional(),
    sf_business_license_number: z.string().optional(),
    from_date: z.string().optional(),
  })
  .passthrough();

/**
 * One contractor in the acquisition universe.
 *
 * Field names line up with the `prospects` table so the Sales Agent can insert
 * without a second mapping layer.
 */
export interface ProspectSeed {
  /** Numeric CSLB-style license, the dedupe key. */
  licenseNumber: string;
  firmName: string;
  city: string | null;
  state: string | null;
  /** Five digit zip, normalized from the `94103-0000` form the dataset uses. */
  zipcode: string | null;
  /**
   * ALWAYS null. The contacts dataset has no classification column and a C-10
   * cannot be inferred from a firm name. `verifyLicense` fills this in per
   * license when CSLB is reachable.
   */
  classification: null;
  /** ALWAYS null, same reason as `classification`. */
  licenseStatus: null;
  /** Roles this license appeared under, e.g. ["contractor"]. */
  roles: string[];
  /** Distinct permits this license appears on inside the extract window. */
  permitCount: number;
  /** Most recent permit number seen for this license, for the outreach context. */
  latestPermitNumber: string | null;
  /** Most recent `from_date` seen, ISO string as published. Null when absent. */
  lastSeenOn: string | null;
  /** Named individual on the most recent row, when the dataset carries one. */
  contactName: string | null;
  /** SF business licence number when present. Corroborates the firm is local. */
  sfBusinessLicenseNumber: string | null;
  /** Registry key, always `datasf.building_permit_contacts`. */
  sourceId: typeof PROSPECT_POOL_SOURCE_ID;
}

/** The pool plus enough provenance to defend where it came from. */
export interface ProspectPool {
  source: SourceDescriptor;
  /** Absolute path of the extract actually read. */
  extractPath: string;
  /** Total contact rows in the file. */
  rowsRead: number;
  /** Rows that failed boundary validation and were skipped. */
  rowsRejected: number;
  /** Deduped contractors, most active first, then license ascending. */
  prospects: ProspectSeed[];
}

export interface LoadProspectPoolOptions {
  /** Override the extract location. Defaults to the committed `data/contacts.json`. */
  extractPath?: string;
  /** Keep only these roles, lowercased comparison. Default keeps every role. */
  roles?: readonly string[];
  /** Keep only firms whose city matches, lowercased comparison. Default keeps all. */
  cities?: readonly string[];
  /** Drop licenses seen on fewer than this many permits. Default 1. */
  minPermitCount?: number;
}

/** Parsed extract, memoized per path so repeated ticks do not re-read 22k rows. */
const extractCache = new Map<string, { rows: z.infer<typeof rawContactSchema>[]; rowsRead: number; rowsRejected: number }>();

/**
 * Candidate locations for the committed extract, first existing wins.
 *
 * `process.cwd()` covers `npm run` and Next.js server execution; the module
 * relative path covers a test or script run from another directory.
 */
function resolveExtractPath(override?: string): string | null {
  const candidates: string[] = [];
  if (override !== undefined) candidates.push(path.resolve(override));

  const configuredDir = optionalEnv('LEADVELOCITY_DATA_DIR');
  if (configuredDir !== null) candidates.push(path.resolve(configuredDir, 'contacts.json'));

  candidates.push(path.resolve(process.cwd(), 'data', 'contacts.json'));
  candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'contacts.json'));

  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/**
 * Build the prospect universe from the committed real permit contacts.
 *
 * Selection rule, exactly as specified: a row qualifies when `license1` is purely
 * numeric and `firm_name` is present. The numeric test is doing real work here.
 * Contractor licenses in this dataset are bare digits, while architects and
 * engineers carry a letter prefix (`C36025`, `E19515`, `M34110`), so it separates
 * CSLB contractor licenses from other state board licenses without needing a role
 * filter. Measured on the committed extract: 22,148 rows in, 8,551 qualifying
 * rows, 2,564 distinct licenses out.
 *
 * Deduped by license. City, state and zip are captured from the best populated
 * row. Ordering is deterministic (permit count descending, then license
 * ascending) so two runs produce the same list.
 */
export async function loadProspectPoolFromExtract(
  options: LoadProspectPoolOptions = {},
): Promise<CslbResult<ProspectPool>> {
  const extractPath = resolveExtractPath(options.extractPath);
  if (extractPath === null) {
    return {
      ok: false,
      skipped: true,
      reason:
        'permit contacts extract not found (looked for data/contacts.json relative to cwd, LEADVELOCITY_DATA_DIR and the module path)',
    };
  }

  let cached = extractCache.get(extractPath);
  if (cached === undefined) {
    let parsedFile: unknown;
    try {
      parsedFile = JSON.parse(await readFile(extractPath, 'utf8')) as unknown;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      return { ok: false, skipped: false, reason: `could not read ${extractPath}: ${message}` };
    }
    if (!Array.isArray(parsedFile)) {
      return { ok: false, skipped: false, reason: `${extractPath} is not a JSON array of contact rows` };
    }

    const rows: z.infer<typeof rawContactSchema>[] = [];
    let rowsRejected = 0;
    for (const row of parsedFile) {
      const parsed = rawContactSchema.safeParse(row);
      if (parsed.success) rows.push(parsed.data);
      else rowsRejected += 1;
    }
    cached = { rows, rowsRead: parsedFile.length, rowsRejected };
    extractCache.set(extractPath, cached);
  }

  const roleFilter = options.roles?.map((r) => r.toLowerCase());
  const cityFilter = options.cities?.map((c) => c.toLowerCase());
  const minPermitCount = options.minPermitCount ?? 1;

  /** Accumulator keyed by license number. */
  interface Accumulator {
    seed: ProspectSeed;
    permits: Set<string>;
    lastSeenMs: number;
  }
  const byLicense = new Map<string, Accumulator>();

  for (const row of cached.rows) {
    const license = (row.license1 ?? '').trim();
    if (!/^\d+$/.test(license)) continue;

    const firmName = (row.firm_name ?? '').trim();
    if (firmName.length === 0) continue;

    const role = (row.role ?? '').trim().toLowerCase();
    if (roleFilter !== undefined && !roleFilter.includes(role)) continue;

    const city = firstNonEmpty(row.firm_city, row.city);
    if (cityFilter !== undefined && (city === null || !cityFilter.includes(city.toLowerCase()))) continue;

    const permitNumber = (row.permit_number ?? '').trim();
    const fromMs = Date.parse(row.from_date ?? '');
    const seenMs = Number.isFinite(fromMs) ? fromMs : Number.NEGATIVE_INFINITY;

    const existing = byLicense.get(license);
    if (existing === undefined) {
      byLicense.set(license, {
        seed: {
          licenseNumber: license,
          firmName,
          city,
          state: firstNonEmpty(row.firm_state, row.state),
          zipcode: normalizeZip(firstNonEmpty(row.firm_zipcode, row.agent_zipcode)),
          classification: null,
          licenseStatus: null,
          roles: role.length > 0 ? [role] : [],
          permitCount: 0,
          latestPermitNumber: permitNumber.length > 0 ? permitNumber : null,
          lastSeenOn: row.from_date ?? null,
          contactName: personName(row.first_name, row.last_name),
          sfBusinessLicenseNumber: firstNonEmpty(row.sf_business_license_number),
          sourceId: PROSPECT_POOL_SOURCE_ID,
        },
        permits: new Set(permitNumber.length > 0 ? [permitNumber] : []),
        lastSeenMs: seenMs,
      });
      continue;
    }

    if (permitNumber.length > 0) existing.permits.add(permitNumber);
    if (!existing.seed.roles.includes(role) && role.length > 0) existing.seed.roles.push(role);

    /* Backfill anything the first row left blank, without overwriting a value. */
    existing.seed.city ??= city;
    existing.seed.state ??= firstNonEmpty(row.firm_state, row.state);
    existing.seed.zipcode ??= normalizeZip(firstNonEmpty(row.firm_zipcode, row.agent_zipcode));
    existing.seed.sfBusinessLicenseNumber ??= firstNonEmpty(row.sf_business_license_number);

    /* The most recent row wins for "who to ask for" and "when we last saw them". */
    if (seenMs > existing.lastSeenMs) {
      existing.lastSeenMs = seenMs;
      existing.seed.lastSeenOn = row.from_date ?? existing.seed.lastSeenOn;
      existing.seed.latestPermitNumber = permitNumber.length > 0 ? permitNumber : existing.seed.latestPermitNumber;
      existing.seed.contactName = personName(row.first_name, row.last_name) ?? existing.seed.contactName;
    }
  }

  const prospects: ProspectSeed[] = [];
  for (const entry of byLicense.values()) {
    entry.seed.permitCount = entry.permits.size;
    entry.seed.roles.sort();
    if (entry.seed.permitCount < minPermitCount) continue;
    prospects.push(entry.seed);
  }

  prospects.sort(
    (a, b) => b.permitCount - a.permitCount || a.licenseNumber.localeCompare(b.licenseNumber),
  );

  return {
    ok: true,
    skipped: false,
    value: {
      source: PROSPECT_POOL_SOURCE,
      extractPath,
      rowsRead: cached.rowsRead,
      rowsRejected: cached.rowsRejected,
      prospects,
    },
  };
}

/** Drop the memoized extract. Used by tests that swap the file under it. */
export function clearProspectPoolCache(): void {
  extractCache.clear();
}

function firstNonEmpty(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim() ?? '';
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

/** `94103-0000` and `94103` both become `94103`. Anything else stays null. */
function normalizeZip(zip: string | null): string | null {
  if (zip === null) return null;
  const match = /^(\d{5})/.exec(zip.trim());
  return match?.[1] ?? null;
}

function personName(first: string | undefined, last: string | undefined): string | null {
  const name = [first?.trim() ?? '', last?.trim() ?? ''].filter((part) => part.length > 0).join(' ');
  return name.length > 0 ? name : null;
}
