/**
 * Terac contractor recruitment: hiring the buyer to answer the question.
 *
 * WHY THIS EXISTS
 * ---------------
 * The lead pipeline (see `kickoff/diagrams/leadvelocity-lead-agent-pipeline.mermaid`)
 * already has a node for hiring a human: when scoring hits a blocking `unknown`
 * on a high-value candidate, the company buys five minutes of expert judgement,
 * upgrades the evidence label, and rescores.
 *
 * The expert qualified to answer "does this job still need an electrical sub"
 * is a commercial electrical contractor in San Francisco. Which is also, exactly,
 * the person the Sales Agent is trying to find.
 *
 * So one paid interaction produces two assets:
 *
 *   1. a `verified` or `corroborated` Finding, which was the original purpose
 *   2. a QUALIFIED, CONSENTING PROSPECT who has just been shown a real project
 *      in their own trade and territory that they did not know existed
 *
 * The second one is the acquisition channel. It is the warmest possible lead:
 * verified identity, paid for their attention, and the product demonstrated
 * itself before anybody asked them for money. That is the kickoff's own answer
 * to "how do you get customers with no salespeople", executed literally.
 *
 * WHAT THIS FIXES
 * ---------------
 * - Cold outreach compliance (kickoff section 4): SMS only after opt-in. The
 *   consent screening answer IS the opt-in record, captured before any message.
 * - The CSLB gap (docs/BLOCKERS.md section 8): the prospect pool derived from
 *   permit contacts carries no classification, so C-10 status sits at `unknown`.
 *   A recruited contractor self-reports their license number, which is then run
 *   through the CSLB per-license lookup in `cslb.ts`. Self-report corroborated
 *   by an independent registry check is `verified`, honestly earned.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a fifth agent. The Sales Agent owns recruitment, the Lead Agent owns the
 * question, and they coordinate through the `prospects` table like everything
 * else (architecture rule 4).
 *
 * Not a replacement for the GenPop copy study. That study is the required event
 * rule and stays P0. This is additive and costs separate money.
 *
 * COST DISCIPLINE
 * ---------------
 * A niche B2B panel is dramatically more expensive than a general population
 * one. Nothing here launches anything. `requestPanelFeasibility` asks Terac
 * whether they can even source this audience and at what CPI, which is free and
 * asynchronous, and `createRecruitmentDraft` builds the study without launching
 * it. Spending still goes through `launchStudy` in `terac.ts`, which refuses
 * without an explicit ceiling.
 */
import { z } from 'zod';

import { appBaseUrl, envInt, envOr, hasCapability, missingKeys, requireEnv } from '@/lib/config/deployment-env';

/* -------------------------------------------------------------------------- */
/* Result type, shared shape with terac.ts                                    */
/* -------------------------------------------------------------------------- */

export type RecruitResult<T> =
  | { ok: true; skipped: false; value: T }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; reason: string };

function skipped<T>(): RecruitResult<T> {
  return {
    ok: false,
    skipped: true,
    reason: `terac capability unconfigured (missing: ${missingKeys('terac').join(', ')})`,
  };
}

function baseUrl(): string {
  return envOr('TERAC_BASE_URL', 'https://terac.com/api/external/v2').replace(/\/+$/, '');
}

function sample(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}...` : flat;
}

async function call(
  path: string,
  init: { method: string; body?: unknown },
): Promise<RecruitResult<{ json: unknown; text: string }>> {
  try {
    const response = await fetch(`${baseUrl()}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${requireEnv('TERAC_API_KEY')}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(envInt('TERAC_TIMEOUT_MS', 25_000)),
    });
    const text = await response.text();
    if (!response.ok) {
      return { ok: false, skipped: false, reason: `terac ${init.method} ${path} -> ${response.status}: ${sample(text)}` };
    }
    try {
      return { ok: true, skipped: false, value: { json: JSON.parse(text) as unknown, text } };
    } catch {
      return { ok: false, skipped: false, reason: `terac ${init.method} ${path} non-JSON: ${sample(text)}` };
    }
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
    return { ok: false, skipped: false, reason: `terac ${init.method} ${path} failed: ${message}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Audience definition                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Filter slugs used to narrow the panel, from Terac's published catalog.
 *
 * The catalog has no professional-licence filter and no metro or zip filter, so
 * geography stops at city and the C-10 requirement is enforced by a screening
 * question instead (see `contractorScreeningQuestions`).
 *
 * Option VALUES are deliberately not hardcoded. Terac's catalog exposes the
 * legal options per slug at `/filters/{slug}/options`, and guessing them would
 * violate hard rule 8 the same way guessing a permit column would. They are
 * resolved at call time and a miss is reported, never silently dropped.
 */
export const CONTRACTOR_FILTER_SEARCHES: ReadonlyArray<{
  slug: string;
  operator: '$in' | '$eq';
  /** Search terms passed to the options endpoint, first match wins per term. */
  searches: readonly string[];
  /** When true, a total miss is fatal rather than a warning. */
  required: boolean;
}> = Object.freeze([
  { slug: 'multi_select--country', operator: '$in', searches: ['United States'], required: true },
  { slug: 'multi_select--state', operator: '$in', searches: ['California'], required: true },
  { slug: 'multi_select--city', operator: '$in', searches: ['San Francisco'], required: false },
  { slug: 'multi_select--industry', operator: '$in', searches: ['Construction'], required: false },
  {
    slug: 'multi_select--seniority',
    operator: '$in',
    searches: ['Owner', 'Founder', 'C-Level', 'Executive', 'Director', 'Manager'],
    required: false,
  },
  {
    slug: 'multi_select--company_size',
    operator: '$in',
    searches: ['1-10', '11-50', '2-10', '10-50', '51-200'],
    required: false,
  },
]);

const filterOptionsSchema = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string() })).default([]),
});

/** One resolved filter clause plus what matched, so the log can show its work. */
export interface ResolvedFilter {
  slug: string;
  operator: string;
  optionIds: string[];
  matchedNames: string[];
  missedSearches: string[];
}

/**
 * Turn the audience definition into real filter clauses.
 *
 * Queries the options endpoint per slug so every value sent to Terac is one
 * Terac published. A slug that matches nothing is reported rather than sent
 * empty, because an empty clause silently widens the audience and a widened
 * audience is a wasted panel.
 */
export async function resolveContractorFilters(): Promise<RecruitResult<ResolvedFilter[]>> {
  if (!hasCapability('terac')) return skipped<ResolvedFilter[]>();

  const resolved: ResolvedFilter[] = [];
  for (const spec of CONTRACTOR_FILTER_SEARCHES) {
    const optionIds: string[] = [];
    const matchedNames: string[] = [];
    const missedSearches: string[] = [];

    for (const term of spec.searches) {
      const res = await call(
        `/filters/${encodeURIComponent(spec.slug)}/options?search=${encodeURIComponent(term)}&per_page=25`,
        { method: 'GET' },
      );
      if (!res.ok) {
        if (spec.required) return { ok: false, skipped: false, reason: res.reason };
        missedSearches.push(term);
        continue;
      }
      const parsed = filterOptionsSchema.safeParse(res.value.json);
      if (!parsed.success) {
        missedSearches.push(term);
        continue;
      }
      const hit =
        parsed.data.data.find((o) => o.name.toLowerCase() === term.toLowerCase()) ??
        parsed.data.data.find((o) => o.name.toLowerCase().includes(term.toLowerCase()));
      if (hit === undefined) {
        missedSearches.push(term);
        continue;
      }
      if (!optionIds.includes(hit.id)) {
        optionIds.push(hit.id);
        matchedNames.push(hit.name);
      }
    }

    if (optionIds.length === 0) {
      if (spec.required) {
        return {
          ok: false,
          skipped: false,
          reason: `terac filter ${spec.slug} matched none of: ${spec.searches.join(', ')}. Refusing to send an empty clause that would widen the panel.`,
        };
      }
      // Non-required slug with no match is dropped, and said so out loud.
      resolved.push({ slug: spec.slug, operator: spec.operator, optionIds: [], matchedNames: [], missedSearches });
      continue;
    }
    resolved.push({ slug: spec.slug, operator: spec.operator, optionIds, matchedNames, missedSearches });
  }
  return { ok: true, skipped: false, value: resolved };
}

/** Shape the resolved clauses into the `filters` array the opportunity expects. */
export function toFilterPayload(resolved: readonly ResolvedFilter[]): Array<Record<string, Record<string, string[]>>> {
  return resolved
    .filter((clause) => clause.optionIds.length > 0)
    .map((clause) => ({ [clause.slug]: { [clause.operator]: clause.optionIds } }));
}

/* -------------------------------------------------------------------------- */
/* Screening: the hard qualification the filter catalog cannot express         */
/* -------------------------------------------------------------------------- */

/**
 * Questions that decide whether a respondent is genuinely our buyer.
 *
 * `must_one_of` with an explicit "None of these" marked `reject` is Terac's own
 * documented pattern for qualifying a licensed professional audience.
 *
 * The licence NUMBER is collected as free text on the qualifying answer. That
 * number is what `cslb.verifyLicense` then checks independently, which is how a
 * self-report becomes a `verified` Finding instead of an `inferred` one.
 *
 * The final question is the consent gate. Nothing is ever texted to a
 * participant who did not select the opt-in answer.
 */
export function contractorScreeningQuestions(): Array<Record<string, unknown>> {
  return [
    {
      key: 'license',
      text: 'Which of these contractor licences does your business currently hold in California?',
      pick: 'any',
      answers: [
        { text: 'C-10 Electrical', qualify_logic: 'must_one_of', allow_free_text: true },
        { text: 'B General Building', qualify_logic: 'may', allow_free_text: true },
        { text: 'None of these', qualify_logic: 'reject' },
      ],
      min_qualifying: 1,
    },
    {
      key: 'commercial',
      text: 'Does your business bid commercial work, such as office, retail, medical, or hotel projects?',
      pick: 'one',
      answers: [
        { text: 'Yes, commercial is most of our work', qualify_logic: 'must_one_of' },
        { text: 'Yes, some commercial alongside residential', qualify_logic: 'must_one_of' },
        { text: 'No, residential only', qualify_logic: 'reject' },
      ],
      min_qualifying: 1,
    },
    {
      key: 'territory',
      text: 'Do you take work in San Francisco?',
      pick: 'one',
      answers: [
        { text: 'Yes', qualify_logic: 'must' },
        { text: 'No', qualify_logic: 'reject' },
      ],
    },
    {
      key: 'min_project_value',
      text: 'What is the smallest project your business would normally bid?',
      pick: 'one',
      answers: [
        { text: 'Under 50,000 dollars', qualify_logic: 'may' },
        { text: '50,000 to 100,000 dollars', qualify_logic: 'may' },
        { text: '100,000 to 500,000 dollars', qualify_logic: 'may' },
        { text: 'Over 500,000 dollars', qualify_logic: 'may' },
      ],
    },
    {
      key: 'contact_opt_in',
      text: 'We found the project above by watching San Francisco permit records. May we text you the next one we find that fits your business? Answering no will not affect your payment for this study.',
      pick: 'one',
      answers: [
        { text: 'Yes, text me the next matching project', qualify_logic: 'may', allow_free_text: true },
        { text: 'No thanks', qualify_logic: 'may' },
      ],
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Feasibility: free, asynchronous, and the first thing to fire               */
/* -------------------------------------------------------------------------- */

const feasibilitySchema = z
  .object({
    id: z.string().min(1),
    status: z.enum(['RECEIVED', 'RESPONDED', 'WON', 'LOST', 'NOT_PURSUED']),
    costPerParticipant: z.string().nullable().optional(),
    submissionCount: z.number().int().optional(),
    respondedAt: z.string().nullable().optional(),
    dashboard_url: z.string().optional(),
  })
  .passthrough();

export interface PanelFeasibility {
  requestId: string;
  status: 'RECEIVED' | 'RESPONDED' | 'WON' | 'LOST' | 'NOT_PURSUED';
  /** Confirmed CPI once status is RESPONDED. Null until then. Never guessed. */
  costPerParticipant: string | null;
  submissionCount: number | null;
  dashboardUrl: string | null;
}

/**
 * Ask Terac whether they can source San Francisco commercial electrical
 * contractors at all, and at what cost per participant.
 *
 * Free, and asynchronous: the reply comes back `RECEIVED` with a null CPI while
 * Terac prices it out of band. Poll `getPanelFeasibility` until `RESPONDED`.
 * Because of that lag this is the first call to make, well before you decide
 * whether the channel is affordable.
 */
export async function requestPanelFeasibility(opts: {
  submissionCount?: number;
  timelineHours?: number;
  requestorEmail?: string;
}): Promise<RecruitResult<PanelFeasibility>> {
  if (!hasCapability('terac')) return skipped<PanelFeasibility>();

  const body: Record<string, unknown> = {
    taskDescription:
      'Review one real, currently active San Francisco commercial building permit and answer a short set of questions about whether the job still needs an electrical subcontractor, who the right person to approach would be, and how you would price the electrical scope. About ten minutes.',
    panelDescription:
      'Owners, principals, estimators and project managers at licensed commercial electrical contracting businesses (CSLB C-10) that bid work in San Francisco, California. Small to mid sized shops, roughly 5 to 100 employees.',
    submissionCount: opts.submissionCount ?? envInt('TERAC_RECRUIT_COUNT', 5),
    timelineHours: opts.timelineHours ?? envInt('TERAC_RECRUIT_TIMELINE_HOURS', 24),
  };
  const email = opts.requestorEmail ?? envOr('TERAC_REQUESTOR_EMAIL', '');
  if (email.length > 0) body['requestorEmail'] = email;

  const res = await call('/feasibility/requests', { method: 'POST', body });
  if (!res.ok) return res;

  const parsed = feasibilitySchema.safeParse(res.value.json);
  if (!parsed.success) {
    return { ok: false, skipped: false, reason: `terac feasibility response unexpected (${parsed.error.message}). Body: ${sample(res.value.text)}` };
  }
  return {
    ok: true,
    skipped: false,
    value: {
      requestId: parsed.data.id,
      status: parsed.data.status,
      costPerParticipant: parsed.data.costPerParticipant ?? null,
      submissionCount: parsed.data.submissionCount ?? null,
      dashboardUrl: parsed.data.dashboard_url ?? null,
    },
  };
}

/** Poll a feasibility request. `RESPONDED` means the CPI is real and confirmed. */
export async function getPanelFeasibility(requestId: string): Promise<RecruitResult<PanelFeasibility>> {
  if (!hasCapability('terac')) return skipped<PanelFeasibility>();

  const res = await call(`/feasibility/requests/${encodeURIComponent(requestId)}`, { method: 'GET' });
  if (!res.ok) return res;

  const parsed = feasibilitySchema.safeParse(res.value.json);
  if (!parsed.success) {
    return { ok: false, skipped: false, reason: `terac feasibility response unexpected (${parsed.error.message}). Body: ${sample(res.value.text)}` };
  }
  return {
    ok: true,
    skipped: false,
    value: {
      requestId: parsed.data.id,
      status: parsed.data.status,
      costPerParticipant: parsed.data.costPerParticipant ?? null,
      submissionCount: parsed.data.submissionCount ?? null,
      dashboardUrl: parsed.data.dashboard_url ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Draft (free)                                                               */
/* -------------------------------------------------------------------------- */

/** What the panel is shown: one real opportunity, never a mock (hard rule 5). */
export interface RecruitmentBrief {
  permitNumber: string;
  projectAddress: string;
  neighborhood: string | null;
  valuationUsd: number | null;
  scopeSummary: string;
  generalContractor: string | null;
  /** Absolute URL of the opportunity detail page they can open. */
  detailUrl: string;
}

/**
 * The research question the panel is paid to answer.
 *
 * This is the part that earns the Finding. It is written so the answer is
 * genuinely useful to scoring, not a pretext for the sales contact: whether the
 * electrical scope is still open is exactly the `unknown` that blocks the score.
 */
export function recruitmentTaskDescription(brief: RecruitmentBrief): string {
  const value =
    brief.valuationUsd === null ? 'an undisclosed value' : `a stated value of $${brief.valuationUsd.toLocaleString()}`;
  const gc = brief.generalContractor === null ? 'The general contractor is not named on the permit.' : `The general contractor on the permit is ${brief.generalContractor}.`;
  return [
    `San Francisco building permit ${brief.permitNumber} covers work at ${brief.projectAddress}${brief.neighborhood === null ? '' : ` in ${brief.neighborhood}`}, with ${value}.`,
    `Scope as filed: "${brief.scopeSummary}"`,
    gc,
    '',
    'Based on your own experience bidding this kind of work, please answer:',
    '1. Would a job like this still need an electrical subcontractor at this stage, or would that scope normally already be awarded?',
    '2. Who would you actually call to get on this job, and what job title would they hold?',
    '3. Roughly what would the electrical scope be worth on a project like this?',
    '4. Is there anything on the permit that tells you this job is not worth chasing?',
  ].join('\n');
}

/**
 * Build the recruitment study as a DRAFT. Costs nothing, commits to nothing.
 *
 * Launching is deliberately left to `launchStudy` in `terac.ts`, which will not
 * spend without an explicit ceiling.
 */
export async function createRecruitmentDraft(opts: {
  brief: RecruitmentBrief;
  projectId: string;
  numParticipants?: number;
}): Promise<RecruitResult<{ opportunityId: string; status: string; quotedTotalCents: number | null; filters: ResolvedFilter[] }>> {
  if (!hasCapability('terac')) return skipped();

  const filters = await resolveContractorFilters();
  if (!filters.ok) return filters;

  const body = {
    title: 'Commercial electrical contractors: is this job still open?',
    internal_title: `LeadVelocity contractor recruitment ${opts.brief.permitNumber}`,
    description: recruitmentTaskDescription(opts.brief),
    project_id: opts.projectId,
    num_participants: opts.numParticipants ?? envInt('TERAC_RECRUIT_COUNT', 5),
    business_type: 'b2b',
    // Filtered, not unrestricted: this is the opposite of the GenPop copy study.
    unrestricted_audience: false,
    filters: toFilterPayload(filters.value),
    screening_questions: contractorScreeningQuestions(),
    tasks: [
      {
        sequence: 1,
        task_type: 'activity' as const,
        review_type: 'manual_review' as const,
        task_url: `${appBaseUrl().replace(/\/+$/, '')}/opportunities/${encodeURIComponent(opts.brief.permitNumber)}`,
        title: 'Review one real San Francisco permit',
        description: 'Open the project page, read the permit, and answer four short questions from your own experience.',
        duration_minutes: 10,
      },
    ],
    expected_days_to_complete: 1,
  };

  const res = await call('/opportunities', { method: 'POST', body });
  if (!res.ok) return res;

  const parsed = z
    .object({
      id: z.string().min(1),
      status: z.string().min(1),
      pricing: z.object({ total_cost_cents: z.number().int().optional() }).passthrough().optional(),
    })
    .passthrough()
    .safeParse(res.value.json);
  if (!parsed.success) {
    return { ok: false, skipped: false, reason: `terac recruitment draft response unexpected (${parsed.error.message}). Body: ${sample(res.value.text)}` };
  }

  return {
    ok: true,
    skipped: false,
    value: {
      opportunityId: parsed.data.id,
      status: parsed.data.status,
      quotedTotalCents: parsed.data.pricing?.total_cost_cents ?? null,
      filters: filters.value,
    },
  };
}
