/**
 * Inbound SMS webhook. `POST /api/twilio/inbound`
 *
 * The subscriber's only channel back into the company. An opportunity went out
 * as a text; whatever they type in reply lands here, gets mapped to one of the
 * three feedback values the system understands, and is attached to the
 * opportunity it is obviously about.
 *
 * Deterministic by requirement (CLAUDE.md hard rule #2). No model reads this
 * message. Feedback drives `effective_weights`, which drives scoring, and hard
 * rule #2 keeps scoring arithmetic free of model judgement, so the classifier
 * here is a fixed, ordered list of keyword patterns that a reader can check by
 * eye.
 *
 * Three design notes:
 *
 * - **Generous, then honest.** The patterns accept the many ways a contractor
 *   says the same thing ("yes", "good", "on it"). When nothing matches, the
 *   route does NOT pick the closest guess: it records the message as
 *   unrecognised and answers politely. Inventing an intent would put a
 *   fabricated fact into the feedback loop (hard rule #3).
 * - **Attachment is by delivery, not by content.** Feedback lands on the most
 *   recently delivered opportunity for the number that sent it. A text message
 *   carries no opportunity id, and parsing one out of the reply would be a
 *   guess dressed up as a lookup.
 * - **The reply is customer-facing.** Every string sent back runs through
 *   `assertCustomerSafe`, so hard rule #9 is enforced at the boundary and not
 *   just intended.
 *
 * Numbers are personal data, so the decision log records the last four digits
 * rather than the full number.
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { missingKeys } from '@/lib/config/deployment-env';
import { assertCustomerSafe } from '@/lib/copy/templates';
import { type Feedback } from '@/lib/domain/schemas/core';
import {
  type OpportunityRecord,
  isStoreReady,
  listCustomers,
  listOpportunities,
  logEvent,
  recordFeedback,
} from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* -------------------------------------------------------------------------- */
/* Request shape                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The Twilio form fields this route reads.
 *
 * Twilio posts `application/x-www-form-urlencoded` with roughly thirty fields;
 * these four are the ones that carry meaning here. Absent optional fields
 * become `null` rather than `undefined` so the rest of the file has one shape
 * to handle.
 *
 * Signature validation (`X-Twilio-Signature`) is deliberately NOT done here:
 * the auth token lives behind `lib/integrations/twilio.ts`, which owns every
 * Twilio credential in this codebase, and a validator that reached around that
 * boundary into a route would be the wrong place to add one. Until it exists,
 * treat this endpoint as unauthenticated: the only state it can move is the
 * feedback value on an already-delivered opportunity.
 */
const inboundSchema = z.object({
  From: z.string().min(1, 'From is required'),
  To: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
  Body: z
    .string()
    .nullish()
    .transform((value) => value ?? ''),
  MessageSid: z
    .string()
    .nullish()
    .transform((value) => value ?? null),
});

/* -------------------------------------------------------------------------- */
/* Classification                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Carrier opt-out words. Twilio normally intercepts these before the webhook
 * fires, but if one reaches us it is an unsubscribe, not a verdict on a job, so
 * it must never be filed as feedback and must never draw a reply.
 */
const OPT_OUT_WORDS = new Set([
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'revoke',
  'optout',
]);

/**
 * Lowercase, drop apostrophes, and reduce everything else to single spaces.
 *
 * Apostrophes are removed rather than replaced so "I'll call them" becomes
 * "ill call them" and stays one token per word for the `\b` anchors below.
 */
function normalizeBody(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['‘’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Feedback patterns, in priority order. First match wins.
 *
 * Order is the whole design. `too_small` is checked before `wrong_scope` and
 * both before `good`, because a reply that mixes signals ("yes but too small")
 * is a complaint about the job, not an endorsement, and because "not
 * interested" must not be read as "interested". Every pattern is word-anchored,
 * so "no" does not fire on "nothing" and "yes" does not fire on "yesterday".
 */
const FEEDBACK_PATTERNS: ReadonlyArray<{ feedback: Feedback; pattern: RegExp }> = [
  {
    feedback: 'too_small',
    pattern:
      /\b(?:too small|to small|small job|small one|way small|small|too little|not big enough|too cheap|tiny|below (?:my|our) minimum|under (?:my|our) minimum)\b/,
  },
  {
    feedback: 'wrong_scope',
    pattern:
      /\b(?:wrong|not my scope|out of scope|not our scope|not my trade|not our trade|not electrical|no electrical|not interested|no thanks|not for (?:me|us)|not a fit|doesnt fit|does not fit|nope|nah|pass|no)\b/,
  },
  {
    feedback: 'good',
    pattern:
      /\b(?:good|great|perfect|nice|solid|useful|helpful|yes|yep|yeah|yup|sure|interested|want it|on it|ill call|i will call|calling them|called them|took it|keep them coming|more like this|love it|thanks)\b/,
  },
];

/** The three values the system understands, or null when nothing matched. */
function classify(body: string): Feedback | null {
  const normalized = normalizeBody(body);
  if (normalized.length === 0) return null;
  for (const { feedback, pattern } of FEEDBACK_PATTERNS) {
    if (pattern.test(normalized)) return feedback;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Replies (customer-facing copy, hard rule #9)                               */
/* -------------------------------------------------------------------------- */

const REPLIES = {
  good: 'Got it. We will keep the next ones close to this one.',
  too_small: 'Understood. We will raise the value floor before the next one goes out.',
  wrong_scope: 'Understood. We will tighten the scope match before the next one goes out.',
  unrecognized:
    'Thanks for the reply. We did not catch that one. Reply GOOD, TOO SMALL, or WRONG SCOPE and we will tune what you get.',
  unknownNumber:
    'Thanks for the message. We could not match this number to an account, so nothing was changed.',
  nothingDelivered: 'Thanks for the reply. There is nothing on your list yet to attach that to.',
} as const;

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * A TwiML response. `null` sends nothing back, which is what an opt-out gets.
 *
 * The copy guard runs here rather than at each call site so nothing can reach a
 * phone without passing it.
 */
function twiml(message: string | null): NextResponse {
  if (message !== null) assertCustomerSafe(message, 'twilio inbound reply');
  const body =
    message === null ? '<Response/>' : `<Response><Message>${escapeXml(message)}</Message></Response>`;
  return new NextResponse(`<?xml version="1.0" encoding="UTF-8"?>${body}`, {
    status: 200,
    headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/* -------------------------------------------------------------------------- */
/* Lookup                                                                     */
/* -------------------------------------------------------------------------- */

/** Last ten digits: what a human-typed profile number and E.164 have in common. */
function phoneKey(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

function last4(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : 'unknown';
}

/**
 * The opportunity a reply is about: the most recently delivered one.
 *
 * Sorted on `deliveredAt` rather than `createdAt`, because a rescore can create
 * rows in one order and deliver them in another, and the contractor is
 * answering the text they just received.
 */
function mostRecentlyDelivered(opportunities: readonly OpportunityRecord[]): OpportunityRecord | null {
  let newest: OpportunityRecord | null = null;
  for (const opportunity of opportunities) {
    const stamp = opportunity.deliveredAt ?? opportunity.createdAt;
    const bestStamp = newest === null ? null : (newest.deliveredAt ?? newest.createdAt);
    if (bestStamp === null || stamp > bestStamp) newest = opportunity;
  }
  return newest;
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

export async function POST(request: Request): Promise<NextResponse> {
  const form = new URLSearchParams(await request.text());
  const parsed = inboundSchema.safeParse({
    From: form.get('From'),
    To: form.get('To'),
    Body: form.get('Body'),
    MessageSid: form.get('MessageSid'),
  });

  /* No `From` means this did not come from Twilio, so it gets no TwiML. */
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_twilio_payload',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 400, headers: { 'cache-control': 'no-store' } },
    );
  }

  const { From: from, Body: body, MessageSid: messageSid } = parsed.data;
  const fromLast4 = last4(from);

  if (!isStoreReady()) {
    /* Twilio surfaces the failure in its console, which is the visible signal
     * we want. Answering 200 with a friendly reply would hide a broken deploy. */
    return NextResponse.json(
      {
        error: 'store_unconfigured',
        message: 'Persistence is not configured, so feedback cannot be recorded.',
        missing: missingKeys('supabase'),
      },
      { status: 503, headers: { 'cache-control': 'no-store' } },
    );
  }

  try {
    const normalized = normalizeBody(body);

    if (OPT_OUT_WORDS.has(normalized)) {
      await logEvent({
        agent: 'customer',
        decision: 'feedback.opt_out',
        summary: `An inbound message from a number ending ${fromLast4} asked to stop receiving texts. Nothing was filed as feedback.`,
        refs: { fromLast4, ...(messageSid === null ? {} : { message: messageSid }) },
      });
      return twiml(null);
    }

    const senderKey = phoneKey(from);
    const customers = await listCustomers();
    const matches =
      senderKey === null ? [] : customers.filter((customer) => phoneKey(customer.phone) === senderKey);
    const customer = matches.length === 1 ? matches[0] : undefined;

    if (customer === undefined) {
      await logEvent({
        agent: 'customer',
        decision: 'feedback.unmatched_number',
        summary: `An inbound message from a number ending ${fromLast4} did not match exactly one subscriber, so no feedback was stored.`,
        refs: {
          fromLast4,
          candidates: String(matches.length),
          ...(messageSid === null ? {} : { message: messageSid }),
        },
      });
      return twiml(REPLIES.unknownNumber);
    }

    const delivered = await listOpportunities({
      customerId: customer.id,
      status: 'delivered',
      limit: 25,
    });
    const target = mostRecentlyDelivered(delivered);

    if (target === null) {
      await logEvent({
        agent: 'customer',
        decision: 'feedback.no_delivered_opportunity',
        summary: `${customer.businessName} replied before anything had been delivered to them, so there was nothing to attach the reply to.`,
        refs: { customer: customer.id, fromLast4 },
      });
      return twiml(REPLIES.nothingDelivered);
    }

    const feedback = classify(body);

    if (feedback === null) {
      await logEvent({
        agent: 'customer',
        decision: 'feedback.unrecognized',
        summary: `${customer.businessName} replied with wording that matched no known verdict, so the profile was left unchanged.`,
        refs: {
          customer: customer.id,
          opportunity: target.id,
          ...(messageSid === null ? {} : { message: messageSid }),
        },
      });
      return twiml(REPLIES.unrecognized);
    }

    await recordFeedback(target.id, feedback);
    await logEvent({
      agent: 'customer',
      decision: 'feedback.recorded',
      summary: `${customer.businessName} answered "${feedback}" on the opportunity delivered to them, and it is now on the record for the next weighting pass.`,
      refs: {
        customer: customer.id,
        opportunity: target.id,
        candidate: target.candidateId,
        feedback,
        ...(messageSid === null ? {} : { message: messageSid }),
      },
    });

    return twiml(REPLIES[feedback]);
  } catch (error) {
    console.error('[twilio/inbound] failed to record inbound feedback:', error);
    return NextResponse.json(
      { error: 'inbound_failed', message: 'The reply could not be recorded.' },
      { status: 500, headers: { 'cache-control': 'no-store' } },
    );
  }
}
