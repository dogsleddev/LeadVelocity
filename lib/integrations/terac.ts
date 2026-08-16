/**
 * Terac client for the required GenPop message study.
 *
 * Event rule (kickoff section 3 and 10.3): every project must collect real human
 * input through Terac during the event, with a clear before and after. Our use is
 * the message study. The Sales Agent drafts three variants of the sample outreach
 * (`lib/copy/templates.ts`), a General Population panel picks between them,
 * deterministic code picks the winner, and the adopted copy plus the panel
 * numbers render on the CEO dashboard.
 *
 * ==========================================================================
 * WIRE CONTRACT: VERIFIED against the Terac External API v2 OpenAPI spec
 * (https://terac.com/api/external/v2/openapi.json, title "Terac External API",
 * version 2.0.0). Auth is `Authorization: Bearer <key>`. Base URL defaults to
 * https://terac.com/api/external/v2 and is overridable with TERAC_BASE_URL.
 *
 * Note the spec's own caveat: "This API is in beta. Endpoints and request/response
 * shapes may change before general availability." Responses are therefore parsed
 * leniently (passthrough + optional fields) so an additive change upstream does
 * not break the study, while anything we actually depend on is required.
 * ==========================================================================
 *
 * HOW A "GENERAL POPULATION STUDY" MAPS ONTO THIS API
 *
 * Terac's object model is project -> opportunity -> submissions. There is no
 * "survey" primitive, so the study is expressed as:
 *
 *   - an *opportunity* with `unrestricted_audience: true`, which is what makes
 *     the panel general population rather than a filtered expert pool;
 *   - the study questions carried as `screening_questions`, every answer marked
 *     `qualify_logic: 'may'` so the questions collect an opinion instead of
 *     disqualifying anyone;
 *   - one nominal `activity` task, because the API requires at least one;
 *   - results read back from `screening_stats` on the opportunity (per-answer
 *     `selected` counts and `share`) and, row by row, from `submissions`.
 *
 * This is a deliberate modelling decision, not a workaround: screening questions
 * are the API's mechanism for asking a panel a structured question, and their
 * aggregates are exactly the "panel numbers" the before-and-after beat needs.
 *
 * DEVIATION FROM THE KICKOFF, RECORDED HONESTLY: the kickoff asks the panel to
 * "rank the three texts" and produce a mean rank. The screening mechanism yields
 * forced first-choice selections, not ordinal ranks, so the study asks three
 * separate first-choice questions (most trusted, clearest, most likely to get a
 * reply) and the winner is decided on combined selections with trust breaking
 * ties. Same intent, real numbers, and no invented ranks.
 *
 * SPENDING MONEY: launching an opportunity is a paid action. `launchStudy` will
 * not spend anything unless the caller passes an explicit authorization carrying
 * a budget ceiling, and it re-checks the live quote against that ceiling before
 * committing. See `StudySpendAuthorization`.
 *
 * Capability gated on `TERAC_API_KEY` via `hasCapability('terac')`. Unconfigured
 * returns `{ ok: false, skipped: true }` and the Sales Agent logs a skipped
 * decision. Nothing throws at import time. Panel numbers are never invented: an
 * unreported count is null and the UI shows it as unknown (hard rule #3).
 */
import { z } from 'zod';

import {
  appBaseUrl,
  envInt,
  envOr,
  hasCapability,
  missingKeys,
  requireEnv,
} from '@/lib/config/deployment-env';

/* -------------------------------------------------------------------------- */
/* Wire schemas (verified against the v2 OpenAPI spec)                        */
/* -------------------------------------------------------------------------- */

/** One message put in front of the panel. */
export const teracVariantSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
});
export type TeracVariant = z.infer<typeof teracVariantSchema>;

/** POST /projects response. */
const projectResponseSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().optional(),
    dashboard_url: z.string().optional(),
  })
  .passthrough();

/** Per-answer aggregate inside `screening_stats`. */
const screeningStatAnswerSchema = z
  .object({
    text: z.string(),
    selected: z.number().int().nonnegative(),
    share: z.number(),
  })
  .passthrough();

/** One question's aggregate inside `screening_stats`. */
const screeningStatSchema = z
  .object({
    screening_question: z.string(),
    graded: z.number().int().nonnegative().optional(),
    answers: z.array(screeningStatAnswerSchema).default([]),
  })
  .passthrough();

/** Opportunity object as returned by create / get / launch. */
const opportunityResponseSchema = z
  .object({
    id: z.string().min(1),
    status: z.string().min(1),
    num_participants: z.number().int().optional(),
    pricing: z
      .object({
        cost_per_participant_cents: z.number().int().optional(),
        total_cost_cents: z.number().int().optional(),
        currency: z.string().optional(),
      })
      .passthrough()
      .optional(),
    submission_stats: z
      .object({
        total: z.number().int().nonnegative().optional(),
        approved: z.number().int().nonnegative().optional(),
        awaiting_review: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
    screening_stats: z.array(screeningStatSchema).optional(),
    links: z
      .object({ dashboard: z.record(z.string(), z.unknown()).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/** POST /quotes response. */
const quoteResponseSchema = z
  .object({
    quoteId: z.string().min(1),
    totalCost: z.number(),
    costPerParticipant: z.number().optional(),
    submissionCount: z.number().optional(),
    expiresAt: z.string().optional(),
  })
  .passthrough();

/* -------------------------------------------------------------------------- */
/* Study design                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The three questions the panel answers, in order.
 *
 * `key` is our stable identifier and also the dimension name in the normalized
 * results. `dimension` order matters only for tie-breaking (see WINNER_TIEBREAK).
 */
export const STUDY_QUESTIONS = Object.freeze([
  {
    key: 'trust',
    text: 'Which of these three text messages would you most trust, if it arrived from a company you had not heard of before?',
  },
  {
    key: 'clarity',
    text: 'Which of the three is clearest about what is actually being offered?',
  },
  {
    key: 'reply',
    text: 'Which of the three would you be most likely to reply to?',
  },
] as const);

/** Tie-break order applied after combined selections. Trust first, per the kickoff. */
export const WINNER_TIEBREAK: readonly string[] = Object.freeze(['trust', 'clarity', 'reply']);

/** The framing every respondent reads before the questions. */
export const STUDY_PREAMBLE =
  'Imagine you own a small commercial electrical contracting business in San Francisco with about 15 employees. ' +
  'You are busy, you are often on a job site, and you get a lot of unwanted messages. ' +
  'Read the three text messages below and answer the questions that follow.';

/** Label shown to respondents for a variant, and the key we map results back on. */
export function variantLabel(index: number): string {
  return `Message ${String.fromCharCode(65 + index)}`;
}

/* -------------------------------------------------------------------------- */
/* Result types                                                               */
/* -------------------------------------------------------------------------- */

/** Distinguishes "not configured" from "tried and failed". */
export type TeracResult<T> =
  | { ok: true; skipped: false; value: T }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; reason: string };

/** A created but NOT yet launched study. Nothing has been spent at this point. */
export interface DraftStudy {
  opportunityId: string;
  projectId: string;
  status: string;
  variants: TeracVariant[];
  /** Quoted total in cents, when the API reported pricing on the draft. */
  quotedTotalCents: number | null;
  dashboardUrl: string | null;
}

/** A price estimate. Obtaining one costs nothing. */
export interface StudyQuote {
  quoteId: string;
  totalCostCents: number;
  costPerParticipantCents: number | null;
  submissionCount: number | null;
  expiresAt: string | null;
}

/** Normalized per-variant panel numbers. Nulls mean unreported, never zero. */
export interface StudyVariantResult {
  variantId: string;
  label: string;
  /** First-choice selections per question key, e.g. { trust: 21, clarity: 18 }. */
  selections: Readonly<Record<string, number>>;
  /** Share of respondents per question key, 0..1, exactly as reported. */
  shares: Readonly<Record<string, number>>;
  /** Sum of selections across every question. The primary ordering key. */
  totalSelections: number;
}

/** Normalized study results. */
export interface StudyResults {
  studyRef: string;
  /** `pending` means the panel is still fielding. Not an error. */
  status: 'pending' | 'complete' | 'failed';
  rawStatus: string;
  /** Respondents counted. Null when the API did not report one. Never invented. */
  respondentCount: number | null;
  variants: StudyVariantResult[];
}

/** The winner plus the numbers that chose it, for the decision log. */
export interface StudyWinner {
  variantId: string;
  label: string;
  totalSelections: number;
  selections: Readonly<Record<string, number>>;
  /** Every variant, best first, so the dashboard can show the whole table. */
  ranking: StudyVariantResult[];
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

const DEFAULT_BASE_URL = 'https://terac.com/api/external/v2';

export function teracReady(): boolean {
  return hasCapability('terac');
}

function skipped<T>(): TeracResult<T> {
  return {
    ok: false,
    skipped: true,
    reason: `terac capability unconfigured (missing: ${missingKeys('terac').join(', ')})`,
  };
}

function baseUrl(): string {
  return envOr('TERAC_BASE_URL', DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function headers(): Record<string, string> {
  return {
    authorization: `Bearer ${requireEnv('TERAC_API_KEY')}`,
    'content-type': 'application/json',
    accept: 'application/json',
  };
}

/** Truncated body sample so a contract mismatch is debuggable in one run. */
function sample(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 400 ? `${flat.slice(0, 400)}...` : flat;
}

/* -------------------------------------------------------------------------- */
/* HTTP                                                                       */
/* -------------------------------------------------------------------------- */

interface RawResponse {
  json: unknown;
  text: string;
}

async function call(
  path: string,
  init: { method: string; body?: unknown },
): Promise<TeracResult<RawResponse>> {
  const url = `${baseUrl()}${path}`;
  const timeoutMs = envInt('TERAC_TIMEOUT_MS', 25_000);
  try {
    const response = await fetch(url, {
      method: init.method,
      headers: headers(),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });

    const text = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        skipped: false,
        reason: `terac ${init.method} ${path} returned ${response.status}: ${sample(text)}`,
      };
    }

    let json: unknown;
    try {
      json = JSON.parse(text) as unknown;
    } catch {
      return {
        ok: false,
        skipped: false,
        reason: `terac ${init.method} ${path} returned non-JSON body: ${sample(text)}`,
      };
    }
    return { ok: true, skipped: false, value: { json, text } };
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
    return { ok: false, skipped: false, reason: `terac ${init.method} ${path} failed: ${message}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Project                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the project the study lives under.
 *
 * Prefers `TERAC_PROJECT_ID` when set so repeated runs reuse one project instead
 * of littering the dashboard. Otherwise creates one.
 */
export async function ensureProject(name = 'LeadVelocity'): Promise<TeracResult<string>> {
  if (!teracReady()) return skipped<string>();

  const configured = envOr('TERAC_PROJECT_ID', '');
  if (configured.length > 0) return { ok: true, skipped: false, value: configured };

  const created = await call('/projects', { method: 'POST', body: { name } });
  if (!created.ok) return created;

  const parsed = projectResponseSchema.safeParse(created.value.json);
  if (!parsed.success) {
    return {
      ok: false,
      skipped: false,
      reason: `terac project response unexpected (${parsed.error.message}). Body: ${sample(created.value.text)}`,
    };
  }
  return { ok: true, skipped: false, value: parsed.data.id };
}

/* -------------------------------------------------------------------------- */
/* Quote (free)                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Ask what the study would cost. This does NOT spend anything, and it is what
 * the Sales Agent checks against its budget before it is allowed to launch.
 */
export async function quoteStudy(opts: {
  submissionCount: number;
  timelineHours?: number;
}): Promise<TeracResult<StudyQuote>> {
  if (!teracReady()) return skipped<StudyQuote>();

  const body = {
    taskDescription:
      'Read three short outreach text messages written for a commercial electrical contractor and answer three quick multiple choice questions about which is most trustworthy, clearest, and most likely to get a reply.',
    panelDescription:
      'General population adults in the United States. No professional screening required.',
    // Terac rejects anything under 72 (observed: 400 "Number must be
    // greater than or equal to 72" on POST /quotes). A GenPop panel is a
    // three-day minimum, which is a scheduling fact worth knowing early.
    timelineHours: opts.timelineHours ?? envInt('TERAC_TIMELINE_HOURS', 72),
    submissionCount: opts.submissionCount,
  };

  const res = await call('/quotes', { method: 'POST', body });
  if (!res.ok) return res;

  const parsed = quoteResponseSchema.safeParse(res.value.json);
  if (!parsed.success) {
    return {
      ok: false,
      skipped: false,
      reason: `terac quote response unexpected (${parsed.error.message}). Body: ${sample(res.value.text)}`,
    };
  }

  // The spec types totalCost as a number without documenting units. Treat values
  // that look like dollars as dollars and convert, rather than guessing silently.
  const raw = parsed.data.totalCost;
  const totalCents = Number.isInteger(raw) && raw > 1000 ? raw : Math.round(raw * 100);

  return {
    ok: true,
    skipped: false,
    value: {
      quoteId: parsed.data.quoteId,
      totalCostCents: totalCents,
      costPerParticipantCents:
        parsed.data.costPerParticipant === undefined
          ? null
          : Math.round(parsed.data.costPerParticipant * 100),
      submissionCount: parsed.data.submissionCount ?? null,
      expiresAt: parsed.data.expiresAt ?? null,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Draft (free)                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build the screening questions that carry the study.
 *
 * Every answer is `qualify_logic: 'may'`, which is the API's way of saying "this
 * answer neither qualifies nor rejects". That turns a screening question into a
 * plain opinion question, which is what we want: we are not filtering a panel,
 * we are asking it something.
 */
function buildScreeningQuestions(variants: readonly TeracVariant[]) {
  const messageBlock = variants
    .map((v, i) => `${variantLabel(i)}:\n"${v.text}"`)
    .join('\n\n');

  return STUDY_QUESTIONS.map((q) => ({
    key: q.key,
    text: q.text,
    question_rich_text: `${STUDY_PREAMBLE}\n\n${messageBlock}\n\n${q.text}`,
    pick: 'one' as const,
    answers: variants.map((_, i) => ({
      text: variantLabel(i),
      qualify_logic: 'may' as const,
    })),
  }));
}

/**
 * Create the study as a DRAFT. Costs nothing and commits to nothing.
 *
 * Split from `launchStudy` deliberately so the expensive, irreversible step is a
 * separate, explicitly authorized call.
 */
export async function createDraftStudy(opts: {
  variants: readonly TeracVariant[];
  numParticipants?: number;
  projectId?: string;
  title?: string;
}): Promise<TeracResult<DraftStudy>> {
  if (!teracReady()) return skipped<DraftStudy>();

  const variants = opts.variants.map((v) => ({ id: v.id, text: v.text }));
  if (variants.length < 2) {
    return { ok: false, skipped: false, reason: 'terac study needs at least 2 variants to compare' };
  }

  let projectId = opts.projectId;
  if (projectId === undefined) {
    const project = await ensureProject();
    if (!project.ok) return project;
    projectId = project.value;
  }

  const numParticipants = opts.numParticipants ?? envInt('TERAC_TARGET_RESPONDENTS', 50);

  const body = {
    title: opts.title ?? 'Which outreach message do contractors trust?',
    internal_title: 'LeadVelocity outreach copy test',
    description: STUDY_PREAMBLE,
    project_id: projectId,
    num_participants: numParticipants,
    business_type: envOr('TERAC_BUSINESS_TYPE', 'b2c'),
    // This is what makes the panel General Population rather than a filtered pool.
    unrestricted_audience: true,
    screening_questions: buildScreeningQuestions(variants),
    tasks: [
      {
        sequence: 1,
        task_type: 'activity' as const,
        review_type: 'auto_approve' as const,
        task_url: `${appBaseUrl().replace(/\/+$/, '')}/study/thanks`,
        title: 'Compare three short text messages',
        description:
          'Read three short text messages and answer three multiple choice questions. Takes about two minutes.',
        duration_minutes: 3,
      },
    ],
    expected_days_to_complete: 1,
  };

  const res = await call('/opportunities', { method: 'POST', body });
  if (!res.ok) return res;

  const parsed = opportunityResponseSchema.safeParse(res.value.json);
  if (!parsed.success) {
    return {
      ok: false,
      skipped: false,
      reason: `terac opportunity response unexpected (${parsed.error.message}). Body: ${sample(res.value.text)}`,
    };
  }

  const dash = parsed.data.links?.dashboard;
  const dashboardUrl =
    dash !== undefined && typeof dash['study'] === 'string' ? (dash['study'] as string) : null;

  return {
    ok: true,
    skipped: false,
    value: {
      opportunityId: parsed.data.id,
      projectId,
      status: parsed.data.status,
      variants,
      quotedTotalCents: parsed.data.pricing?.total_cost_cents ?? null,
      dashboardUrl,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Launch (SPENDS MONEY)                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Explicit authorization to spend money on a panel.
 *
 * The company is autonomous, but it operates inside a ceiling a human set. This
 * type exists so that spending can never happen as a side effect of a tick: a
 * caller has to construct one on purpose, and the launch re-checks the live
 * quoted cost against `maxSpendCents` before committing.
 */
export interface StudySpendAuthorization {
  /** Hard ceiling in cents. A study quoted above this is refused, not trimmed. */
  maxSpendCents: number;
  /** Free-text record of who or what authorized it, written to the decision log. */
  authorizedBy: string;
}

/**
 * Launch a drafted study. This is the paid, irreversible step.
 *
 * Refuses unless the drafted cost is known and within the authorized ceiling.
 * An unknown cost is treated as over budget, never as free.
 */
export async function launchStudy(
  opportunityId: string,
  authorization: StudySpendAuthorization,
): Promise<TeracResult<{ opportunityId: string; status: string; spentCents: number }>> {
  if (!teracReady()) return skipped();

  // Re-read the draft so the cost check uses the API's number, not a stale one.
  const current = await getStudy(opportunityId);
  if (!current.ok) return current;

  const cost = current.value.quotedTotalCents;
  if (cost === null) {
    return {
      ok: false,
      skipped: false,
      reason:
        'terac launch refused: the API did not report a cost for this study, and an unknown cost is treated as over budget rather than assumed free.',
    };
  }
  if (cost > authorization.maxSpendCents) {
    return {
      ok: false,
      skipped: false,
      reason: `terac launch refused: quoted ${cost} cents exceeds the authorized ceiling of ${authorization.maxSpendCents} cents.`,
    };
  }

  const res = await call(`/opportunities/${encodeURIComponent(opportunityId)}/launch`, {
    method: 'POST',
  });
  if (!res.ok) return res;

  const parsed = opportunityResponseSchema.safeParse(res.value.json);
  if (!parsed.success) {
    return {
      ok: false,
      skipped: false,
      reason: `terac launch response unexpected (${parsed.error.message}). Body: ${sample(res.value.text)}`,
    };
  }

  return {
    ok: true,
    skipped: false,
    value: { opportunityId: parsed.data.id, status: parsed.data.status, spentCents: cost },
  };
}

/** Pause a running study. Cheap safety valve; also what the kill switch can call. */
export async function pauseStudy(opportunityId: string): Promise<TeracResult<{ status: string }>> {
  if (!teracReady()) return skipped();
  const res = await call(`/opportunities/${encodeURIComponent(opportunityId)}/pause`, {
    method: 'POST',
  });
  if (!res.ok) return res;
  const parsed = opportunityResponseSchema.safeParse(res.value.json);
  return parsed.success
    ? { ok: true, skipped: false, value: { status: parsed.data.status } }
    : { ok: false, skipped: false, reason: `terac pause response unexpected: ${sample(res.value.text)}` };
}

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

/** Fetch the raw opportunity, including pricing and screening aggregates. */
async function getStudy(opportunityId: string): Promise<TeracResult<DraftStudy>> {
  const res = await call(`/opportunities/${encodeURIComponent(opportunityId)}`, { method: 'GET' });
  if (!res.ok) return res;

  const parsed = opportunityResponseSchema.safeParse(res.value.json);
  if (!parsed.success) {
    return {
      ok: false,
      skipped: false,
      reason: `terac opportunity response unexpected (${parsed.error.message}). Body: ${sample(res.value.text)}`,
    };
  }
  return {
    ok: true,
    skipped: false,
    value: {
      opportunityId: parsed.data.id,
      projectId: '',
      status: parsed.data.status,
      variants: [],
      quotedTotalCents: parsed.data.pricing?.total_cost_cents ?? null,
      dashboardUrl: null,
    },
  };
}

/**
 * Fetch and normalize panel results.
 *
 * Reads the per-answer aggregates Terac computes in `screening_stats` and maps
 * answer labels ("Message A") back onto our variant ids. A study that is still
 * fielding returns `status: 'pending'` with whatever partial numbers exist, which
 * is a normal answer and not a failure.
 */
export async function fetchStudyResults(
  opportunityId: string,
  variants: readonly TeracVariant[],
): Promise<TeracResult<StudyResults>> {
  if (!teracReady()) return skipped<StudyResults>();
  if (opportunityId.trim().length === 0) {
    return { ok: false, skipped: false, reason: 'terac study reference is empty' };
  }

  const res = await call(`/opportunities/${encodeURIComponent(opportunityId)}`, { method: 'GET' });
  if (!res.ok) return res;

  const parsed = opportunityResponseSchema.safeParse(res.value.json);
  if (!parsed.success) {
    return {
      ok: false,
      skipped: false,
      reason: `terac results response unexpected (${parsed.error.message}). Body: ${sample(res.value.text)}`,
    };
  }

  const labelToVariant = new Map<string, string>();
  variants.forEach((v, i) => labelToVariant.set(variantLabel(i), v.id));

  const selections = new Map<string, Record<string, number>>();
  const shares = new Map<string, Record<string, number>>();
  for (const v of variants) {
    selections.set(v.id, {});
    shares.set(v.id, {});
  }

  for (const stat of parsed.data.screening_stats ?? []) {
    const questionKey = STUDY_QUESTIONS.find(
      (q) => q.key === stat.screening_question || stat.screening_question.includes(q.key),
    )?.key;
    if (questionKey === undefined) continue;

    for (const answer of stat.answers) {
      const variantId = labelToVariant.get(answer.text.trim());
      if (variantId === undefined) continue;
      const sel = selections.get(variantId);
      const shr = shares.get(variantId);
      if (sel !== undefined) sel[questionKey] = answer.selected;
      if (shr !== undefined) shr[questionKey] = answer.share;
    }
  }

  const normalized: StudyVariantResult[] = variants.map((v, i) => {
    const sel = selections.get(v.id) ?? {};
    return {
      variantId: v.id,
      label: variantLabel(i),
      selections: Object.freeze({ ...sel }),
      shares: Object.freeze({ ...(shares.get(v.id) ?? {}) }),
      totalSelections: Object.values(sel).reduce((a, b) => a + b, 0),
    };
  });

  const respondentCount =
    parsed.data.submission_stats?.approved ?? parsed.data.submission_stats?.total ?? null;

  return {
    ok: true,
    skipped: false,
    value: {
      studyRef: opportunityId,
      status: normalizeStatus(parsed.data.status),
      rawStatus: parsed.data.status,
      respondentCount,
      variants: normalized,
    },
  };
}

/**
 * Collapse the API's opportunity status onto the three states we act on.
 *
 * `fulfilled` and `completed` both mean the panel is done. `active` and `paused`
 * mean keep polling. Note that a paused study is pending, not failed.
 */
function normalizeStatus(raw: string): StudyResults['status'] {
  const value = raw.trim().toLowerCase();
  if (['fulfilled', 'completed', 'complete'].includes(value)) return 'complete';
  if (['stopped', 'failed', 'cancelled', 'canceled'].includes(value)) return 'failed';
  return 'pending';
}

/* -------------------------------------------------------------------------- */
/* Winner selection (pure, deterministic, no model involved)                  */
/* -------------------------------------------------------------------------- */

/**
 * Pick the winning variant from panel results.
 *
 * Pure: no clock, no network, no random. Deliberately code and not a model call,
 * matching hard rule #2. Ordering is combined first-choice selections descending,
 * ties broken by trust then clarity then reply, and finally by variant id so the
 * result is stable for identical inputs.
 *
 * Returns null when no variant received a single selection, which is an honest
 * "the panel has not answered yet" rather than an arbitrary pick.
 */
export function selectStudyWinner(results: StudyResults): StudyWinner | null {
  const ranked = [...results.variants].sort((a, b) => {
    if (a.totalSelections !== b.totalSelections) return b.totalSelections - a.totalSelections;
    for (const dimension of WINNER_TIEBREAK) {
      const aScore = a.selections[dimension] ?? 0;
      const bScore = b.selections[dimension] ?? 0;
      if (aScore !== bScore) return bScore - aScore;
    }
    return a.variantId.localeCompare(b.variantId);
  });

  const best = ranked[0];
  if (best === undefined || best.totalSelections === 0) return null;

  return {
    variantId: best.variantId,
    label: best.label,
    totalSelections: best.totalSelections,
    selections: best.selections,
    ranking: ranked,
  };
}
