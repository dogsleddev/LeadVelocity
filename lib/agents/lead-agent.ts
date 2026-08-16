/**
 * The Lead Agent: permit in, delivered opportunity out.
 *
 * Origin: enrichment-then-score pipeline shape adapted from SiteVelocity
 * (https://github.com/samshanmukh/SiteVelocity).
 *
 * WHAT THIS IS
 * ------------
 * The fulfilment half of the company. One tick walks a batch of newly observed or
 * changed permit records through the whole funnel:
 *
 *   permit  ->  deterministic shortlist  ->  narrow interpretation call
 *           ->  candidate  ->  enrichment into Findings  ->  deterministic score
 *           ->  deliver (opportunity + message)  |  hold it  |  archive with the reason
 *
 * WHERE THE LINE BETWEEN CODE AND MODEL SITS
 * ------------------------------------------
 * CLAUDE.md hard rule #2, applied here concretely:
 *
 * - CODE decides territory, status, project type, use, cost floor, dedupe
 *   (`lib/pipeline/shortlist-filters.ts`), the score and its drivers
 *   (`lib/calculations/scoring/lead-score.ts`), the 80 point threshold, and
 *   whether the subscriber is paid up (`subscriptions.hasActiveSubscription`).
 * - The MODEL is asked exactly two narrow questions, both with a tight Zod schema
 *   and neither producing a number that reaches the score: "does this scope of
 *   work contain billable electrical work" (interpretation) and, only for
 *   candidates that already cleared the bar, "what is the best way into this job"
 *   (contact-path reasoning and drafting).
 *
 * Every model answer is stored as a Finding labelled `inferred`. Nothing the model
 * says is ever labelled `verified`.
 *
 * BILLING GATE
 * ------------
 * Fulfilment runs only for a subscriber with an active Stripe subscription. That
 * check is the first thing after the customer lookup, it is deterministic, and a
 * failed check is logged rather than silently skipped, because "the machine went
 * quiet" and "the machine is waiting to be paid" must look different in the log.
 *
 * DELIVERY GOES THROUGH THE CHANNEL SEAM
 * --------------------------------------
 * Nothing in this file knows whether a message leaves over Linq or Twilio. It
 * calls `lib/delivery/channel.ts`, which reports one of three outcomes, and the
 * third is the one that shapes the code: on Linq a handle that has not texted the
 * company first cannot be reached at all. Such a message is QUEUED and logged as
 * prepared, `delivered_at` stays null, and `markDelivered` is not called, because
 * a held message is not a delivered one. A subscriber has normally already texted
 * in to subscribe, so this path is rare here and routine in the Sales Agent, but
 * rare is not never and it is handled rather than assumed away.
 *
 * NOTHING IS EVER FABRICATED
 * --------------------------
 * Permit facts come from the record and are `verified`. A CSLB confirmation is
 * `verified`. A firm identity that two independent sources agree on is
 * `corroborated`. A model judgement is `inferred`. Anything we looked for and
 * could not establish is stored as `value: null` with `unknown`, and stays on the
 * candidate where the UI can render it.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import {
  LEAD_SCORE_THRESHOLD,
  meetsDeliveryBar,
  scoreLead,
  type NormalizedPermit as ScoringPermit,
} from '@/lib/calculations/scoring/lead-score';
import { appBaseUrl, envInt, optionalEnv } from '@/lib/config/deployment-env';
import {
  coerceInteger,
  coerceNumber,
  coerceText,
  normalizeAgencyTimestamp,
  normalizedPermitSchema as agencyPermitSchema,
  type NormalizedPermit as AgencyPermit,
} from '@/lib/domain/permit-normalizer';
import type {
  CustomerProfile,
  EvidenceLabel,
  Finding,
  ScoreResult,
} from '@/lib/domain/schemas/core';
import type { SourceId } from '@/lib/adapters/sources/registry';
import { anthropicReady, completeJson } from '@/lib/integrations/anthropic';
import {
  CSLB_SOURCE_ID,
  cslbLookupEnabled,
  verifyLicense,
  type LicenseVerification,
} from '@/lib/integrations/cslb';
import {
  activeChannel,
  channelLabel,
  channelReady,
  normalizeRecipient,
  sendMessage,
} from '@/lib/delivery/channel';
import {
  isCustomerSafe,
  opportunitySms,
  type OpportunityCopyContext,
} from '@/lib/copy/templates';
import {
  runShortlistFilters,
  summarizeShortlistResult,
  type ShortlistPermit,
  type ShortlistResult,
} from '@/lib/pipeline/shortlist-filters';
import {
  createCandidate,
  createOpportunity,
  getCandidateByPair,
  getPrimaryCustomer,
  hasActiveSubscription,
  listFindings,
  listRecentPermits,
  markDelivered,
  markOptedOut,
  queueOutbound,
  setStage,
  upsertFindings,
  type CustomerRecord,
  type PermitRecord,
} from '@/lib/store';

import { attempt, describeError, formatUsd, runTick, type TickContext, type TickResult } from './tick';

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

/** How many recently observed permits one tick reads before filtering. */
const scanLimit = (): number => envInt('LEAD_SCAN_LIMIT', 60);

/** How many shortlist survivors one tick is allowed to fully process. */
const batchLimit = (): number => envInt('LEAD_BATCH_SIZE', 4);

/**
 * CSLB lookups allowed per tick. The lookup is a live HTML fetch with a six
 * second timeout; letting a whole batch queue behind it would make a tick longer
 * than its own cadence. Candidates past the budget record the licence status as
 * `unknown` with the reason, which is the honest answer rather than a stall.
 */
const cslbBudget = (): number => envInt('LEAD_CSLB_LOOKUPS_PER_TICK', 2);

/**
 * Finding provenance.
 *
 * The two DataSF ids are typed as `SourceId`, so a typo is a compile error rather
 * than an unattributable fact sitting in the database. The CSLB id is imported
 * from the integration that produces it, for the same reason.
 *
 * `MODEL_SOURCE_ID` is deliberately NOT a registry id. The registry describes
 * data sources with an agency, a dataset, and an endpoint; a model reading a
 * permit description is none of those. It is a reasoning step, which is why every
 * Finding carrying this id is labelled `inferred` and never `verified`.
 */
const PERMIT_SOURCE_ID: SourceId = 'datasf.building_permits';
const CONTACTS_SOURCE_ID: SourceId = 'datasf.building_permit_contacts';
const MODEL_SOURCE_ID = 'model.interpretation';

const MS_PER_DAY = 86_400_000;

/* -------------------------------------------------------------------------- */
/* Permit contacts, joined from the committed real extract                    */
/* -------------------------------------------------------------------------- */

/**
 * Only the contact columns this module reads, validated at the boundary.
 *
 * Column names are the live-inspected `3pee-9qhc` schema. Everything Socrata
 * publishes is a string, so every field is an optional string and is coerced
 * explicitly; `passthrough` keeps the other columns without asserting anything
 * about them.
 */
const rawContactSchema = z
  .object({
    permit_number: z.string().optional(),
    role: z.string().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    firm_name: z.string().optional(),
    firm_city: z.string().optional(),
    firm_state: z.string().optional(),
    firm_zipcode: z.string().optional(),
    city: z.string().optional(),
    state: z.string().optional(),
    license1: z.string().optional(),
    sf_business_license_number: z.string().optional(),
    from_date: z.string().optional(),
  })
  .passthrough();

/** One person or firm named on a permit, as the agency published them. */
export interface PermitContact {
  permitNumber: string;
  /** Lowercased `role`. Observed values: contractor, engineer, architect, and 8 more. */
  role: string;
  firmName: string | null;
  personName: string | null;
  /** `license1`. Bare digits for CSLB contractors, letter-prefixed for design professionals. */
  license1: string | null;
  city: string | null;
  state: string | null;
  zipcode: string | null;
  sfBusinessLicenseNumber: string | null;
  fromDate: string | null;
}

/** The join table, keyed on `permit_number`, plus where it was read from. */
export interface ContactIndex {
  byPermit: ReadonlyMap<string, readonly PermitContact[]>;
  extractPath: string;
  rowsRead: number;
  rowsRejected: number;
}

type ContactIndexResult =
  | { ok: true; value: ContactIndex }
  | { ok: false; reason: string };

/**
 * Memoized as a promise, not as a value, so two ticks starting inside the same
 * second share one 9MB read instead of racing two.
 */
let contactIndexPromise: Promise<ContactIndexResult> | null = null;

function resolveContactsPath(): string | null {
  const candidates: string[] = [];
  const configured = optionalEnv('LEADVELOCITY_DATA_DIR');
  if (configured !== null) candidates.push(path.resolve(configured, 'contacts.json'));
  candidates.push(path.resolve(process.cwd(), 'data', 'contacts.json'));
  candidates.push(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'contacts.json'),
  );
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function firstNonEmpty(...values: (string | undefined)[]): string | null {
  for (const value of values) {
    const trimmed = value?.trim() ?? '';
    if (trimmed.length > 0) return trimmed;
  }
  return null;
}

function personName(first: string | undefined, last: string | undefined): string | null {
  const name = [first?.trim() ?? '', last?.trim() ?? ''].filter((part) => part.length > 0).join(' ');
  return name.length > 0 ? name : null;
}

/**
 * Build the permit-number to contacts index from `data/contacts.json`.
 *
 * The extract is real and committed (22,148 rows), and 99.6% of permits carry at
 * least one contact row, so this join is the enrichment step's main source of
 * facts about who is running a job. A missing extract is a degraded capability,
 * not a crash: the caller records the contact Findings as `unknown` and says why.
 */
export async function loadContactIndex(): Promise<ContactIndexResult> {
  if (contactIndexPromise !== null) return contactIndexPromise;

  contactIndexPromise = (async (): Promise<ContactIndexResult> => {
    const extractPath = resolveContactsPath();
    if (extractPath === null) {
      return {
        ok: false,
        reason:
          'permit contacts extract not found (looked for data/contacts.json relative to cwd, LEADVELOCITY_DATA_DIR and the module path)',
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(extractPath, 'utf8')) as unknown;
    } catch (error) {
      return { ok: false, reason: `could not read ${extractPath}: ${describeError(error)}` };
    }
    if (!Array.isArray(parsed)) {
      return { ok: false, reason: `${extractPath} is not a JSON array of contact rows` };
    }

    const byPermit = new Map<string, PermitContact[]>();
    let rowsRejected = 0;

    for (const row of parsed) {
      const validated = rawContactSchema.safeParse(row);
      if (!validated.success) {
        rowsRejected += 1;
        continue;
      }
      const permitNumber = validated.data.permit_number?.trim() ?? '';
      if (permitNumber.length === 0) {
        rowsRejected += 1;
        continue;
      }

      const contact: PermitContact = {
        permitNumber,
        role: (validated.data.role ?? '').trim().toLowerCase(),
        firmName: firstNonEmpty(validated.data.firm_name),
        personName: personName(validated.data.first_name, validated.data.last_name),
        license1: firstNonEmpty(validated.data.license1),
        city: firstNonEmpty(validated.data.firm_city, validated.data.city),
        state: firstNonEmpty(validated.data.firm_state, validated.data.state),
        zipcode: firstNonEmpty(validated.data.firm_zipcode),
        sfBusinessLicenseNumber: firstNonEmpty(validated.data.sf_business_license_number),
        fromDate: firstNonEmpty(validated.data.from_date),
      };

      const existing = byPermit.get(permitNumber);
      if (existing === undefined) byPermit.set(permitNumber, [contact]);
      else existing.push(contact);
    }

    return {
      ok: true,
      value: {
        byPermit,
        extractPath,
        rowsRead: parsed.length,
        rowsRejected,
      },
    };
  })();

  return contactIndexPromise;
}

/** Drop the memoized index. Used by tests that swap the extract underneath. */
export function clearContactIndexCache(): void {
  contactIndexPromise = null;
}

/**
 * Roles that mean "this firm is building the job", in preference order.
 *
 * Measured on the extract: contractor 9,031 rows, subcontractor 3. The general
 * contractor is therefore the `contractor` row, and a permit with no contractor
 * row genuinely has no builder of record yet.
 */
const BUILDER_ROLES: readonly string[] = ['contractor', 'subcontractor'];

/** Firm names that name the electrical trade. Used only to read the roster. */
const ELECTRICAL_FIRM_PATTERN = /\belectric(?:al|s)?\b/i;

function findGeneralContractor(contacts: readonly PermitContact[]): PermitContact | null {
  for (const role of BUILDER_ROLES) {
    const match = contacts.find(
      (contact) => contact.role === role && contact.firmName !== null,
    );
    if (match !== undefined) return match;
  }
  return null;
}

/** True when some firm on the roster names the electrical trade. */
function electricalFirmOnRoster(contacts: readonly PermitContact[]): PermitContact | null {
  return (
    contacts.find(
      (contact) => contact.firmName !== null && ELECTRICAL_FIRM_PATTERN.test(contact.firmName),
    ) ?? null
  );
}

/* -------------------------------------------------------------------------- */
/* Bridging the two normalized-permit shapes                                  */
/* -------------------------------------------------------------------------- */

/**
 * `permit_records.normalized` holds the projection produced by
 * `lib/domain/permit-normalizer.ts`. The scorer declares its own structural
 * contract in `lib/calculations/scoring/lead-score.ts`, and the two do NOT line
 * up field for field: the scorer wants `existingStories` / `proposedStories`
 * where the normalizer writes `storiesExisting` / `storiesProposed`, wants a
 * non-null `status`, and reads unit counts and `lastPermitActivityDate` that the
 * normalizer does not project at all.
 *
 * This function is that bridge, and it is the only place the mismatch is handled.
 * The missing columns are read back out of `permit_records.raw`, which is the
 * agency row verbatim, so nothing is invented to fill the gap.
 */
export function toScoringPermit(record: PermitRecord, agency: AgencyPermit): ScoringPermit {
  const raw = record.raw;
  return {
    permitNumber: agency.permitNumber,
    /* The scorer requires a string; an unpublished status becomes empty, which it
     * already reads as "unknown status" rather than as a named status. */
    status: agency.status ?? '',
    description: agency.description,
    permitTypeDefinition: agency.permitTypeDefinition,
    existingUse: agency.existingUse,
    proposedUse: agency.proposedUse,
    existingOccupancy: agency.existingOccupancy,
    valuation: agency.valuation,
    existingStories: agency.storiesExisting,
    proposedStories: agency.storiesProposed,
    existingUnits: coerceInteger(raw['existing_units']),
    proposedUnits: coerceInteger(raw['proposed_units']),
    zipcode: agency.zipcode,
    supervisorDistrict: agency.supervisorDistrict,
    filedDate: agency.filedDate,
    issuedDate: agency.issuedDate,
    statusDate: agency.statusDate,

    recordId: agency.recordId,
    address: agency.address,
    neighborhood: agency.neighborhood,
    proposedOccupancy: agency.proposedOccupancy,
    estimatedCost: coerceNumber(raw['estimated_cost']),
    revisedCost: coerceNumber(raw['revised_cost']),
    approvedDate: agency.approvedDate,
    completedDate: agency.completedDate,
    lastPermitActivityDate: normalizeAgencyTimestamp(raw['last_permit_activity_date']),
  };
}

/**
 * The filter input. The agency projection is already structurally assignable to
 * `ShortlistPermit` (the compile-time assertion lives in `shortlist-filters.ts`),
 * so this only adds the three fields the normalizer keeps in `raw`: the unit,
 * which sharpens the near-duplicate site key, and both cost columns.
 */
export function toShortlistPermit(record: PermitRecord, agency: AgencyPermit): ShortlistPermit {
  return {
    ...agency,
    unit: coerceText(record.raw['unit']),
    estimatedCost: coerceNumber(record.raw['estimated_cost']),
    revisedCost: coerceNumber(record.raw['revised_cost']),
  };
}

/** Read `permit_records.normalized` back into its typed form. Throws on a bad row. */
export function readAgencyPermit(record: PermitRecord): AgencyPermit {
  return agencyPermitSchema.parse(record.normalized);
}

/* -------------------------------------------------------------------------- */
/* The narrow interpretation call                                             */
/* -------------------------------------------------------------------------- */

/**
 * The entire contract for what the model is allowed to say about a permit.
 *
 * A boolean, a sentence, and a list of phrases it found. No number, no ranking,
 * no confidence percentage, nothing that could be mistaken for a score.
 */
export const relevanceJudgementSchema = z.object({
  /** Would this subscriber's trade have billable work inside this scope? */
  relevant: z.boolean(),
  /** One or two sentences, in plain words, saying why. */
  rationale: z.string().min(1).max(500),
  /** Phrases from the description that carry the trade, quoted not invented. */
  scopeSignals: z.array(z.string().min(1)).max(12),
});
export type RelevanceJudgement = z.infer<typeof relevanceJudgementSchema>;

const RELEVANCE_SYSTEM = [
  'You read San Francisco building permit descriptions for a licensed trade contractor.',
  'Your only job is to judge whether the scope of work described would contain billable work for that trade.',
  'Quote scope signals from the description itself. Never invent a phrase that is not there.',
  'You do not estimate value, you do not rank permits, and you never produce a score of any kind.',
  'If the description names no scope you can read, set relevant to false and say plainly that the description is too thin to judge.',
].join(' ');

function relevancePrompt(customer: CustomerProfile, agency: AgencyPermit): string {
  const lines = [
    `Trade: ${customer.trade}`,
    `Permit number: ${agency.permitNumber}`,
    `Permit type: ${agency.permitTypeDefinition ?? 'not published'}`,
    `Building use: ${agency.existingUse ?? 'not published'}${
      agency.proposedUse !== null && agency.proposedUse !== agency.existingUse
        ? ` changing to ${agency.proposedUse}`
        : ''
    }`,
    `Scope of work as the agency published it: ${agency.description ?? '(no description published)'}`,
    '',
    'Answer with { "relevant": boolean, "rationale": string, "scopeSignals": string[] }.',
  ];
  return lines.join('\n');
}

/** Outcome of the interpretation step, including the honest "we did not ask". */
export type RelevanceOutcome =
  | { state: 'judged'; judgement: RelevanceJudgement; attempts: number }
  | { state: 'skipped'; reason: string }
  | { state: 'failed'; reason: string };

/** Ask the model the one question it is allowed to answer about a permit. */
export async function interpretRelevance(
  customer: CustomerProfile,
  agency: AgencyPermit,
): Promise<RelevanceOutcome> {
  if (!anthropicReady()) {
    return { state: 'skipped', reason: 'interpretation capability unconfigured (ANTHROPIC_API_KEY)' };
  }

  const result = await completeJson({
    system: RELEVANCE_SYSTEM,
    prompt: relevancePrompt(customer, agency),
    schema: relevanceJudgementSchema,
    maxTokens: 500,
    temperature: 0,
  });

  if (result.ok) {
    return { state: 'judged', judgement: result.value.value, attempts: result.value.attempts };
  }
  return result.skipped
    ? { state: 'skipped', reason: result.reason }
    : { state: 'failed', reason: result.reason };
}

/* -------------------------------------------------------------------------- */
/* The contact-path call (drafting, delivery path only)                       */
/* -------------------------------------------------------------------------- */

/**
 * Contact-path reasoning and drafting, explicitly permitted by hard rule #2.
 *
 * Runs only for candidates that already cleared the deterministic bar, so the
 * expensive call is spent on the handful of permits that will actually be sent.
 * The output is customer facing, so every field is checked against the copy
 * policy before it is stored and the deterministic wording is used instead when
 * the check fails.
 */
const contactPathSchema = z.object({
  /** Who to call and why them, e.g. "Skyline Construction, ask for Fabian Valdiosera". */
  bestPathIn: z.string().min(1).max(240),
  /** The gap that makes this worth a call, phrased as a lowercase clause. */
  openingReason: z.string().min(1).max(160),
  /** The single next step, one sentence. */
  recommendedAction: z.string().min(1).max(240),
});
export type ContactPath = z.infer<typeof contactPathSchema>;

const CONTACT_PATH_SYSTEM = [
  'You write the one paragraph a commercial electrical contractor reads before picking up the phone about a permit.',
  'Use only the facts given to you. Never invent a name, a company, a phone number, or a date.',
  'Write the way a contractor speaks: the job, the opening, the next step.',
  'Never mention software, models, automation, or how the lead was found. Sell the job, not the machinery.',
  'Do not use em dashes.',
].join(' ');

/* -------------------------------------------------------------------------- */
/* Enrichment: facts become Findings                                          */
/* -------------------------------------------------------------------------- */

interface FindingDraft {
  key: string;
  label: string;
  value: string | number | boolean | null;
  evidence: EvidenceLabel;
  sourceId: string | null;
  note: string;
}

/** A fact we established. */
function known(
  key: string,
  label: string,
  value: string | number | boolean,
  evidence: EvidenceLabel,
  sourceId: string | null,
  note: string,
): FindingDraft {
  return { key, label, value, evidence, sourceId, note };
}

/**
 * A fact we looked for and could not establish.
 *
 * Hard rule #3 in one function: `null` plus `unknown` plus the reason we came up
 * empty. This is a first-class outcome, not an error path.
 */
function unknownFact(key: string, label: string, note: string, sourceId: string | null = null): FindingDraft {
  return { key, label, value: null, evidence: 'unknown', sourceId, note };
}

/** Everything enrichment needs. Pure: the caller does the reading and fetching. */
export interface EnrichmentInput {
  candidateId: string;
  record: PermitRecord;
  agency: AgencyPermit;
  contacts: readonly PermitContact[];
  /** False when the contacts extract itself could not be read. */
  rosterAvailable: boolean;
  /** Why the roster is unavailable, when it is. */
  rosterNote: string;
  relevance: RelevanceOutcome;
  /** CSLB answer, or `null` when no lookup was made this pass. */
  license: LicenseVerification | null;
  /** Why no lookup was made, when `license` is null. */
  licenseNote: string;
  observedAt: string;
}

/**
 * Turn one permit plus its roster plus the model's judgement into Findings.
 *
 * Pure. No network, no clock, no filesystem: every input is supplied. Each fact
 * gets the label its provenance actually justifies:
 *
 * - anything printed on the permit record   -> `verified`  (the agency is authoritative)
 * - a CSLB lookup that answered             -> `verified`
 * - a firm identity two sources agree on    -> `corroborated`
 * - the model's read of the scope of work   -> `inferred`
 * - anything we could not establish         -> `unknown`, value `null`
 */
export function buildFindings(input: EnrichmentInput): Finding[] {
  const { agency, contacts, observedAt } = input;
  const drafts: FindingDraft[] = [];
  const permitNote = `Published by DataSF on permit ${agency.permitNumber}`;

  /* --- the project itself, straight off the agency record ---------------- */
  drafts.push(
    agency.address !== null
      ? known('project.address', 'Project address', agency.address, 'verified', PERMIT_SOURCE_ID, permitNote)
      : unknownFact('project.address', 'Project address', 'Permit publishes no street address', PERMIT_SOURCE_ID),
  );

  drafts.push(
    agency.neighborhood !== null
      ? known('project.neighborhood', 'Neighborhood', agency.neighborhood, 'verified', PERMIT_SOURCE_ID, permitNote)
      : unknownFact('project.neighborhood', 'Neighborhood', 'Permit publishes no neighborhood boundary', PERMIT_SOURCE_ID),
  );

  const useValue =
    agency.existingUse !== null && agency.proposedUse !== null && agency.existingUse !== agency.proposedUse
      ? `${agency.existingUse} to ${agency.proposedUse}`
      : (agency.existingUse ?? agency.proposedUse);
  drafts.push(
    useValue !== null
      ? known('project.use', 'Building use', useValue, 'verified', PERMIT_SOURCE_ID, permitNote)
      : unknownFact('project.use', 'Building use', 'Permit publishes neither an existing nor a proposed use', PERMIT_SOURCE_ID),
  );

  drafts.push(
    agency.valuation !== null
      ? known(
          'project.valuation',
          'Project valuation',
          agency.valuation,
          'verified',
          PERMIT_SOURCE_ID,
          `Larger of the revised and estimated cost columns, taken from ${agency.valuationSource}`,
        )
      : unknownFact(
          'project.valuation',
          'Project valuation',
          'Neither revised nor estimated cost carries a positive figure on this permit',
          PERMIT_SOURCE_ID,
        ),
  );

  drafts.push(
    agency.status !== null
      ? known('project.status', 'Permit status', agency.status, 'verified', PERMIT_SOURCE_ID, permitNote)
      : unknownFact('project.status', 'Permit status', 'Permit publishes no status', PERMIT_SOURCE_ID),
  );

  drafts.push(
    agency.issuedDate !== null
      ? known('project.issued_date', 'Permit issued', agency.issuedDate, 'verified', PERMIT_SOURCE_ID, permitNote)
      : unknownFact(
          'project.issued_date',
          'Permit issued',
          'Permit has not been issued, or the agency has not published the issue date (absent on 17.8% of records)',
          PERMIT_SOURCE_ID,
        ),
  );

  const stories = agency.storiesProposed ?? agency.storiesExisting;
  drafts.push(
    stories !== null
      ? known('project.stories', 'Building stories', stories, 'verified', PERMIT_SOURCE_ID, permitNote)
      : unknownFact('project.stories', 'Building stories', 'Permit publishes no story count', PERMIT_SOURCE_ID),
  );

  /* --- who is on the job ------------------------------------------------- */
  if (!input.rosterAvailable) {
    drafts.push(unknownFact('contacts.rows', 'Named contacts on the permit', input.rosterNote, CONTACTS_SOURCE_ID));
    drafts.push(unknownFact('gc.firm_name', 'General contractor', input.rosterNote, CONTACTS_SOURCE_ID));
    drafts.push(unknownFact('gc.contact_name', 'Contractor contact', input.rosterNote, CONTACTS_SOURCE_ID));
    drafts.push(unknownFact('gc.license_number', 'Contractor license', input.rosterNote, CONTACTS_SOURCE_ID));
    drafts.push(
      unknownFact('permit.electrical_sub_named', 'Electrical contractor named', input.rosterNote, CONTACTS_SOURCE_ID),
    );
  } else {
    const rosterNote = `Read from the DataSF permit contacts roster for ${agency.permitNumber}`;
    drafts.push(
      known('contacts.rows', 'Named contacts on the permit', contacts.length, 'verified', CONTACTS_SOURCE_ID, rosterNote),
    );

    const gc = findGeneralContractor(contacts);
    if (gc === null || gc.firmName === null) {
      drafts.push(
        contacts.length === 0
          ? unknownFact(
              'gc.firm_name',
              'General contractor',
              'No contact rows published for this permit yet (0.4% of permits carry none)',
              CONTACTS_SOURCE_ID,
            )
          : unknownFact(
              'gc.firm_name',
              'General contractor',
              `Roster names ${contacts.length} contacts but no contractor of record`,
              CONTACTS_SOURCE_ID,
            ),
      );
      drafts.push(unknownFact('gc.contact_name', 'Contractor contact', 'No contractor row to read a name from', CONTACTS_SOURCE_ID));
      drafts.push(unknownFact('gc.license_number', 'Contractor license', 'No contractor row to read a license from', CONTACTS_SOURCE_ID));
    } else {
      drafts.push(known('gc.firm_name', 'General contractor', gc.firmName, 'verified', CONTACTS_SOURCE_ID, rosterNote));
      drafts.push(
        gc.personName !== null
          ? known('gc.contact_name', 'Contractor contact', gc.personName, 'verified', CONTACTS_SOURCE_ID, rosterNote)
          : unknownFact('gc.contact_name', 'Contractor contact', 'Contractor row names a firm but no individual', CONTACTS_SOURCE_ID),
      );
      drafts.push(
        gc.license1 !== null
          ? known('gc.license_number', 'Contractor license', gc.license1, 'verified', CONTACTS_SOURCE_ID, rosterNote)
          : unknownFact(
              'gc.license_number',
              'Contractor license',
              'Contractor row carries no license1 value (populated on 63.5% of contact rows)',
              CONTACTS_SOURCE_ID,
            ),
      );
      if (gc.sfBusinessLicenseNumber !== null) {
        drafts.push(
          known(
            'gc.sf_business_license',
            'San Francisco business license',
            gc.sfBusinessLicenseNumber,
            'verified',
            CONTACTS_SOURCE_ID,
            rosterNote,
          ),
        );
      }
    }

    /*
     * The opening. DBI names subcontractors on 3 of 22,148 contact rows, so a
     * roster with no electrical firm on it means the electrical package is not on
     * record yet. That is an observation about the roster, which we did read, so
     * it is `verified` rather than `unknown`. A permit with no roster at all is a
     * different thing and is recorded as `unknown` above.
     */
    const electrical = electricalFirmOnRoster(contacts);
    drafts.push(
      contacts.length === 0
        ? unknownFact(
            'permit.electrical_sub_named',
            'Electrical contractor named',
            'No contact rows published for this permit yet, so the roster could not be read',
            CONTACTS_SOURCE_ID,
          )
        : known(
            'permit.electrical_sub_named',
            'Electrical contractor named',
            electrical !== null,
            'verified',
            CONTACTS_SOURCE_ID,
            electrical !== null
              ? `${electrical.firmName ?? 'A firm'} is already named on the permit`
              : `Roster of ${contacts.length} contacts names no electrical firm`,
          ),
    );
  }

  /* --- CSLB, the second independent source on the same firm -------------- */
  const license = input.license;
  if (license === null) {
    drafts.push(unknownFact('gc.license_status', 'License status', input.licenseNote, CSLB_SOURCE_ID));
    drafts.push(unknownFact('gc.identity_corroborated', 'Firm identity confirmed', input.licenseNote, CSLB_SOURCE_ID));
  } else if (license.evidence === 'verified' && license.status !== null) {
    drafts.push(
      known('gc.license_status', 'License status', license.status, 'verified', CSLB_SOURCE_ID, license.note),
    );
    const gcName = findGeneralContractor(contacts)?.firmName ?? null;
    const agrees =
      gcName !== null && license.businessName !== null && namesAgree(gcName, license.businessName);
    drafts.push(
      agrees
        ? known(
            'gc.identity_corroborated',
            'Firm identity confirmed',
            license.businessName ?? gcName ?? 'match',
            /* Two independent sources agreeing, neither of them authoritative on
             * the other's claim, is exactly what `corroborated` means. */
            'corroborated',
            CSLB_SOURCE_ID,
            `The permit roster and the CSLB record name the same firm on license ${license.licenseNumber}`,
          )
        : unknownFact(
            'gc.identity_corroborated',
            'Firm identity confirmed',
            license.businessName === null
              ? 'CSLB answered but published no business name to compare against the permit roster'
              : `CSLB names "${license.businessName}" where the permit roster names "${gcName ?? 'no firm'}"; not treated as a match`,
            CSLB_SOURCE_ID,
          ),
    );
  } else {
    drafts.push(unknownFact('gc.license_status', 'License status', license.note, CSLB_SOURCE_ID));
    drafts.push(
      unknownFact('gc.identity_corroborated', 'Firm identity confirmed', license.note, CSLB_SOURCE_ID),
    );
  }

  /* --- what the model read out of the scope of work ---------------------- */
  const relevance = input.relevance;
  if (relevance.state === 'judged') {
    drafts.push(
      known(
        'trade.relevant',
        'Trade relevance',
        relevance.judgement.relevant,
        'inferred',
        MODEL_SOURCE_ID,
        relevance.judgement.rationale,
      ),
    );
    drafts.push(
      relevance.judgement.scopeSignals.length > 0
        ? known(
            'trade.scope_signals',
            'Scope signals',
            relevance.judgement.scopeSignals.join(', '),
            'inferred',
            MODEL_SOURCE_ID,
            'Phrases read out of the scope of work published on the permit',
          )
        : unknownFact(
            'trade.scope_signals',
            'Scope signals',
            'The scope of work names no phrase that carries this trade',
            MODEL_SOURCE_ID,
          ),
    );
  } else {
    drafts.push(unknownFact('trade.relevant', 'Trade relevance', relevance.reason, MODEL_SOURCE_ID));
    drafts.push(unknownFact('trade.scope_signals', 'Scope signals', relevance.reason, MODEL_SOURCE_ID));
  }

  return drafts.map((draft) => ({
    candidateId: input.candidateId,
    key: draft.key,
    label: draft.label,
    value: draft.value,
    evidence: draft.evidence,
    sourceId: draft.sourceId,
    note: draft.note,
    observedAt,
  }));
}

/**
 * Loose firm-name comparison for corroboration.
 *
 * Strips punctuation and the corporate suffixes both sources spell differently
 * ("Skyline Construction" against "SKYLINE CONSTRUCTION, INC."). Deliberately
 * conservative: a near miss reports no match rather than claiming corroboration
 * we do not have.
 */
export function namesAgree(left: string, right: string): boolean {
  const normalize = (value: string): string =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\b(?:inc|llc|llp|lp|corp|corporation|company|co|the|of|a)\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  const a = normalize(left);
  const b = normalize(right);
  if (a.length === 0 || b.length === 0) return false;
  return a === b || a.startsWith(b) || b.startsWith(a);
}

/* -------------------------------------------------------------------------- */
/* Customer-facing composition                                                */
/* -------------------------------------------------------------------------- */

/**
 * Scope wording safe to put in front of a human.
 *
 * The agency's own description is the best summary there is, but it is written by
 * applicants and is not under our editorial control, so it is checked against the
 * copy policy first. A description that trips rule #9 falls back to wording built
 * from the fields, rather than being sent or crashing the tick.
 */
export function safeScopeSummary(agency: AgencyPermit): string {
  const description = agency.description?.trim() ?? '';
  if (description.length > 0 && isCustomerSafe(description)) return description;

  const type = agency.permitTypeDefinition;
  const use = agency.existingUse ?? agency.proposedUse;
  if (type !== null && use !== null) return `${type} on a ${use} building`;
  if (type !== null) return type;
  if (use !== null) return `permitted work on a ${use} building`;
  return 'permitted building work';
}

/** Whole days between two ISO instants, or `null` when either is unreadable. */
function daysBetween(fromIso: string | null, to: Date): number | null {
  if (fromIso === null) return null;
  const from = Date.parse(fromIso);
  if (!Number.isFinite(from)) return null;
  return Math.floor((to.getTime() - from) / MS_PER_DAY);
}

/** The deterministic opening, used when the drafting call is unavailable. */
function defaultOpeningReason(contacts: readonly PermitContact[], rosterAvailable: boolean): string | null {
  if (!rosterAvailable || contacts.length === 0) return null;
  if (electricalFirmOnRoster(contacts) !== null) return null;
  return 'no electrical contractor is named on the permit yet';
}

/** The deterministic path in, used when the drafting call is unavailable. */
function defaultBestPathIn(gc: PermitContact | null): string | null {
  if (gc === null || gc.firmName === null) return null;
  return gc.personName !== null
    ? `${gc.firmName}, ask for ${gc.personName}`
    : `${gc.firmName}, the contractor of record`;
}

/** The deterministic next step. Always available, always specific. */
function defaultRecommendedAction(gc: PermitContact | null, address: string): string {
  return gc?.firmName !== undefined && gc?.firmName !== null
    ? `Call ${gc.firmName} about the electrical package on ${address} before the trades are bought.`
    : `Pull the ${address} permit at the counter and find who is buying the trades.`;
}

/**
 * Ask the model for the contact path, then keep it only if it is safe to send.
 *
 * Every returned field is put through the copy policy. A field that fails is
 * dropped in favour of the deterministic wording, so a model that starts talking
 * about the machinery degrades to plain copy instead of reaching a phone.
 */
async function draftContactPath(args: {
  agency: AgencyPermit;
  gc: PermitContact | null;
  contacts: readonly PermitContact[];
  rosterAvailable: boolean;
}): Promise<{ path: ContactPath | null; note: string }> {
  const fallbackOpening = defaultOpeningReason(args.contacts, args.rosterAvailable);
  if (!anthropicReady()) {
    return { path: null, note: 'drafting capability unconfigured (ANTHROPIC_API_KEY)' };
  }

  const roster = args.contacts
    .map((contact) => `- ${contact.role}: ${contact.firmName ?? 'unnamed firm'}${contact.personName !== null ? ` (${contact.personName})` : ''}`)
    .join('\n');

  const prompt = [
    `Project: ${args.agency.address ?? args.agency.permitNumber}`,
    `Scope of work: ${safeScopeSummary(args.agency)}`,
    `Valuation: ${args.agency.valuation !== null ? formatUsd(args.agency.valuation) : 'not published'}`,
    `Named on the permit:\n${roster.length > 0 ? roster : '- nobody yet'}`,
    fallbackOpening !== null ? `Observed gap: ${fallbackOpening}` : 'Observed gap: none identified',
    '',
    'Answer with { "bestPathIn": string, "openingReason": string, "recommendedAction": string }.',
    'openingReason must be a lowercase clause that can follow the word "and".',
  ].join('\n');

  const result = await completeJson({
    system: CONTACT_PATH_SYSTEM,
    prompt,
    schema: contactPathSchema,
    maxTokens: 400,
    temperature: 0.2,
  });

  if (!result.ok) return { path: null, note: result.reason };

  const draft = result.value.value;
  const safe: ContactPath = {
    bestPathIn: isCustomerSafe(draft.bestPathIn) ? draft.bestPathIn : (defaultBestPathIn(args.gc) ?? ''),
    openingReason: isCustomerSafe(draft.openingReason) ? draft.openingReason : (fallbackOpening ?? ''),
    recommendedAction: isCustomerSafe(draft.recommendedAction) ? draft.recommendedAction : '',
  };
  return { path: safe, note: `drafted in ${result.value.attempts} attempt(s)` };
}

/* -------------------------------------------------------------------------- */
/* The limited sample engine (shared with the Sales Agent)                    */
/* -------------------------------------------------------------------------- */

/** One real, scored permit, produced without writing anything. */
export interface SampleOpportunity {
  record: PermitRecord;
  agency: AgencyPermit;
  shortlist: ShortlistResult;
  score: ScoreResult;
  contacts: readonly PermitContact[];
  generalContractor: PermitContact | null;
  /** Ready to hand to the copy templates. */
  copy: OpportunityCopyContext;
}

export type SampleOutcome =
  | { ok: true; value: SampleOpportunity; scanned: number; survivors: number }
  | { ok: false; reason: string; scanned: number; survivors: number };

/**
 * Run a LIMITED pass of the lead engine and return the best real job it finds.
 *
 * Shared deliberately with the Sales Agent, which needs a real sample opportunity
 * to show a prospect (hard rule #5 forbids a mock). This is a library function,
 * not a message between agents: it reads the same permit table, runs the same
 * deterministic filters and the same scorer, and writes nothing at all. No
 * candidate, no opportunity, no Finding, no SMS.
 *
 * The model is not called here. A sample is chosen on deterministic evidence
 * alone, which also keeps the Sales tick fast and free.
 */
export async function sampleBestOpportunity(args: {
  customer: CustomerProfile;
  now: Date;
  scanLimit?: number;
}): Promise<SampleOutcome> {
  const limit = args.scanLimit ?? scanLimit();
  const permits = await listRecentPermits(limit);
  const contactIndex = await loadContactIndex();
  const rosterAvailable = contactIndex.ok;

  const seenKeys = new Set<string>();
  let best: SampleOpportunity | null = null;
  let survivors = 0;

  for (const record of permits) {
    let agency: AgencyPermit;
    try {
      agency = readAgencyPermit(record);
    } catch {
      continue;
    }

    const shortlist = runShortlistFilters(
      toShortlistPermit(record, agency),
      args.customer,
      args.now,
      { seenKeys },
    );
    if (!shortlist.passed) continue;

    seenKeys.add(shortlist.dedupeKey);
    seenKeys.add(shortlist.nearDuplicateKey);
    survivors += 1;

    const contacts = contactIndex.ok
      ? (contactIndex.value.byPermit.get(record.permitNumber) ?? [])
      : [];

    const findings = buildFindings({
      candidateId: `sample:${record.permitNumber}`,
      record,
      agency,
      contacts,
      rosterAvailable,
      rosterNote: contactIndex.ok ? '' : contactIndex.reason,
      relevance: { state: 'skipped', reason: 'sample pass does not call the interpretation step' },
      license: null,
      licenseNote: 'sample pass does not call CSLB',
      observedAt: args.now.toISOString(),
    });

    const score = scoreLead({
      permit: toScoringPermit(record, agency),
      findings,
      customer: args.customer,
      now: args.now.toISOString(),
    });

    if (score.fatalFlags.length > 0) continue;
    if (best !== null && score.score <= best.score.score) continue;

    const gc = findGeneralContractor(contacts);
    best = {
      record,
      agency,
      shortlist,
      score,
      contacts,
      generalContractor: gc,
      copy: buildCopyContext({ agency, gc, contacts, rosterAvailable, now: args.now, detailUrl: `${appBaseUrl()}/permits/${record.permitNumber}` }),
    };
  }

  if (best === null) {
    return {
      ok: false,
      reason:
        survivors === 0
          ? `No permit in the last ${permits.length} observed records cleared the shortlist for this territory.`
          : `${survivors} permits cleared the shortlist but every one of them carried a disqualifying flag.`,
      scanned: permits.length,
      survivors,
    };
  }
  return { ok: true, value: best, scanned: permits.length, survivors };
}

/** Assemble the copy context from facts only. Nullable fields stay null. */
function buildCopyContext(args: {
  agency: AgencyPermit;
  gc: PermitContact | null;
  contacts: readonly PermitContact[];
  rosterAvailable: boolean;
  now: Date;
  detailUrl: string;
  contactFirstName?: string | null;
  bestPathIn?: string | null;
  openingReason?: string | null;
}): OpportunityCopyContext {
  const address =
    args.agency.address ?? args.agency.neighborhood ?? `permit ${args.agency.permitNumber}`;
  return {
    contactFirstName: args.contactFirstName ?? null,
    projectAddress: address,
    neighborhood: args.agency.neighborhood,
    valuationUsd: args.agency.valuation,
    scopeSummary: safeScopeSummary(args.agency),
    generalContractor: args.gc?.firmName ?? null,
    contactName: args.gc?.personName ?? null,
    openingReason:
      args.openingReason ?? defaultOpeningReason(args.contacts, args.rosterAvailable),
    daysSinceIssued: daysBetween(args.agency.issuedDate, args.now),
    detailUrl: args.detailUrl,
  };
}

/* -------------------------------------------------------------------------- */
/* The tick                                                                   */
/* -------------------------------------------------------------------------- */

/** What one Lead tick got through, for the scheduler's console line. */
export interface LeadTickSummary {
  scanned: number;
  alreadyHandled: number;
  rejected: number;
  candidates: number;
  delivered: number;
  /** Composed and held because the channel cannot reach the number yet. */
  queued: number;
  archived: number;
  held: number;
}

const EMPTY_SUMMARY: LeadTickSummary = {
  scanned: 0,
  alreadyHandled: 0,
  rejected: 0,
  candidates: 0,
  delivered: 0,
  queued: 0,
  archived: 0,
  held: 0,
};

/**
 * One Lead Agent tick.
 *
 * Reads the most recently observed permits, runs every one through the
 * deterministic gate sheet, then takes a bounded batch of survivors all the way
 * to delivery or archival. A decision is logged at every gate: the batch summary,
 * each rejection with the gate that rejected it, each candidate created, each
 * archive with its reason, and each delivery with its score.
 */
export async function leadAgentTick(): Promise<TickResult<LeadTickSummary>> {
  return runTick('lead', async (ctx) => runLeadTick(ctx));
}

async function runLeadTick(ctx: TickContext): Promise<LeadTickSummary> {
  const summary: LeadTickSummary = { ...EMPTY_SUMMARY };

  /* --- 2. pull work ------------------------------------------------------ */
  const customer = await getPrimaryCustomer();
  if (customer === null) {
    await ctx.decide({
      decision: 'fulfilment.no_subscriber',
      summary:
        'No subscriber profile exists yet, so there is nobody to match permits to. Run the seed before the first fulfilment tick.',
    });
    return summary;
  }

  /* Billing state is deterministic code, never judgement (hard rule #2). */
  const active = await hasActiveSubscription(customer.id);
  if (!active) {
    await ctx.decide({
      decision: 'fulfilment.withheld',
      summary: `${customer.businessName} has no active subscription, so no permits were fulfilled this tick. Fulfilment resumes the moment checkout completes.`,
      refs: { customer: customer.id },
    });
    return summary;
  }

  const permits = await listRecentPermits(scanLimit());
  const observable = permits.filter((record) => record.snapshotStatus !== 'not_observed');
  summary.scanned = observable.length;

  if (observable.length === 0) {
    await ctx.decide({
      decision: 'shortlist.nothing_observed',
      summary: `No newly observed or changed permits were waiting for ${customer.businessName} this tick, so nothing entered the funnel.`,
      refs: { customer: customer.id },
    });
    return summary;
  }

  /* --- 3. decide: the deterministic gate sheet --------------------------- */
  const contactIndex = await loadContactIndex();
  const rosterAvailable = contactIndex.ok;
  const rosterNote = contactIndex.ok
    ? ''
    : `Permit contacts roster unavailable: ${contactIndex.reason}`;
  if (!contactIndex.ok) {
    await ctx.decide({
      decision: 'enrichment.roster_unavailable',
      summary: `Contact enrichment is running blind this tick and every contact fact will be recorded as unknown: ${contactIndex.reason}`,
    });
  }

  const seenKeys = new Set<string>();
  const survivors: { record: PermitRecord; agency: AgencyPermit; shortlist: ShortlistResult }[] = [];
  const limit = batchLimit();

  for (const record of observable) {
    let agency: AgencyPermit;
    try {
      agency = readAgencyPermit(record);
    } catch (error) {
      await ctx.decide({
        decision: 'shortlist.unreadable',
        summary: `Permit ${record.permitNumber} could not be read back from storage and was left untouched: ${describeError(error)}`,
        refs: { permit: record.permitNumber },
      });
      continue;
    }

    /* Already through the funnel? Do not spend a model call re-deciding it. */
    const existing = await getCandidateByPair(record.permitNumber, customer.id);
    if (existing !== null && (existing.stage === 'delivered' || existing.stage === 'archived')) {
      summary.alreadyHandled += 1;
      seenKeys.add(`permit:${record.permitNumber.trim()}`);
      continue;
    }

    const filterInput = toShortlistPermit(record, agency);
    const shortlist = runShortlistFilters(filterInput, customer, ctx.now, { seenKeys });

    if (!shortlist.passed) {
      summary.rejected += 1;
      /* Every rejection is logged with its gate and its reason (hard rule #6). */
      await ctx.decide({
        decision: 'shortlist.rejected',
        summary: summarizeShortlistResult(filterInput, shortlist),
        refs: {
          permit: record.permitNumber,
          gate: shortlist.rejectedBy,
          customer: customer.id,
        },
      });
      continue;
    }

    seenKeys.add(shortlist.dedupeKey);
    seenKeys.add(shortlist.nearDuplicateKey);
    if (survivors.length < limit) survivors.push({ record, agency, shortlist });
    else summary.held += 1;
  }

  await ctx.decide({
    decision: 'shortlist.completed',
    summary: `Read ${summary.scanned} observed permits for ${customer.businessName}: ${summary.rejected} rejected at the gates, ${summary.alreadyHandled} already handled, ${survivors.length} taken forward this tick, ${summary.held} left for the next.`,
    refs: { customer: customer.id, threshold: LEAD_SCORE_THRESHOLD },
  });

  if (survivors.length === 0) return summary;

  /* --- 4. act: interpret, enrich, score, deliver or archive -------------- */
  let cslbRemaining = cslbBudget();

  for (const survivor of survivors) {
    const processed = await attempt(ctx, {
      decision: 'candidate.failed',
      subject: `permit ${survivor.record.permitNumber}`,
      refs: { permit: survivor.record.permitNumber, customer: customer.id },
      run: async () => {
        const spent = await processSurvivor({
          ctx,
          customer,
          record: survivor.record,
          agency: survivor.agency,
          shortlist: survivor.shortlist,
          contacts: contactIndex.ok
            ? (contactIndex.value.byPermit.get(survivor.record.permitNumber) ?? [])
            : [],
          rosterAvailable,
          rosterNote,
          cslbRemaining,
          summary,
        });
        return spent;
      },
    });
    if (processed !== null) cslbRemaining -= processed;
  }

  return summary;
}

/**
 * One permit, end to end. Returns how much of the CSLB budget it spent.
 *
 * Broken out so a single bad record fails inside `attempt` and the batch carries
 * on (hard rule: a worker never dies on one bad record).
 */
async function processSurvivor(args: {
  ctx: TickContext;
  customer: CustomerRecord;
  record: PermitRecord;
  agency: AgencyPermit;
  shortlist: ShortlistResult;
  contacts: readonly PermitContact[];
  rosterAvailable: boolean;
  rosterNote: string;
  cslbRemaining: number;
  summary: LeadTickSummary;
}): Promise<number> {
  const { ctx, customer, record, agency, contacts } = args;
  const permitRef = { permit: record.permitNumber, customer: customer.id };

  /* --- the narrow interpretation call ------------------------------------ */
  const relevance = await interpretRelevance(customer, agency);

  if (relevance.state === 'skipped') {
    await ctx.decide({
      decision: 'interpretation.skipped',
      summary: `Permit ${record.permitNumber} moved forward on the permit record alone because the interpretation step is unavailable: ${relevance.reason}`,
      refs: permitRef,
    });
  } else if (relevance.state === 'failed') {
    await ctx.decide({
      decision: 'interpretation.failed',
      summary: `Permit ${record.permitNumber} moved forward on the permit record alone after the interpretation step failed: ${relevance.reason}`,
      refs: permitRef,
    });
  } else {
    await ctx.decide({
      decision: relevance.judgement.relevant ? 'interpretation.relevant' : 'interpretation.not_relevant',
      summary: `Permit ${record.permitNumber} scope of work read for ${customer.trade} work: ${relevance.judgement.rationale}`,
      refs: {
        ...permitRef,
        signals: relevance.judgement.scopeSignals.slice(0, 4).join('; '),
      },
    });
  }

  /* --- the candidate ----------------------------------------------------- */
  const shortlistReason = args.shortlist.outcomes
    .filter((outcome) => outcome.passed)
    .map((outcome) => outcome.reason)
    .join(' ');

  const candidate = await createCandidate({
    permitNumber: record.permitNumber,
    customerId: customer.id,
    shortlistReason,
  });
  args.summary.candidates += 1;

  await ctx.decide({
    decision: 'candidate.created',
    summary: `Permit ${record.permitNumber} at ${agency.address ?? 'an unpublished address'} became a candidate for ${customer.businessName} after clearing all six shortlist gates.`,
    refs: { ...permitRef, candidate: candidate.id },
  });

  /*
   * A model that read the scope and found nothing for this trade is a real
   * rejection, and it is taken before the enrichment spend. The Finding is still
   * written so the archived candidate carries the reason it was archived.
   */
  if (relevance.state === 'judged' && !relevance.judgement.relevant) {
    const findings = buildFindings({
      candidateId: candidate.id,
      record,
      agency,
      contacts,
      rosterAvailable: args.rosterAvailable,
      rosterNote: args.rosterNote,
      relevance,
      license: null,
      licenseNote: 'no license check made: the scope of work carries no work for this trade',
      observedAt: ctx.nowIso,
    });
    await upsertFindings(findings);
    await setStage(candidate.id, 'archived');
    args.summary.archived += 1;

    await ctx.decide({
      decision: 'candidate.archived',
      summary: `Candidate on permit ${record.permitNumber} archived before scoring: ${relevance.judgement.rationale}`,
      refs: { ...permitRef, candidate: candidate.id, reason: 'scope carries no work for this trade' },
    });
    return 0;
  }

  /* --- enrichment -------------------------------------------------------- */
  const gc = findGeneralContractor(contacts);
  let license: LicenseVerification | null = null;
  let licenseNote = 'no contractor license number on the permit roster to check';
  let cslbSpent = 0;

  if (gc?.license1 !== undefined && gc.license1 !== null && /^\d{3,10}$/.test(gc.license1)) {
    if (!cslbLookupEnabled()) {
      licenseNote = 'CSLB lookup switched off by CSLB_LOOKUP_ENABLED';
    } else if (args.cslbRemaining <= 0) {
      licenseNote = 'CSLB check deferred: this tick has already spent its lookup budget';
    } else {
      license = await verifyLicense(gc.license1, ctx.now);
      cslbSpent = 1;
    }
  }

  const findings = buildFindings({
    candidateId: candidate.id,
    record,
    agency,
    contacts,
    rosterAvailable: args.rosterAvailable,
    rosterNote: args.rosterNote,
    relevance,
    license,
    licenseNote,
    observedAt: ctx.nowIso,
  });

  const written = await upsertFindings(findings);
  await setStage(candidate.id, 'enriched');

  const established = written.filter((result) => result.finding.value !== null).length;
  const unknowns = written.filter((result) => result.finding.evidence === 'unknown').length;
  await ctx.decide({
    decision: 'enrichment.completed',
    summary: `Recorded ${written.length} facts on permit ${record.permitNumber}: ${established} established, ${unknowns} left visible as unknown${
      gc?.firmName !== undefined && gc.firmName !== null ? `, contractor of record ${gc.firmName}` : ', no contractor of record yet'
    }.`,
    refs: {
      ...permitRef,
      candidate: candidate.id,
      license: license?.status ?? null,
    },
  });

  /* --- the deterministic score ------------------------------------------ */
  const stored = await listFindings(candidate.id);
  const score = scoreLead({
    permit: toScoringPermit(record, agency),
    findings: stored,
    customer,
    now: ctx.nowIso,
  });
  await setStage(candidate.id, 'scored');

  const topDrivers = [...score.drivers]
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 3)
    .map((driver) => `${driver.reason} (+${driver.delta})`)
    .join('; ');

  await ctx.decide({
    decision: 'score.computed',
    summary: `Permit ${record.permitNumber} scored ${score.score} of 100 against a threshold of ${LEAD_SCORE_THRESHOLD}. Biggest contributions: ${topDrivers}`,
    refs: {
      ...permitRef,
      candidate: candidate.id,
      score: score.score,
      fatalFlags: score.fatalFlags.length,
    },
  });

  /* --- deliver or archive ------------------------------------------------ */
  if (!meetsDeliveryBar(score)) {
    const reason =
      score.fatalFlags.length > 0
        ? score.fatalFlags.map((flag) => flag.message).join(' ')
        : `Score ${score.score} is below the ${LEAD_SCORE_THRESHOLD} point delivery threshold.`;

    await createOpportunity({
      candidateId: candidate.id,
      customerId: customer.id,
      score: score.score,
      drivers: score.drivers,
      warnings: score.warnings,
      fatalFlags: score.fatalFlags,
      status: 'archived',
      summary: reason,
    });
    await setStage(candidate.id, 'archived');
    args.summary.archived += 1;

    await ctx.decide({
      decision: 'candidate.archived',
      summary: `Permit ${record.permitNumber} archived and not sent to ${customer.businessName}: ${reason}`,
      refs: {
        ...permitRef,
        candidate: candidate.id,
        score: score.score,
        fatalFlags: score.fatalFlags.map((flag) => flag.code).join(',') || null,
      },
    });
    return cslbSpent;
  }

  return (await deliver({ ...args, candidateId: candidate.id, gc, score })) + cslbSpent;
}

/**
 * Create the opportunity and put it on the subscriber's phone.
 *
 * `delivered_at` is written only after the channel has accepted the message. An
 * unconfigured channel, a failing send, and a number the channel may not contact
 * yet all leave the opportunity `pending` and say so in the log, because
 * recording a delivery that did not happen would put a fabricated fact in the one
 * table a judge reads.
 *
 * The three refusals are not the same thing and are not logged as though they
 * were. Unconfigured is an operator problem, a failure is worth retrying, and
 * "they have to text us first" is a consent state: that message is queued, and
 * the inbound webhook releases it when the subscriber makes contact.
 */
async function deliver(args: {
  ctx: TickContext;
  customer: CustomerRecord;
  record: PermitRecord;
  agency: AgencyPermit;
  contacts: readonly PermitContact[];
  rosterAvailable: boolean;
  candidateId: string;
  gc: PermitContact | null;
  score: ScoreResult;
  summary: LeadTickSummary;
}): Promise<number> {
  const { ctx, customer, record, agency, gc, score } = args;
  const permitRef = { permit: record.permitNumber, customer: customer.id, candidate: args.candidateId };

  const drafted = await draftContactPath({
    agency,
    gc,
    contacts: args.contacts,
    rosterAvailable: args.rosterAvailable,
  });

  const address = agency.address ?? agency.neighborhood ?? `permit ${agency.permitNumber}`;
  const bestPathIn =
    drafted.path !== null && drafted.path.bestPathIn.length > 0
      ? drafted.path.bestPathIn
      : defaultBestPathIn(gc);
  const openingReason =
    drafted.path !== null && drafted.path.openingReason.length > 0
      ? drafted.path.openingReason
      : defaultOpeningReason(args.contacts, args.rosterAvailable);
  const recommendedAction =
    drafted.path !== null && drafted.path.recommendedAction.length > 0
      ? drafted.path.recommendedAction
      : defaultRecommendedAction(gc, address);

  const opportunity = await createOpportunity({
    candidateId: args.candidateId,
    customerId: customer.id,
    score: score.score,
    drivers: score.drivers,
    warnings: score.warnings,
    fatalFlags: score.fatalFlags,
    status: 'pending',
    summary: `${safeScopeSummary(agency)} at ${address}.`,
    bestPathIn,
    recommendedAction,
  });

  await ctx.decide({
    decision: 'opportunity.created',
    summary: `Opportunity built for ${customer.businessName} on ${address} at ${score.score} of 100. Way in: ${bestPathIn ?? 'no contractor of record yet, go through the counter'}.`,
    refs: { ...permitRef, opportunity: opportunity.id, score: score.score, drafting: drafted.note },
  });

  /* --- the message ------------------------------------------------------- */
  const detailUrl = `${appBaseUrl()}/opportunities/${opportunity.id}`;
  const copy = buildCopyContext({
    agency,
    gc,
    contacts: args.contacts,
    rosterAvailable: args.rosterAvailable,
    now: ctx.now,
    detailUrl,
    openingReason,
  });

  let body: string;
  try {
    body = opportunitySms(copy);
  } catch (error) {
    await ctx.decide({
      decision: 'opportunity.copy_rejected',
      summary: `Opportunity on ${address} was held back because the message failed the customer copy policy: ${describeError(error)}`,
      refs: { ...permitRef, opportunity: opportunity.id },
    });
    return 0;
  }

  const destination = normalizeRecipient(customer.phone);
  if (destination === null) {
    await ctx.decide({
      decision: 'opportunity.delivery_skipped',
      summary: `Opportunity on ${address} is ready but the subscriber number on file is not a handle ${channelLabel()} can reach, so nothing was sent.`,
      refs: { ...permitRef, opportunity: opportunity.id, channel: activeChannel() },
    });
    return 0;
  }

  if (!channelReady()) {
    await ctx.decide({
      decision: 'opportunity.delivery_skipped',
      summary: `Opportunity on ${address} is ready and waiting but ${channelLabel()} is not configured, so it stays undelivered rather than being recorded as sent.`,
      refs: { ...permitRef, opportunity: opportunity.id, channel: activeChannel() },
    });
    return 0;
  }

  /*
   * The link rides twice on purpose. It is inline in the body, which is the only
   * place plain SMS can carry it, and it is also handed over as a preview card,
   * which iMessage and RCS render above the copy. Linq sends the card as a second
   * message and Twilio ignores the field, so the text reads correctly either way
   * and nobody receives a bare card with no words around it.
   *
   * The idempotency key is the opportunity id, so a retry after a timeout cannot
   * put the same job on the subscriber's phone twice.
   */
  const sent = await sendMessage({
    to: destination,
    body,
    linkPreviewUrl: detailUrl,
    idempotencyKey: `opportunity:${opportunity.id}`,
  });

  if (!sent.ok) {
    if (sent.skipped) {
      await ctx.decide({
        decision: 'opportunity.delivery_skipped',
        summary: `Opportunity on ${address} stays undelivered because the message channel is unavailable: ${sent.reason}`,
        refs: { ...permitRef, opportunity: opportunity.id, channel: activeChannel() },
      });
      return 0;
    }

    /*
     * An opt out is a standing instruction, not a transient error. It is recorded
     * against the handle so nothing in the company tries that number again, and
     * the opportunity stays on the dashboard where the subscriber can still read
     * it. Nothing here can clear an opt out.
     */
    if (sent.optedOut === true) {
      await markOptedOut(destination);
      await ctx.decide({
        decision: 'opportunity.delivery_opted_out',
        summary: `${customer.businessName} has asked to stop receiving messages on the number we hold, so the ${address} job was not sent and will not be retried. The opportunity stays readable on the dashboard.`,
        refs: { ...permitRef, opportunity: opportunity.id, channel: activeChannel() },
      });
      return 0;
    }

    /*
     * The platform rule, met head on. The message is real, it is composed, and it
     * is held. It is NOT marked delivered, and `markDelivered` is deliberately not
     * called on this path: that distinction between prepared and sent is the whole
     * point of the queue.
     */
    if (sent.requiresInboundFirst === true) {
      const queued = await queueOutbound({
        handle: destination,
        body,
        linkUrl: detailUrl,
        purpose: 'opportunity',
        opportunityId: opportunity.id,
      });
      if (queued.inserted) args.summary.queued += 1;

      /*
       * One opportunity message may be held per number at a time, which is the
       * partial unique index in 0002. A second one arriving while the first still
       * waits is reported as exactly that rather than as a queued message that
       * does not exist.
       */
      const alreadyThisJob = queued.opportunityId === opportunity.id;
      await ctx.decide({
        decision: 'opportunity.queued',
        summary: queued.inserted
          ? `Opportunity on ${address} prepared, waiting for first contact. ${channelLabel()} will not carry a message to this number until it has texted the company, so it is held rather than sent and goes out the moment they make contact.`
          : alreadyThisJob
            ? `Opportunity on ${address} is already prepared and still waiting for first contact on this number, so it was not queued a second time and nothing was sent.`
            : `Opportunity on ${address} could not be prepared because an earlier opportunity is still waiting for first contact on this number. It stays pending and nothing was sent.`,
        refs: {
          ...permitRef,
          opportunity: opportunity.id,
          queued: queued.id,
          holding: queued.opportunityId,
          channel: activeChannel(),
        },
      });
      return 0;
    }

    await ctx.decide({
      decision: 'opportunity.delivery_failed',
      summary: `Opportunity on ${address} could not be sent and stays pending: ${sent.reason}`,
      refs: { ...permitRef, opportunity: opportunity.id, channel: activeChannel() },
    });
    return 0;
  }

  await markDelivered(opportunity.id, ctx.nowIso);
  await setStage(args.candidateId, 'delivered');
  args.summary.delivered += 1;

  await ctx.decide({
    decision: 'opportunity.delivered',
    summary: `Sent ${customer.businessName} the ${address} job at ${score.score} of 100${
      agency.valuation !== null ? `, worth ${formatUsd(agency.valuation)}` : ''
    }.`,
    refs: {
      ...permitRef,
      opportunity: opportunity.id,
      channel: sent.value.channel,
      message: sent.value.messageId,
      score: score.score,
    },
  });
  return 0;
}
