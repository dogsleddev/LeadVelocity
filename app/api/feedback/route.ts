/**
 * Subscriber verdict on a lead. `POST /api/feedback`
 *
 * The contractor presses one of three buttons on an opportunity and the answer
 * lands on the row the Customer Agent reads when it re-weights their profile.
 * `good | too_small | wrong_scope` is the entire vocabulary, matching
 * `feedbackSchema` and the `feedback` CHECK constraint on the table, because a
 * richer set would be inventing input the contractor never gave.
 *
 * WHY THIS ROUTE EXISTS
 * ---------------------
 * The same three verdicts already arrive by text message: the Linq and Twilio
 * inbound webhooks classify a reply and call the same `recordFeedback`. Those
 * webhooks need a provider, a public URL, and a subscriber who has texted in
 * first. This route needs a button. It is the only way the feedback loop can be
 * shown end to end from the screens the subscriber actually looks at, and it
 * deliberately shares the store function with the webhooks rather than
 * reimplementing the write, so both paths produce identical rows.
 *
 * Four decisions worth stating:
 *
 * - **It is attributed to the Customer Agent** in the decision log (hard rule
 *   #6), the same as the webhook path. The Customer Agent owns the subscriber
 *   relationship and the weighting that follows from a verdict; the button is a
 *   different doorway into the same decision, not a different decision.
 * - **A verdict does not deliver anything.** `status` and `delivered_at` are
 *   untouched. An opportunity that has been scored but not yet messaged is a
 *   real lead the subscriber can see and rate, and rating it must not let it
 *   start claiming it was sent to them.
 * - **A second verdict is allowed and is logged as a change.** People press the
 *   wrong button, and read the detail page afterwards. The later answer is the
 *   one that counts, and the log says both what it was and what it became.
 * - **It degrades honestly.** No store, no write: 503 naming the missing keys,
 *   never a stack trace and never a cheerful 200 over a write that did not
 *   happen.
 *
 * Body (`application/json`):
 *   `{ "opportunityId": "<uuid>", "feedback": "good" | "too_small" | "wrong_scope" }`
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { missingKeys } from '@/lib/config/deployment-env';
import { type Feedback, feedbackSchema } from '@/lib/domain/schemas/core';
import {
  type OpportunityRecord,
  getCandidate,
  getCustomer,
  getOpportunity,
  isStoreReady,
  logEvent,
  recordFeedback,
} from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* -------------------------------------------------------------------------- */
/* Body                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `.strict()` so a near miss like `{ "opportunity": ..., "verdict": ... }` is a
 * 400 that names the problem, rather than a 200 that recorded nothing.
 */
const bodySchema = z
  .object({
    opportunityId: z.string().uuid('opportunityId must be a uuid'),
    feedback: feedbackSchema,
  })
  .strict();

/** How each verdict reads inside a sentence in the decision log. */
const FEEDBACK_PHRASE: Readonly<Record<Feedback, string>> = Object.freeze({
  good: 'a good lead',
  too_small: 'too small',
  wrong_scope: 'the wrong scope',
});

function jsonResponse(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * The opportunity as the caller gets it back: camelCase, unknowns preserved as
 * `null`, and the component breakdown included so a screen that just recorded a
 * verdict can re-render from this response alone.
 */
function present(opportunity: OpportunityRecord): Record<string, unknown> {
  return {
    id: opportunity.id,
    candidateId: opportunity.candidateId,
    customerId: opportunity.customerId,
    status: opportunity.status,
    score: opportunity.score,
    drivers: opportunity.drivers,
    /* `null` where migration 0003 predates the row. Not zeroes. */
    componentSubtotals: opportunity.componentSubtotals,
    warnings: opportunity.warnings,
    fatalFlags: opportunity.fatalFlags,
    summary: opportunity.summary,
    bestPathIn: opportunity.bestPathIn,
    recommendedAction: opportunity.recommendedAction,
    deliveredAt: opportunity.deliveredAt,
    feedback: opportunity.feedback,
    feedbackAt: opportunity.feedbackAt,
    createdAt: opportunity.createdAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = (await request.text()).trim();

  let candidateBody: unknown = {};
  if (rawBody.length > 0) {
    try {
      candidateBody = JSON.parse(rawBody);
    } catch {
      return jsonResponse(
        { error: 'invalid_json', message: 'Body must be JSON.' },
        400,
      );
    }
  }

  const parsed = bodySchema.safeParse(candidateBody);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: 'invalid_body',
        message:
          'Send an opportunityId and one of the three verdicts: good, too_small, wrong_scope.',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      400,
    );
  }

  if (!isStoreReady()) {
    return jsonResponse(
      {
        error: 'store_unconfigured',
        message: 'Persistence is not configured, so the verdict could not be recorded.',
        missing: missingKeys('supabase'),
      },
      503,
    );
  }

  const { opportunityId, feedback } = parsed.data;

  try {
    /* Read first, so an unknown id is a 404 rather than an update that silently
     * matched no rows, and so the log can report what the previous answer was. */
    const existing = await getOpportunity(opportunityId);
    if (existing === null) {
      return jsonResponse(
        { error: 'opportunity_not_found', message: 'No opportunity with that id.', opportunityId },
        404,
      );
    }

    const updated = await recordFeedback(opportunityId, feedback);

    /* Name the lead the way the rest of the log names it, by its permit. Both
     * lookups are best effort: a verdict is recorded whether or not the sentence
     * around it can be filled in. */
    const [candidate, customer] = await Promise.all([
      getCandidate(updated.candidateId),
      getCustomer(updated.customerId),
    ]);
    const label =
      candidate === null ? `opportunity ${updated.id}` : `permit ${candidate.permitNumber}`;
    const who = customer === null ? 'The subscriber' : customer.businessName;

    const previous = existing.feedback;
    const changed = previous !== feedback;
    const decision =
      previous === null
        ? 'feedback.recorded'
        : changed
          ? 'feedback.changed'
          : 'feedback.reaffirmed';
    const summary =
      previous === null
        ? `${who} marked the lead on ${label} as ${FEEDBACK_PHRASE[feedback]}, and it is on the record for the next weighting pass.`
        : changed
          ? `${who} changed the verdict on the lead on ${label} from ${FEEDBACK_PHRASE[previous]} to ${FEEDBACK_PHRASE[feedback]}, and the later answer is the one that counts.`
          : `${who} pressed the same verdict again on the lead on ${label}: ${FEEDBACK_PHRASE[feedback]}. Nothing about their profile moved.`;

    const logged = await logEvent({
      agent: 'customer',
      decision,
      summary,
      refs: {
        opportunity: updated.id,
        candidate: updated.candidateId,
        customer: updated.customerId,
        ...(candidate === null ? {} : { permit: candidate.permitNumber }),
        feedback,
        ...(previous === null ? {} : { previousFeedback: previous }),
        source: 'subscriber_console',
      },
    });

    return jsonResponse(
      {
        opportunity: present(updated),
        /* False when the same verdict was already on the row. */
        changed,
        /* The verdict is stored either way; this only reports whether the
         * decision log itself took the entry. */
        logged: logged.persisted,
      },
      200,
    );
  } catch (error) {
    console.error('[feedback] write failed:', error);
    return jsonResponse(
      { error: 'store_unavailable', message: 'The verdict could not be recorded.' },
      503,
    );
  }
}
