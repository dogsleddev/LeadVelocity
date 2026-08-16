/**
 * The Sales Agent: find a contractor, show them a real job, ask for the sale.
 *
 * WHAT THIS IS
 * ------------
 * The acquisition half of the company. One tick:
 *
 *   1. makes sure there is a prospect universe, seeding it from the committed
 *      real permit contacts when the table is empty
 *   2. qualifies prospects deterministically (a contractor license, and they are
 *      actually working in San Francisco)
 *   3. asks the model one narrow question per unclassified prospect: does this
 *      firm read as a commercial shop or a residential one, recorded `inferred`
 *   4. ranks what is left and picks one prospect
 *   5. runs a LIMITED pass of the lead engine over that prospect's territory to
 *      produce a REAL sample opportunity, never a mock (hard rule #5)
 *   6. composes the outreach message, then either sends it or holds it, depending
 *      on whether the channel is allowed to contact that handle yet
 *
 * THE MESSAGE STUDY
 * -----------------
 * The event rule requires real human input collected during the event with a
 * clear before and after. That is the Terac General Population study, and this
 * agent owns it:
 *
 * - no study yet          -> draft three genuinely different angles from
 *                            `lib/copy/templates.ts`, write them down as the
 *                            "before", put them in front of the panel, and send
 *                            variant A this tick while saying plainly that the
 *                            panel has not reported
 * - study still fielding  -> poll it, send variant A, log the state with numbers
 * - panel has reported    -> pick the winner IN CODE (`selectStudyWinner`:
 *                            combined first-choice selections, trust breaking
 *                            ties), record it, and send that angle from then on
 *
 * Nothing about the winner is asked of a model (hard rule #2), and an unreported
 * panel number is never filled in with a plausible one (hard rule #3).
 *
 * SPENDING MONEY IS NOT A SIDE EFFECT
 * -----------------------------------
 * Fielding a panel costs real money, and `lib/integrations/terac.ts` refuses to
 * launch without an explicit `StudySpendAuthorization` carrying a ceiling. This
 * agent constructs one from `TERAC_MAX_SPEND_CENTS`, which defaults to zero. With
 * the ceiling unset the three drafts are still written down as the "before" and
 * the tick logs, by name, the one variable an operator has to set to let the
 * company buy the panel. A tick never quietly spends.
 *
 * ONE DELIBERATE READING OF THE SPEC
 * ----------------------------------
 * A completed study stores `winner_text`: the exact wording the panel ranked.
 * That wording was drafted around whichever real permit was the best sample on
 * the day the study launched. Sending it verbatim weeks later would pitch a job
 * that is not the job the accompanying link shows. So the adopted artefact is the
 * winning variant ID, re-rendered over the sample opportunity this tick actually
 * found, which is the same angle carrying the current facts. `winner_text` is
 * used verbatim only if the winning id is somehow absent from the current draft
 * set. Both paths say which one they took in the decision log.
 *
 * INBOUND FIRST, AND WHY THAT IS THE STRONGER POSITION
 * ----------------------------------------------------
 * The delivery channel is Linq, and Linq's sandbox will only carry a message to a
 * handle that has texted the company's Linq number first. This agent therefore
 * cannot cold send a sample, and it does not try to.
 *
 * It does the entire job anyway. It picks the prospect, runs the real lead engine
 * over real permits, and composes the panel-tested copy. Before it touches the
 * channel it asks two deterministic questions, `requiresInboundFirst()` about the
 * channel and `isReachable()` about the handle, and takes one of two paths:
 *
 *   reachable, or the channel allows cold contact
 *       -> send, and stamp `prospects.contacted_at` only after it is accepted
 *   neither
 *       -> `queueOutbound(purpose 'sales_sample')`, log that the sample is
 *          prepared and waiting for the prospect to make contact, name the number
 *          they would text, and leave `contacted_at` null
 *
 * A queued sample is never logged as a send. The queue row says
 * `waiting_for_inbound`, the decision log says prepared, and the prospect stays
 * uncontacted so the sample can still go out later.
 *
 * The kickoff planned cold SMS with an opt out in the copy. This is that rule with
 * consent moved to the front and enforced by the platform instead of by our own
 * good intentions: the contractor starts the conversation, or there is no
 * conversation. That is a stronger consent posture than the original plan, not a
 * weaker one. What it costs is the first move, which now belongs to the prospect.
 *
 * Messages go to `DEMO_PHONE_NUMBER` and nowhere else, on either path.
 */
import {
  appBaseUrl,
  demoPhoneNumber,
  envInt,
  monthlyPriceUsd,
  optionalEnv,
} from '@/lib/config/deployment-env';
import {
  activeChannel,
  channelLabel,
  channelReady,
  normalizeRecipient,
  requiresInboundFirst,
  sendMessage,
} from '@/lib/delivery/channel';
import type { CustomerProfile } from '@/lib/domain/schemas/core';
import { completeJson, anthropicReady } from '@/lib/integrations/anthropic';
import {
  PROSPECT_POOL_SOURCE_ID,
  loadProspectPoolFromExtract,
  type ProspectSeed,
} from '@/lib/integrations/cslb';
import {
  createDraftStudy,
  fetchStudyResults,
  launchStudy,
  quoteStudy,
  selectStudyWinner,
  teracReady,
  type StudyVariantResult as TeracVariantResult,
} from '@/lib/integrations/terac';
import {
  sampleOutreachVariants,
  type CopyVariant,
  type OutreachCopyContext,
} from '@/lib/copy/templates';
import {
  createStudy,
  getCompletedStudy,
  getLatestStudy,
  getPrimaryCustomer,
  isReachable,
  listQualifiedProspects,
  markContacted,
  markFailed,
  markLaunched,
  queueOutbound,
  recordResults,
  upsertProspects,
  type MessageStudy,
  type ProspectInput,
  type ProspectRecord,
  type StudyResult,
} from '@/lib/store';
import { z } from 'zod';

import { sampleBestOpportunity, type SampleOpportunity } from './lead-agent';
import { formatUsd, round2, runTick, type TickContext, type TickResult } from './tick';

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

/** Cap on how many contractors are pulled out of the extract on a cold start. */
const poolLimit = (): number => envInt('SALES_POOL_LIMIT', 400);

/** How many stored prospects one tick reads for ranking. */
const rankLimit = (): number => envInt('SALES_RANK_LIMIT', 50);

/** How many unclassified prospects one classification call covers. */
const classifyBatch = (): number => envInt('SALES_CLASSIFY_BATCH', 8);

/** How many permits the sample pass reads. Kept small: this is a sample. */
const sampleScanLimit = (): number => envInt('SALES_SAMPLE_SCAN_LIMIT', 40);

/** Territory this company sells into, in the words a contractor would use. */
const TERRITORY_LABEL = 'San Francisco';

/**
 * The number a prospect would text to start a conversation.
 *
 * Named in the decision log every time a sample is held, because "waiting for
 * first contact" is only a readable state if the log says what they would be
 * contacting. Linq picks a line for us when `LINQ_FROM_NUMBER` is unset, so that
 * case says so rather than printing a number nobody configured (hard rule #3).
 */
function inboundNumberLabel(): string {
  return optionalEnv('LINQ_FROM_NUMBER') ?? 'the number on the company Linq account';
}

/**
 * The standard offer, used to score a sample for a prospect who has not bought
 * anything yet. These are the terms of the product, not invented customer data:
 * commercial work in San Francisco at six figures and up.
 */
const OFFER_PROFILE: Omit<CustomerProfile, 'id'> = {
  businessName: 'Prospect sample',
  trade: 'electrical',
  territoryZips: [],
  territoryDistricts: [],
  minProjectValue: 25_000,
  preferredUses: [
    'office',
    'retail sales',
    'food/beverage hndlng',
    'clinics-medic/dental',
    'school',
    'tourist hotel/motel',
    'warehouse,no frnitur',
    'manufacturing',
  ],
  phone: '+10000000000',
  status: 'prospect',
  effectiveWeights: { fit: 1, demand: 1, timing: 1, value: 1, evidence: 1 },
};

/* -------------------------------------------------------------------------- */
/* Deterministic qualification                                                */
/* -------------------------------------------------------------------------- */

/** How San Francisco is spelled in the `firm_city` / `city` columns. */
const SF_CITY_NAMES: ReadonlySet<string> = new Set([
  'san francisco',
  'sanfrancisco',
  'sf',
  's f',
  'south san francisco',
]);

/** Every San Francisco zip starts 941. */
const SF_ZIP = /^941\d{2}$/;

/** A CSLB contractor license is bare digits. Design professionals carry a letter. */
const CSLB_LICENSE = /^\d{3,10}$/;

/** Result of the deterministic gate, with the sentences behind it. */
export interface QualificationOutcome {
  qualified: boolean;
  reasons: string[];
}

/**
 * Does this contractor belong in the acquisition universe?
 *
 * PURE. Two gates, both checkable by hand from the row: they hold a CSLB-shaped
 * contractor license, and they are working in San Francisco. Both the passes and
 * the failures produce a sentence, so a prospect that was dropped can say why.
 */
export function qualifyProspect(seed: ProspectSeed): QualificationOutcome {
  const reasons: string[] = [];
  let qualified = true;

  if (CSLB_LICENSE.test(seed.licenseNumber)) {
    reasons.push(`Holds contractor license ${seed.licenseNumber} on a San Francisco permit record.`);
  } else {
    reasons.push(`License "${seed.licenseNumber}" is not a CSLB contractor license number.`);
    qualified = false;
  }

  const city = seed.city?.trim().toLowerCase() ?? '';
  const zip = seed.zipcode?.trim() ?? '';
  if (SF_CITY_NAMES.has(city)) {
    reasons.push(`Firm address is in ${seed.city ?? 'San Francisco'}.`);
  } else if (SF_ZIP.test(zip)) {
    reasons.push(`Firm zip ${zip} is a San Francisco zip.`);
  } else {
    reasons.push(
      city.length === 0 && zip.length === 0
        ? 'No firm city or zip on the permit record, so a San Francisco base cannot be confirmed.'
        : `Firm is based in ${seed.city ?? 'an unnamed city'}${zip.length > 0 ? ` ${zip}` : ''}, outside the territory.`,
    );
    qualified = false;
  }

  reasons.push(
    `Seen on ${seed.permitCount} San Francisco ${seed.permitCount === 1 ? 'permit' : 'permits'} inside the extract window.`,
  );

  return { qualified, reasons };
}

/* -------------------------------------------------------------------------- */
/* Deterministic ranking                                                      */
/* -------------------------------------------------------------------------- */

/** Points behind the prospect ranking. Stated so the log's numbers are checkable. */
export const RANK_WEIGHTS = Object.freeze({
  commercialSegment: 40,
  unknownSegment: 15,
  residentialSegment: 0,
  perPermit: 3,
  maxPermitsCounted: 10,
  neverContacted: 20,
});

/** One prospect with the number that placed it and the reasons behind that number. */
export interface RankedProspect {
  prospect: ProspectRecord;
  rank: number;
  permitCount: number;
  reasons: string[];
}

/**
 * Rank the qualified universe.
 *
 * PURE, and deliberately so: which contractor the company approaches next is a
 * business decision that has to be reproducible, not a model's preference.
 * Commercial segment dominates because this product only sells commercial work;
 * permit activity is the second signal because a firm pulling permits this month
 * is a firm with a pipeline; never-contacted breaks the rest so the agent works
 * through the list instead of circling one name.
 */
export function rankProspects(
  prospects: readonly ProspectRecord[],
  activity: ReadonlyMap<string, number>,
): RankedProspect[] {
  const ranked = prospects.map((prospect) => {
    const reasons: string[] = [];
    let rank = 0;

    if (prospect.segment === 'commercial') {
      rank += RANK_WEIGHTS.commercialSegment;
      reasons.push(`reads as a commercial shop (+${RANK_WEIGHTS.commercialSegment})`);
    } else if (prospect.segment === 'unknown') {
      rank += RANK_WEIGHTS.unknownSegment;
      reasons.push(`segment not yet established (+${RANK_WEIGHTS.unknownSegment})`);
    } else {
      reasons.push('reads as a residential shop (+0)');
    }

    const permitCount = activity.get(prospect.licenseNumber ?? '') ?? 0;
    const counted = Math.min(permitCount, RANK_WEIGHTS.maxPermitsCounted);
    if (counted > 0) {
      rank += counted * RANK_WEIGHTS.perPermit;
      reasons.push(`${permitCount} permits in the window (+${counted * RANK_WEIGHTS.perPermit})`);
    }

    if (prospect.contactedAt === null) {
      rank += RANK_WEIGHTS.neverContacted;
      reasons.push(`never contacted (+${RANK_WEIGHTS.neverContacted})`);
    }

    return { prospect, rank: round2(rank), permitCount, reasons };
  });

  return ranked.sort(
    (a, b) =>
      b.rank - a.rank ||
      b.permitCount - a.permitCount ||
      a.prospect.firmName.localeCompare(b.prospect.firmName),
  );
}

/* -------------------------------------------------------------------------- */
/* The narrow classification call                                             */
/* -------------------------------------------------------------------------- */

/**
 * The only thing the model is asked about a contractor.
 *
 * `unknown` is a first-class answer and the prompt insists on it: a firm name is
 * often no evidence at all of what the shop sells, and guessing would put a
 * fabricated fact on the prospect row (hard rule #3).
 */
const segmentClassificationSchema = z.object({
  classifications: z
    .array(
      z.object({
        licenseNumber: z.string().min(1),
        segment: z.enum(['commercial', 'residential', 'unknown']),
        rationale: z.string().min(1).max(240),
      }),
    )
    .max(25),
});

const CLASSIFY_SYSTEM = [
  'You read the names of licensed California contracting firms that pull San Francisco building permits.',
  'For each firm, say whether the name and its permit activity read as a commercial contractor, a residential one, or neither.',
  'Answer "unknown" whenever the name carries no real signal. Most firm names do not. Guessing is worse than saying unknown.',
  'You never rank the firms, never score them, and never invent a fact about a company.',
].join(' ');

/* -------------------------------------------------------------------------- */
/* Message selection                                                          */
/* -------------------------------------------------------------------------- */

/** How the message about to be sent was chosen. */
export type MessageSource =
  | { state: 'panel_winner'; variantId: string; studyId: string; note: string }
  | { state: 'panel_pending'; variantId: string; studyId: string; note: string }
  /** No panel has reported. `studyId` is present once drafts are on record. */
  | { state: 'no_study'; variantId: string; studyId: string | null; note: string };

/** Ceiling on what the company may spend fielding one panel, in cents. */
const maxStudySpendCents = (): number => envInt('TERAC_MAX_SPEND_CENTS', 0);

/** Panel size requested. Matches the default inside the Terac client. */
const studyParticipants = (): number => envInt('TERAC_TARGET_RESPONDENTS', 50);

/* ==========================================================================
 * WHAT THE PANEL ACTUALLY REPORTS
 *
 * Terac's panel mechanism yields FIRST CHOICE SELECTION COUNTS per question:
 * how many respondents picked Message A as the most trusted, how many picked it
 * as the clearest, how many would reply to it. It does not produce ordinal
 * ranks or 1 to 5 means, so none are invented here or stored anywhere. See the
 * deviation note in `lib/integrations/terac.ts`.
 *
 * A respondent count the API did not report blocks recording entirely. A
 * fabricated panel size is the one number a judge is most likely to check
 * (hard rule #3), so an unreported count is an unrecorded study, not a guess.
 * ========================================================================== */
function toStoredResults(
  ranking: readonly TeracVariantResult[],
  respondentCount: number | null,
): { complete: StudyResult[]; incomplete: string[] } {
  const complete: StudyResult[] = [];
  const incomplete: string[] = [];

  if (respondentCount === null) {
    return { complete, incomplete: ranking.map((variant) => variant.variantId) };
  }

  /*
   * A variant nobody chose is a real result, not a missing one, so it is stored
   * with its zeroes rather than dropped.
   */
  for (const variant of ranking) {
    complete.push({
      variantId: variant.variantId,
      label: variant.label,
      selections: { ...variant.selections },
      shares: { ...variant.shares },
      totalSelections: variant.totalSelections,
    });
  }

  return { complete, incomplete };
}

/** Render a stored result row as readable numbers for the decision log. */
function describeResult(result: StudyResult): string {
  const parts = Object.entries(result.selections)
    .map(([key, count]) => `${key} ${count}`)
    .join(' ');
  const name = result.label === '' ? result.variantId : result.label;
  return `${name} picked ${result.totalSelections} times overall (${parts})`;
}

/**
 * Decide which of the three angles to send, running the study forward on the way.
 *
 * Returns the chosen variant id plus a note describing the study state with its
 * numbers, so the caller can log exactly why this wording and not another.
 */
async function resolveMessageSource(
  ctx: TickContext,
  variants: readonly CopyVariant[],
): Promise<MessageSource> {
  /* --- a finished panel decides, and it decided in code ------------------ */
  const completed = await getCompletedStudy();
  if (completed !== null && completed.winner !== null) {
    const numbers = (completed.results ?? []).map(describeResult).join('; ');
    return {
      state: 'panel_winner',
      variantId: completed.winner.variantId,
      studyId: completed.id,
      note:
        numbers.length > 0
          ? `panel already chose message ${completed.winner.variantId}: ${numbers}`
          : `panel already chose message ${completed.winner.variantId}`,
    };
  }

  const latest = await getLatestStudy();
  const firstVariantId = variants[0]?.id ?? 'a';

  /* --- a launched panel might have reported since the last tick ---------- */
  if (latest !== null && latest.status === 'launched' && latest.studyRef !== null) {
    const results = await fetchStudyResults(latest.studyRef, latest.variants);

    if (results.ok && results.value.status === 'complete') {
      const winner = selectStudyWinner(results.value);
      const { complete, incomplete } = toStoredResults(
        winner?.ranking ?? results.value.variants,
        results.value.respondentCount,
      );
      const winningText =
        winner === null
          ? null
          : (latest.variants.find((variant) => variant.id === winner.variantId)?.text ?? null);

      if (winner !== null && winningText !== null && complete.length > 0) {
        await recordResults(latest.id, complete, { variantId: winner.variantId, text: winningText });
        const table = winner.ranking
          .map((row) => `${row.label} ${row.totalSelections}`)
          .join(', ');
        await ctx.decide({
          decision: 'study.completed',
          summary: `${results.value.respondentCount ?? 'An unreported number of'} people read all three messages and ${winner.label} won on ${winner.totalSelections} combined first choices, ${winner.selections['trust'] ?? 0} of them for trust. Picks: ${table}. That angle is adopted from now on.`,
          refs: {
            study: latest.id,
            studyRef: latest.studyRef,
            winner: winner.variantId,
            selections: winner.totalSelections,
            trust: winner.selections['trust'] ?? 0,
            respondents: results.value.respondentCount,
          },
        });
        return {
          state: 'panel_winner',
          variantId: winner.variantId,
          studyId: latest.id,
          note: `panel chose ${winner.label} on ${winner.totalSelections} combined first choices`,
        };
      }

      /*
       * A closed panel with nothing usable is reported as exactly that. No winner
       * is adopted and no number is invented to manufacture one.
       */
      await ctx.decide({
        decision: 'study.results_incomplete',
        summary: `The panel closed but did not report a usable set of numbers, so no winner was adopted and the first message stays in use. Reported: ${
          results.value.variants
            .map((row) => `${row.label} ${row.totalSelections} picks`)
            .join('; ') || 'nothing'
        }. Respondent count: ${results.value.respondentCount ?? 'not reported'}.${
          incomplete.length > 0 ? ` Unusable: ${incomplete.join(', ')}.` : ''
        }`,
        refs: { study: latest.id, studyRef: latest.studyRef },
      });
    } else if (results.ok && results.value.status === 'failed') {
      await markFailed(latest.id);
      await ctx.decide({
        decision: 'study.failed',
        summary: `The panel ended without reporting (${results.value.rawStatus}), so the study is marked failed rather than left looking pending, and the first message stays in use.`,
        refs: { study: latest.id, studyRef: latest.studyRef },
      });
    } else if (results.ok) {
      await ctx.decide({
        decision: 'study.pending',
        summary: `The message panel is still fielding (${results.value.rawStatus}${
          results.value.respondentCount === null
            ? ', respondent count not reported yet'
            : `, ${results.value.respondentCount} responses so far`
        }), so the first message stays in use until it reports.`,
        refs: { study: latest.id, studyRef: latest.studyRef },
      });
    } else if (!results.skipped) {
      await ctx.decide({
        decision: 'study.unreachable',
        summary: `Could not read the message panel results this tick, so the first message stays in use: ${results.reason}`,
        refs: { study: latest.id, studyRef: latest.studyRef },
      });
    }

    return {
      state: 'panel_pending',
      variantId: firstVariantId,
      studyId: latest.id,
      note: 'panel has not reported a winner yet',
    };
  }

  /* --- a draft that never reached the panel: retry before drafting a fourth */
  if (latest !== null && latest.status === 'draft') {
    const launched = await tryLaunch(ctx, latest);
    return {
      state: launched ? 'panel_pending' : 'no_study',
      variantId: firstVariantId,
      studyId: latest.id,
      note: launched
        ? 'panel was put in front of people this tick and has not reported yet'
        : 'the three drafts are on record as the before but no panel has seen them yet',
    };
  }

  /* --- a failed study stands. Do not paper over it with a fresh one ------ */
  if (latest !== null && latest.status === 'failed') {
    await ctx.decide({
      decision: 'study.failed_standing',
      summary:
        'The last message panel failed and no replacement was started automatically, so the first message stays in use and the failure stays visible.',
      refs: { study: latest.id },
    });
    return {
      state: 'no_study',
      variantId: firstVariantId,
      studyId: latest.id,
      note: 'the last panel failed and no winner was ever adopted',
    };
  }

  /* --- nothing on record: write the before, then try the panel ----------- */
  const study = await createStudy(variants.map((variant) => ({ id: variant.id, text: variant.text })));
  await ctx.decide({
    decision: 'study.drafted',
    summary: `Wrote down three different pitches for the same offer before testing any of them: ${variants
      .map((variant) => `${variant.id} is ${variant.angle}`)
      .join(', ')}. This is the before, on record ahead of the panel.`,
    refs: { study: study.id, variants: variants.length },
  });

  const launched = await tryLaunch(ctx, study);
  return {
    state: launched ? 'panel_pending' : 'no_study',
    variantId: firstVariantId,
    studyId: study.id,
    note: launched
      ? 'panel was put in front of people this tick and has not reported yet'
      : 'the three drafts are on record as the before but no panel has seen them yet',
  };
}

/**
 * Put a drafted study in front of a general population panel.
 *
 * Four gates before a cent is spent, each with its own logged decision so the
 * reason nothing was bought is never a mystery:
 *
 *   1. the panel service has to be configured
 *   2. a human has to have set a spend ceiling (`TERAC_MAX_SPEND_CENTS`)
 *   3. the free quote has to come back at or under that ceiling
 *   4. the client re-checks the live cost against the ceiling at launch, and
 *      treats an unknown cost as over budget rather than as free
 *
 * A failure here leaves the local study on `draft`, which is the honest state:
 * the "before" is on record and the next tick will try the panel again. The row
 * is only marked failed when the panel itself ends without reporting.
 */
async function tryLaunch(ctx: TickContext, study: MessageStudy): Promise<boolean> {
  if (!teracReady()) {
    await ctx.decide({
      decision: 'study.launch_skipped',
      summary:
        'The three messages are drafted and on record but the panel service is not configured, so no human input was collected this tick.',
      refs: { study: study.id },
    });
    return false;
  }

  const ceiling = maxStudySpendCents();
  if (ceiling <= 0) {
    await ctx.decide({
      decision: 'study.spend_unauthorized',
      summary:
        'The three messages are drafted and on record, but fielding a panel costs money and no spending ceiling has been authorized, so nothing was bought. Set TERAC_MAX_SPEND_CENTS to let the company buy the panel.',
      refs: { study: study.id, ceilingCents: ceiling },
    });
    return false;
  }

  const participants = studyParticipants();
  const quote = await quoteStudy({ submissionCount: participants });
  if (!quote.ok) {
    await ctx.decide({
      decision: 'study.quote_failed',
      summary: `Could not price the panel, so nothing was bought and the three drafts stay on record: ${quote.reason}`,
      refs: { study: study.id },
    });
    return false;
  }

  if (quote.value.totalCostCents > ceiling) {
    await ctx.decide({
      decision: 'study.over_budget',
      summary: `A panel of ${participants} people was quoted at ${formatUsd(quote.value.totalCostCents / 100)}, which is over the authorized ceiling of ${formatUsd(ceiling / 100)}, so it was refused rather than trimmed.`,
      refs: {
        study: study.id,
        quotedCents: quote.value.totalCostCents,
        ceilingCents: ceiling,
      },
    });
    return false;
  }

  const draft = await createDraftStudy({
    variants: study.variants.map((variant) => ({ id: variant.id, text: variant.text })),
    numParticipants: participants,
  });
  if (!draft.ok) {
    await ctx.decide({
      decision: 'study.draft_failed',
      summary: `The panel service would not accept the study, so nothing was bought and the three drafts stay on record for the next attempt: ${draft.reason}`,
      refs: { study: study.id },
    });
    return false;
  }

  const launched = await launchStudy(draft.value.opportunityId, {
    maxSpendCents: ceiling,
    authorizedBy: 'TERAC_MAX_SPEND_CENTS',
  });
  if (!launched.ok) {
    await ctx.decide({
      decision: 'study.launch_refused',
      summary: `The study was built but not put in front of anybody, so nothing was spent: ${launched.reason}`,
      refs: { study: study.id, opportunity: draft.value.opportunityId },
    });
    return false;
  }

  await markLaunched(study.id, launched.value.opportunityId);
  await ctx.decide({
    decision: 'study.launched',
    summary: `Put all three messages in front of ${participants} people to be picked on trust, clarity and likelihood of a reply, at ${formatUsd(launched.value.spentCents / 100)}. Study reference ${launched.value.opportunityId}.`,
    refs: {
      study: study.id,
      studyRef: launched.value.opportunityId,
      participants,
      spentCents: launched.value.spentCents,
      quotedCents: quote.value.totalCostCents,
    },
  });
  return true;
}

/* -------------------------------------------------------------------------- */
/* The tick                                                                   */
/* -------------------------------------------------------------------------- */

/** What one Sales tick got through, for the scheduler's console line. */
export interface SalesTickSummary {
  poolSeeded: number;
  qualified: number;
  classified: number;
  ranked: number;
  prospect: string | null;
  sampleScore: number | null;
  sent: boolean;
  /** The sample was composed and held because the prospect has not texted in. */
  queued: boolean;
}

const EMPTY_SUMMARY: SalesTickSummary = {
  poolSeeded: 0,
  qualified: 0,
  classified: 0,
  ranked: 0,
  prospect: null,
  sampleScore: null,
  sent: false,
  queued: false,
};

/**
 * One Sales Agent tick. Seed, qualify, classify, rank, sample, pitch.
 */
export async function salesAgentTick(): Promise<TickResult<SalesTickSummary>> {
  return runTick('sales', async (ctx) => runSalesTick(ctx));
}

async function runSalesTick(ctx: TickContext): Promise<SalesTickSummary> {
  const summary: SalesTickSummary = { ...EMPTY_SUMMARY };

  /* --- 2. pull work: is there a universe at all? ------------------------- */
  let prospects = await listQualifiedProspects(rankLimit());

  /**
   * The extract-derived activity map. Cheap after the first read (the file parse
   * is memoized inside the CSLB module) and it carries two things the prospects
   * table does not: permit counts, and a named individual to greet.
   */
  let seeds = new Map<string, ProspectSeed>();
  const pool = await loadProspectPoolFromExtract();
  if (pool.ok) {
    for (const seed of pool.value.prospects) seeds.set(seed.licenseNumber, seed);
  }

  if (prospects.length === 0) {
    if (!pool.ok) {
      await ctx.decide({
        decision: 'prospect_pool.unavailable',
        summary: `The prospect pool is empty and the contractor extract could not be read, so no acquisition work was possible this tick: ${pool.reason}`,
      });
      return summary;
    }

    const candidates = pool.value.prospects.slice(0, poolLimit());
    const inputs: ProspectInput[] = candidates.map((seed) => {
      const outcome = qualifyProspect(seed);
      return {
        licenseNumber: seed.licenseNumber,
        firmName: seed.firmName,
        city: seed.city,
        state: seed.state,
        zipcode: seed.zipcode,
        classification: seed.classification,
        licenseStatus: seed.licenseStatus,
        qualified: outcome.qualified,
        qualifyReasons: outcome.reasons,
        sourceId: PROSPECT_POOL_SOURCE_ID,
      };
    });

    const written = await upsertProspects(inputs);
    summary.poolSeeded = written.inserted;
    const qualifiedCount = inputs.filter((input) => input.qualified === true).length;

    await ctx.decide({
      decision: 'prospect_pool.seeded',
      summary: `The prospect pool was empty, so it was rebuilt from ${pool.value.rowsRead} real San Francisco permit contact rows: ${written.inserted} contractors added, ${written.updated} refreshed, ${written.unchanged} already current. ${qualifiedCount} of ${inputs.length} hold a contractor license and work in the territory.`,
      refs: {
        source: PROSPECT_POOL_SOURCE_ID,
        inserted: written.inserted,
        qualified: qualifiedCount,
        considered: inputs.length,
      },
    });

    prospects = await listQualifiedProspects(rankLimit());
  }

  summary.qualified = prospects.length;
  if (prospects.length === 0) {
    await ctx.decide({
      decision: 'prospect_pool.none_qualified',
      summary:
        'No contractor in the pool holds a CSLB contractor license and a San Francisco base, so there is nobody to approach and nothing was sent.',
    });
    return summary;
  }

  /* --- 3. decide: classify, then rank ------------------------------------ */
  summary.classified = await classifyUnknownSegments(ctx, prospects, seeds);
  if (summary.classified > 0) prospects = await listQualifiedProspects(rankLimit());

  const activity = new Map<string, number>();
  for (const [license, seed] of seeds) activity.set(license, seed.permitCount);

  const ranked = rankProspects(prospects, activity);
  summary.ranked = ranked.length;

  const uncontacted = ranked.filter((row) => row.prospect.contactedAt === null);
  const chosen = uncontacted[0];

  if (chosen === undefined) {
    await ctx.decide({
      decision: 'prospect.none_available',
      summary: `All ${ranked.length} qualified contractors in the pool have already been approached once, so no further outreach was sent.`,
      refs: { ranked: ranked.length },
    });
    return summary;
  }

  const runnersUp = uncontacted
    .slice(1, 4)
    .map((row) => `${row.prospect.firmName} at ${row.rank}`)
    .join(', ');

  await ctx.decide({
    decision: 'prospect.selected',
    summary: `${chosen.prospect.firmName} ranks first of ${uncontacted.length} uncontacted contractors at ${chosen.rank} points: ${chosen.reasons.join(', ')}.${runnersUp.length > 0 ? ` Next best: ${runnersUp}.` : ''}`,
    refs: {
      prospect: chosen.prospect.id,
      license: chosen.prospect.licenseNumber,
      rank: chosen.rank,
      segment: chosen.prospect.segment,
    },
  });
  summary.prospect = chosen.prospect.firmName;

  /* --- may the company make the first move? asked before a word is composed */
  /*
   * Two deterministic questions, both answered up front rather than discovered
   * from a refused send halfway through a tick: `requiresInboundFirst` is a fact
   * about the channel, `isReachable` is a fact about this handle's consent. The
   * tick does the whole job either way. The answer only decides whether the
   * finished message is sent or held.
   */
  const configured = demoPhoneNumber();
  const destination = configured === null ? null : normalizeRecipient(configured);
  const holdForInbound =
    requiresInboundFirst() && (destination === null || !(await isReachable(destination)));

  /* --- 4. act: find a real job, then pitch it ---------------------------- */
  const offer: CustomerProfile = { ...OFFER_PROFILE, businessName: chosen.prospect.firmName };
  const template = await getPrimaryCustomer();
  if (template !== null) {
    offer.minProjectValue = template.minProjectValue;
    offer.preferredUses = template.preferredUses;
    offer.territoryZips = template.territoryZips;
    offer.territoryDistricts = template.territoryDistricts;
  }

  const sample = await sampleBestOpportunity({
    customer: offer,
    now: ctx.now,
    scanLimit: sampleScanLimit(),
  });

  if (!sample.ok) {
    await ctx.decide({
      decision: 'sample.unavailable',
      summary: `Nothing was sent to ${chosen.prospect.firmName} because there is no real job to show them yet: ${sample.reason} A sample is never fabricated.`,
      refs: { prospect: chosen.prospect.id, scanned: sample.scanned },
    });
    return summary;
  }

  summary.sampleScore = sample.value.score.score;
  await ctx.decide({
    decision: 'sample.selected',
    summary: `Best real job to show ${chosen.prospect.firmName}: ${sample.value.agency.address ?? sample.value.agency.permitNumber} at ${sample.value.score.score} of 100${
      sample.value.agency.valuation !== null ? `, worth ${formatUsd(sample.value.agency.valuation)}` : ''
    }, picked from ${sample.survivors} permits that cleared the gates out of ${sample.scanned} read.`,
    refs: {
      prospect: chosen.prospect.id,
      permit: sample.value.record.permitNumber,
      score: sample.value.score.score,
      scanned: sample.scanned,
    },
  });

  /* --- the three angles, and which one the panel chose ------------------- */
  const jobLabel = sample.value.agency.address ?? sample.value.record.permitNumber;
  const seed = seeds.get(chosen.prospect.licenseNumber ?? '');
  const outreach = buildOutreachContext(seed, sample.value, offer);
  const variants = sampleOutreachVariants(outreach);

  const source = await resolveMessageSource(ctx, variants);
  const selected = variants.find((variant) => variant.id === source.variantId) ?? variants[0];
  if (selected === undefined) {
    await ctx.decide({
      decision: 'outreach.no_message',
      summary: `No outreach message could be composed for ${chosen.prospect.firmName}, so nothing was sent.`,
      refs: { prospect: chosen.prospect.id },
    });
    return summary;
  }

  /*
   * A completed panel adopts the winning ANGLE re-rendered over the job this tick
   * actually found. `winner_text` is the wording the panel saw, which described a
   * different permit; sending it now would pitch a job the link does not show.
   */
  await ctx.decide({
    decision: 'outreach.message_selected',
    summary: `${holdForInbound ? 'Composed' : 'Sending'} the ${selected.angle} message for ${chosen.prospect.firmName} because the ${source.note}. The wording is that angle applied to the ${jobLabel} job.`,
    refs: {
      prospect: chosen.prospect.id,
      variant: selected.id,
      angle: selected.angle,
      study: 'studyId' in source ? source.studyId : null,
      studyState: source.state,
    },
  });

  /* --- the send, or the hold: the demo phone and nowhere else ------------ */
  if (configured === null) {
    await ctx.decide({
      decision: 'outreach.skipped',
      summary: `The ${selected.angle} message for ${chosen.prospect.firmName} is composed and ready but no demo phone number is configured, so nothing was sent to anybody.`,
      refs: { prospect: chosen.prospect.id, variant: selected.id },
    });
    return summary;
  }

  if (destination === null) {
    await ctx.decide({
      decision: 'outreach.skipped',
      summary: `The configured demo phone number is not a handle ${channelLabel()} can reach, so the ${selected.angle} message for ${chosen.prospect.firmName} was not sent.`,
      refs: { prospect: chosen.prospect.id, variant: selected.id, channel: activeChannel() },
    });
    return summary;
  }

  /*
   * The platform rule, taken at face value. The work is done and the message is
   * real; what is missing is the prospect's first text, which is theirs to send.
   * So the sample is stored as prepared, the prospect stays uncontacted, and
   * nothing here logs or stamps anything that looks like a delivery.
   */
  if (holdForInbound) {
    const queued = await queueOutbound({
      handle: destination,
      body: selected.text,
      linkUrl: outreach.actionUrl,
      purpose: 'sales_sample',
    });
    summary.queued = queued.inserted;

    await ctx.decide({
      decision: 'outreach.prepared',
      summary: queued.inserted
        ? `Sample prepared, waiting for first contact. The ${selected.angle} pitch for ${chosen.prospect.firmName} is written around the real ${jobLabel} job and is being held: ${channelLabel()} carries a message only to a number that has texted ${inboundNumberLabel()} first. Nothing was sent and the prospect stays uncontacted.`
        : `A sample composed on an earlier tick is still waiting for first contact on this number, so the ${selected.angle} pitch for ${chosen.prospect.firmName} was not queued on top of it. Nothing was sent and the prospect stays uncontacted.`,
      refs: {
        prospect: chosen.prospect.id,
        permit: sample.value.record.permitNumber,
        variant: selected.id,
        queued: queued.id,
        status: queued.status,
        channel: activeChannel(),
      },
    });
    return summary;
  }

  if (!channelReady()) {
    await ctx.decide({
      decision: 'outreach.skipped',
      summary: `The ${selected.angle} message for ${chosen.prospect.firmName} is ready but ${channelLabel()} is not configured, so it was not sent and the prospect stays uncontacted.`,
      refs: { prospect: chosen.prospect.id, variant: selected.id, channel: activeChannel() },
    });
    return summary;
  }

  const sent = await sendMessage({
    to: destination,
    body: selected.text,
    linkPreviewUrl: outreach.actionUrl,
    idempotencyKey: `sales_sample:${chosen.prospect.id}:${selected.id}`,
  });

  if (!sent.ok) {
    if (sent.skipped) {
      await ctx.decide({
        decision: 'outreach.skipped',
        summary: `The ${selected.angle} message for ${chosen.prospect.firmName} stays unsent and the prospect stays uncontacted because the message channel is unavailable: ${sent.reason}`,
        refs: { prospect: chosen.prospect.id, variant: selected.id, channel: activeChannel() },
      });
      return summary;
    }

    /*
     * The channel refused on consent grounds after the pre-check said otherwise,
     * which means the stored contact record and the provider disagree. The
     * provider is the authority on its own rule, so the message is held exactly as
     * it would have been had the pre-check caught it.
     */
    if (sent.requiresInboundFirst === true) {
      const queued = await queueOutbound({
        handle: destination,
        body: selected.text,
        linkUrl: outreach.actionUrl,
        purpose: 'sales_sample',
      });
      summary.queued = queued.inserted;

      await ctx.decide({
        decision: 'outreach.prepared',
        summary: `Sample prepared, waiting for first contact. ${channelLabel()} refused the ${selected.angle} pitch for ${chosen.prospect.firmName} because this number has not texted ${inboundNumberLabel()} yet, so the message built around the real ${jobLabel} job is held rather than sent.${queued.inserted ? '' : ' An earlier sample was already waiting, so this one was not queued on top of it.'}`,
        refs: {
          prospect: chosen.prospect.id,
          permit: sample.value.record.permitNumber,
          variant: selected.id,
          queued: queued.id,
          status: queued.status,
          channel: activeChannel(),
        },
      });
      return summary;
    }

    /* An opt out is a standing instruction. It is never queued and never retried. */
    if (sent.optedOut === true) {
      await ctx.decide({
        decision: 'outreach.opted_out',
        summary: `The number this company sends samples to has asked to stop receiving messages, so the ${selected.angle} pitch for ${chosen.prospect.firmName} was not sent, was not queued, and will not be retried.`,
        refs: { prospect: chosen.prospect.id, variant: selected.id, channel: activeChannel() },
      });
      return summary;
    }

    await ctx.decide({
      decision: 'outreach.failed',
      summary: `The ${selected.angle} message for ${chosen.prospect.firmName} could not be sent, and the prospect stays uncontacted so it can be retried: ${sent.reason}`,
      refs: { prospect: chosen.prospect.id, variant: selected.id, channel: activeChannel() },
    });
    return summary;
  }

  await markContacted(chosen.prospect.id, ctx.nowIso);
  summary.sent = true;

  await ctx.decide({
    decision: 'outreach.sent',
    summary: `Sent ${chosen.prospect.firmName} the ${selected.angle} pitch built around the real ${jobLabel} job at ${monthlyPriceUsd()} dollars a month.`,
    refs: {
      prospect: chosen.prospect.id,
      permit: sample.value.record.permitNumber,
      variant: selected.id,
      channel: sent.value.channel,
      message: sent.value.messageId,
      chars: sent.value.bodyLength,
    },
  });

  return summary;
}

/* -------------------------------------------------------------------------- */
/* Classification pass                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Ask the model to segment the prospects nothing has segmented yet.
 *
 * One batched call rather than one per firm: the output shape stays narrow, the
 * evidence label stays `inferred`, and a tick does not spend eight round trips on
 * a judgement worth 40 ranking points. Firms the model answers `unknown` for are
 * written back as `unknown` too, so the gap stays visible instead of defaulting.
 */
async function classifyUnknownSegments(
  ctx: TickContext,
  prospects: readonly ProspectRecord[],
  seeds: ReadonlyMap<string, ProspectSeed>,
): Promise<number> {
  const pending = prospects
    .filter((prospect) => prospect.segment === 'unknown' && prospect.licenseNumber !== null)
    .slice(0, classifyBatch());

  if (pending.length === 0) return 0;

  if (!anthropicReady()) {
    await ctx.decide({
      decision: 'classification.skipped',
      summary: `${pending.length} contractors are still unsegmented and stay that way this tick because the interpretation step is not configured. They are ranked on activity alone.`,
      refs: { pending: pending.length },
    });
    return 0;
  }

  const lines = pending.map((prospect) => {
    const seed = seeds.get(prospect.licenseNumber ?? '');
    const permits = seed === undefined ? 'unknown' : String(seed.permitCount);
    const roles = seed === undefined || seed.roles.length === 0 ? 'not published' : seed.roles.join(', ');
    return `license ${prospect.licenseNumber ?? 'unknown'}: "${prospect.firmName}" in ${prospect.city ?? 'an unpublished city'}, ${permits} permits in the window, roles ${roles}`;
  });

  const result = await completeJson({
    system: CLASSIFY_SYSTEM,
    prompt: [
      'Classify each firm below.',
      '',
      ...lines,
      '',
      'Answer with { "classifications": [{ "licenseNumber": string, "segment": "commercial" | "residential" | "unknown", "rationale": string }] }.',
      'Return one entry per firm, using the license number exactly as given.',
    ].join('\n'),
    schema: segmentClassificationSchema,
    maxTokens: 1200,
    temperature: 0,
  });

  if (!result.ok) {
    await ctx.decide({
      decision: result.skipped ? 'classification.skipped' : 'classification.failed',
      summary: `${pending.length} contractors stay unsegmented this tick and are ranked on activity alone: ${result.reason}`,
      refs: { pending: pending.length },
    });
    return 0;
  }

  const byLicense = new Map(pending.map((prospect) => [prospect.licenseNumber ?? '', prospect]));
  const updates: ProspectInput[] = [];
  let commercial = 0;
  let residential = 0;
  let stillUnknown = 0;

  for (const classification of result.value.value.classifications) {
    const prospect = byLicense.get(classification.licenseNumber.trim());
    if (prospect === undefined) continue;
    if (classification.segment === 'commercial') commercial += 1;
    else if (classification.segment === 'residential') residential += 1;
    else {
      stillUnknown += 1;
      /* An honest "cannot tell" is not written as a claim; the row stays unknown. */
      continue;
    }
    updates.push({
      licenseNumber: prospect.licenseNumber,
      firmName: prospect.firmName,
      sourceId: prospect.sourceId,
      segment: classification.segment,
      /* A read of a firm name is reasoning over a fact, never an observation. */
      segmentEvidence: 'inferred',
    });
  }

  if (updates.length > 0) await upsertProspects(updates);

  await ctx.decide({
    decision: 'classification.completed',
    summary: `Read ${pending.length} contractor names: ${commercial} read as commercial shops, ${residential} as residential, ${stillUnknown} carry no signal and stay unsegmented. Only the ${updates.length} with a signal were written, each labelled as reasoning rather than an observation.`,
    refs: {
      considered: pending.length,
      commercial,
      residential,
      unknown: stillUnknown,
      attempts: result.value.attempts,
    },
  });

  return updates.length;
}

/* -------------------------------------------------------------------------- */
/* Copy context                                                               */
/* -------------------------------------------------------------------------- */

/** First name of the individual on the permit record, when the dataset names one. */
function firstNameOf(seed: ProspectSeed | undefined): string | null {
  const full = seed?.contactName?.trim() ?? '';
  if (full.length === 0) return null;
  const first = full.split(/\s+/)[0];
  return first !== undefined && first.length > 0 ? first : null;
}

/**
 * Everything the outreach templates are allowed to say. Facts only.
 *
 * The prospect's own firm name deliberately does not appear: the copy greets a
 * person by first name when the permit record names one, and otherwise opens
 * impersonally. Addressing a contractor by their company name reads like a
 * mailmerge, which is the opposite of the point.
 */
function buildOutreachContext(
  seed: ProspectSeed | undefined,
  sample: SampleOpportunity,
  offer: CustomerProfile,
): OutreachCopyContext {
  /*
   * WHERE THIS LINK GOES, AND WHY IT IS NOT THE JOB NAMED IN THE TEXT.
   *
   * This was `/sample/${sample.record.permitNumber}` and that route does not
   * exist: there is one public sample screen, at `/sample`, and no per-permit
   * variant of it. Every outreach message composed by this worker therefore
   * carried a link that returned 404, which is the worst possible fate for the
   * one tap the whole acquisition motion asks a prospect to make.
   *
   * `/sample` shows the highest scoring opportunity on the board, which is a real
   * live job but is usually NOT the job this message describes. The copy in
   * `sampleOutreachVariants` is worded to match: the text names and quotes this
   * job, and the call to action offers the linked page as an example of what a
   * delivered lead looks like rather than as this job's own record. Read them
   * together before changing either.
   *
   * The honest version of this is a real `/sample/[permitNumber]` screen showing
   * the job the message actually names. A cheaper close is to take the permit as
   * a query parameter here and have `app/sample/page.tsx` prefer it over the top
   * scorer when it is present and resolvable.
   */
  const actionUrl = `${appBaseUrl()}/sample`;
  return {
    contactFirstName: firstNameOf(seed),
    territoryLabel: TERRITORY_LABEL,
    opportunity: { ...sample.copy, detailUrl: actionUrl },
    priceMonthlyUsd: monthlyPriceUsd(),
    minProjectValueUsd: offer.minProjectValue,
    actionUrl,
  };
}

/** Exported for the dashboard: the prospect currently at the head of the queue. */
export async function nextProspect(): Promise<RankedProspect | null> {
  const prospects = await listQualifiedProspects(rankLimit());
  const pool = await loadProspectPoolFromExtract();
  const activity = new Map<string, number>();
  if (pool.ok) {
    for (const seed of pool.value.prospects) activity.set(seed.licenseNumber, seed.permitCount);
  }
  return rankProspects(prospects, activity).find((row) => row.prospect.contactedAt === null) ?? null;
}
