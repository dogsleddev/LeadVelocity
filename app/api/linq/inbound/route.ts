/**
 * Inbound Linq webhook. `POST /api/linq/inbound`
 *
 * This route is the hinge the whole Linq motion turns on. Linq's sandbox will
 * only let the company message a handle that has texted the Linq number first,
 * so the Sales Agent composes a sample, finds the handle unreachable, and holds
 * the message in `outbound_queue` with the honest status `waiting_for_inbound`.
 * Nothing releases it except this route. When the handle finally texts in, the
 * event arrives here and four things happen in a fixed order:
 *
 *   1. the handle is recorded as reachable (`recordInboundContact`),
 *   2. an opt-out is honoured before anything else reads the text,
 *   3. otherwise the text is mapped to feedback on the last delivered
 *      opportunity,
 *   4. everything held for that handle is sent and stamped `sent`.
 *
 * Step 4 is the point of the file. Until it runs, the queued rows are prepared
 * work and are never reported as deliveries (CLAUDE.md hard rules 3 and 10).
 *
 * Properties this file exists to guarantee:
 *
 * - **Raw bytes, then verification, then meaning.** `runtime = 'nodejs'` and
 *   `await request.text()` before anything else touches the request, because
 *   Standard Webhooks signs the exact body. An unverified body is never parsed
 *   for content, never logged as fact, and never moves state. Unverified is 400,
 *   unconfigured is 503.
 * - **Deterministic interpretation.** No model reads an inbound message. The
 *   opt-out and feedback classifiers are ordered keyword lists a reader can
 *   check by eye (hard rule 2), and a message matching nothing is recorded as
 *   unrecognised rather than guessed at (hard rule 3).
 * - **Opt-out outranks everything.** "stop" is a withdrawal of consent, not a
 *   verdict on a job. It is detected before feedback mapping, it is never filed
 *   as feedback, and it blocks the queue drain.
 * - **A verified event that we understood always answers 200.** A webhook that
 *   400s on a benign delivery gets its subscription disabled, and losing the
 *   subscription means losing the only path that releases held messages.
 *
 * Two deliberate exceptions to house convention, both narrow:
 *
 * - The route imports `verifyLinqWebhook` from `lib/integrations/linq`. The
 *   convention in CLAUDE.md ("routes never import the integrations directly")
 *   is about DELIVERY: it exists so swapping channels stays a config flip.
 *   Signature verification is not delivery, and `lib/delivery/channel.ts`
 *   exposes no inbound seam to route it through. Every SEND below still goes
 *   through `sendMessage`.
 * - The feedback classifier duplicates the one in `app/api/twilio/inbound`.
 *   Both routes are owned separately in this change, so the patterns are copied
 *   verbatim rather than shared. They must stay in step; see the note above
 *   `FEEDBACK_PATTERNS` before editing either copy.
 *
 * Handles are personal data, so the decision log and the response carry a
 * redacted form (`***4821`, `m***@example.com`) and never the full handle.
 */
import { NextResponse } from 'next/server';

import { missingKeys, optionalEnv } from '@/lib/config/deployment-env';
import { channelLabel, normalizeRecipient, sendMessage } from '@/lib/delivery/channel';
import { type Feedback } from '@/lib/domain/schemas/core';
import {
  type InboundMessage,
  LINQ_INBOUND_EVENT,
  verifyLinqWebhook,
} from '@/lib/integrations/linq';
import {
  type CustomerRecord,
  type OpportunityRecord,
  type QueuePurpose,
  isReachable,
  isStoreReady,
  listCustomers,
  listOpportunities,
  listPendingFor,
  logEvent,
  markOptedOut,
  markQueuedSent,
  recordFeedback,
  recordInboundContact,
} from '@/lib/store';

/** Required: signature verification needs the raw bytes and node crypto. */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonResponse(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/** Drop absent pointers rather than writing a placeholder into the log. */
function refsOf(entries: ReadonlyArray<readonly [string, string | null]>): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (value !== null && value.length > 0) refs[key] = value;
  }
  return refs;
}

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Keys this route cannot run without, by name.
 *
 * `LINQ_WEBHOOK_SECRET` is checked here rather than through `hasCapability`
 * because deployment-env deliberately keeps it out of the `linq` capability:
 * outbound can be wired before inbound. Inbound is exactly what this file is,
 * so here the secret is required. Without it `verifyLinqWebhook` refuses to
 * trust the body, and that refusal is a configuration fault (503) rather than a
 * bad request (400).
 */
function inboundConfigMissing(): string[] {
  const missing = missingKeys('linq');
  if (optionalEnv('LINQ_WEBHOOK_SECRET') === null) missing.push('LINQ_WEBHOOK_SECRET');
  return missing;
}

/** Standard Webhooks needs the delivery's headers, lowercased and plain. */
function collectHeaders(request: Request): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return headers;
}

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Recently processed inbound message ids.
 *
 * Linq retries a delivery it did not see acknowledged, and a retry must not
 * bump the sighting counter twice or, far worse, send a held message twice.
 * This is the first of three guards, deliberately layered because the first one
 * is the weakest:
 *
 *   1. this set, which is per process and vanishes on restart,
 *   2. a stable `Idempotency-Key` per queued row on every release send, so the
 *      provider itself collapses a duplicate that got past (1),
 *   3. `markQueuedSent`, which only moves a row that is still pending, so a
 *      second release can never overwrite the first provider id.
 *
 * Bounded so a long-lived process cannot grow it without limit. Insertion order
 * is Set iteration order, so dropping the first entry drops the oldest.
 */
const SEEN_MESSAGE_IDS = new Set<string>();
const SEEN_LIMIT = 500;

/**
 * Claim a message id for processing. False means it is already in flight or
 * done, and the caller should acknowledge without acting.
 *
 * An empty id (a payload shape that carried none) cannot be claimed and is
 * allowed through: guards (2) and (3) still hold, and refusing to process a
 * message because the provider omitted an id would drop real contact.
 */
function claimMessage(messageId: string): boolean {
  if (messageId === '') return true;
  if (SEEN_MESSAGE_IDS.has(messageId)) return false;
  SEEN_MESSAGE_IDS.add(messageId);
  if (SEEN_MESSAGE_IDS.size > SEEN_LIMIT) {
    const oldest = SEEN_MESSAGE_IDS.values().next();
    if (oldest.done !== true) SEEN_MESSAGE_IDS.delete(oldest.value);
  }
  return true;
}

/** Give the claim back so a genuine retry of a failed attempt can proceed. */
function releaseClaim(messageId: string): void {
  if (messageId !== '') SEEN_MESSAGE_IDS.delete(messageId);
}

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A handle in a form that is safe to write to the decision log.
 *
 * Phone handles keep their last four digits, which is what a contractor
 * recognises as their own number; email handles keep the first character and
 * the domain. Enough to follow one conversation through the log, not enough to
 * be a contact list.
 */
function redactHandle(handle: string): string {
  if (handle.includes('@')) {
    const at = handle.indexOf('@');
    const local = handle.slice(0, at);
    const domain = handle.slice(at + 1);
    const head = local.slice(0, 1);
    return domain.length > 0 ? `${head}***@${domain}` : `${head}***`;
  }
  const digits = handle.replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-4)}` : 'an unrecognised handle';
}

/* -------------------------------------------------------------------------- */
/* Text interpretation (deterministic, hard rule 2)                           */
/* -------------------------------------------------------------------------- */

/**
 * Lowercase, drop apostrophes, and reduce everything else to single spaces.
 *
 * Copied from `app/api/twilio/inbound/route.ts`. Apostrophes are removed rather
 * than replaced so "I'll call them" becomes "ill call them" and stays one token
 * per word for the `\b` anchors below.
 */
function normalizeBody(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['‘’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Carrier keywords that are only an opt-out when they are the whole message.
 *
 * "cancel" and "end" are ordinary words in a contractor's vocabulary ("the job
 * was cancelled", "at the end of the week"), so matching them mid-sentence
 * would silence a subscriber who never asked to be silenced.
 */
const OPT_OUT_KEYWORDS: ReadonlySet<string> = new Set([
  'stop',
  'stopall',
  'unsubscribe',
  'cancel',
  'end',
  'quit',
  'revoke',
  'optout',
  'opt out',
]);

/**
 * Opt-out phrasing that is unambiguous anywhere in a message.
 *
 * The asymmetry here is intentional. A false positive costs one contact who
 * gets nothing further until they ask again; a false negative is messaging
 * somebody who told us to stop. The second is a consent violation, so this list
 * leans toward reading a refusal.
 */
const OPT_OUT_PATTERN =
  /\b(?:stop|stopall|unsubscribe|quit|optout|opt out|remove me|take me off|no more (?:texts?|messages?)|dont (?:text|message) me|stop (?:texting|messaging))\b/;

/** True when the sender asked us to stop. Checked before anything else. */
function isOptOut(text: string): boolean {
  const normalized = normalizeBody(text);
  if (normalized.length === 0) return false;
  return OPT_OUT_KEYWORDS.has(normalized) || OPT_OUT_PATTERN.test(normalized);
}

/**
 * Feedback patterns, in priority order. First match wins.
 *
 * COPIED VERBATIM from `app/api/twilio/inbound/route.ts` so a contractor gets
 * the same reading of the same words whichever channel carried them. If either
 * copy changes, change both; a channel that classifies "too small" differently
 * from the other one would move `effective_weights` differently depending on
 * how the message happened to arrive.
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
function classify(text: string): Feedback | null {
  const normalized = normalizeBody(text);
  if (normalized.length === 0) return null;
  for (const { feedback, pattern } of FEEDBACK_PATTERNS) {
    if (pattern.test(normalized)) return feedback;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Attachment                                                                 */
/* -------------------------------------------------------------------------- */

/** Last ten digits: what a human-typed profile number and E.164 have in common. */
function phoneKey(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * The subscriber this handle belongs to, or undefined.
 *
 * Exactly one match or nothing. Two profiles sharing a number is a data problem
 * to surface, not a coin to flip. An email handle never matches, because the
 * subscriber profile carries a phone and no email, and inventing a match from a
 * local part would be a guess dressed as a lookup.
 */
async function resolveSubscriber(handle: string): Promise<CustomerRecord | undefined> {
  const senderKey = phoneKey(handle);
  if (senderKey === null) return undefined;
  const customers = await listCustomers();
  const matches = customers.filter((customer) => phoneKey(customer.phone) === senderKey);
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The opportunity a reply is about: the most recently delivered one.
 *
 * Sorted on `deliveredAt` rather than `createdAt`, because a rescore can create
 * rows in one order and deliver them in another, and the contractor is
 * answering the message they just received.
 */
function mostRecentlyDelivered(
  opportunities: readonly OpportunityRecord[],
): OpportunityRecord | null {
  let newest: OpportunityRecord | null = null;
  for (const opportunity of opportunities) {
    const stamp = opportunity.deliveredAt ?? opportunity.createdAt;
    const bestStamp = newest === null ? null : (newest.deliveredAt ?? newest.createdAt);
    if (bestStamp === null || stamp > bestStamp) newest = opportunity;
  }
  return newest;
}

/** What the feedback stage concluded, for the response and nothing else. */
type FeedbackNote = 'recorded' | 'unrecognized' | 'unmatched_handle' | 'nothing_delivered';

interface FeedbackOutcome {
  feedback: Feedback | null;
  note: FeedbackNote;
}

/**
 * Map the text to feedback and attach it to the last delivered opportunity.
 *
 * Every branch writes one row to the decision log under the Customer Agent,
 * whose job the feedback loop is. Nothing here throws on a miss: an
 * unrecognised message and an unmatched handle are both real, recordable
 * outcomes rather than errors.
 */
async function applyFeedback(
  handle: string,
  redacted: string,
  event: InboundMessage,
): Promise<FeedbackOutcome> {
  const messageRef = refsOf([
    ['handle', redacted],
    ['message', event.messageId],
  ]);

  const customer = await resolveSubscriber(handle);
  if (customer === undefined) {
    await logEvent({
      agent: 'customer',
      decision: 'feedback.unmatched_handle',
      summary: `An inbound message from ${redacted} did not match exactly one subscriber, so no feedback was stored.`,
      refs: messageRef,
    });
    return { feedback: null, note: 'unmatched_handle' };
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
      summary: `${customer.businessName} sent a message before anything had been delivered to them, so there was nothing to attach it to.`,
      refs: { ...messageRef, customer: customer.id },
    });
    return { feedback: null, note: 'nothing_delivered' };
  }

  const feedback = classify(event.text);

  if (feedback === null) {
    await logEvent({
      agent: 'customer',
      decision: 'feedback.unrecognized',
      summary: `${customer.businessName} replied with wording that matched no known verdict, so the profile was left unchanged.`,
      refs: { ...messageRef, customer: customer.id, opportunity: target.id },
    });
    return { feedback: null, note: 'unrecognized' };
  }

  await recordFeedback(target.id, feedback);
  await logEvent({
    agent: 'customer',
    decision: 'feedback.recorded',
    summary: `${customer.businessName} answered "${feedback}" on the opportunity delivered to them, and it is now on the record for the next weighting pass.`,
    refs: {
      ...messageRef,
      customer: customer.id,
      opportunity: target.id,
      candidate: target.candidateId,
      feedback,
    },
  });
  return { feedback, note: 'recorded' };
}

/* -------------------------------------------------------------------------- */
/* Queue release                                                              */
/* -------------------------------------------------------------------------- */

/** How the log names what was waiting, so a judge reads a sentence not a code. */
const PURPOSE_LABEL: Readonly<Record<QueuePurpose, string>> = Object.freeze({
  sales_sample: 'A sample',
  opportunity: 'An opportunity',
  other: 'A message',
});

interface ReleaseOutcome {
  /** Rows that a provider accepted and that are now stamped `sent`. */
  released: number;
  /** Rows still waiting. Prepared work, never reported as delivered. */
  held: number;
  /** Set when the drain stopped early, e.g. the channel lost its credentials. */
  stopped: string | null;
}

/**
 * Send everything held for a handle that has just made contact.
 *
 * This is the step that turns "prepared, waiting for first contact" into a real
 * delivery, and it is the only place in the codebase that does. Oldest first,
 * because that is the order the company decided to say things.
 *
 * Failure is per message and never fabricated: a row is stamped `sent` only
 * after `sendMessage` returns a receipt, and a refusal leaves the row pending
 * so the next inbound message tries again. An unconfigured channel stops the
 * drain immediately, because every remaining send would fail the same way and
 * twenty identical failure rows would bury the log.
 */
async function releaseQueue(
  handle: string,
  redacted: string,
  event: InboundMessage,
): Promise<ReleaseOutcome> {
  const pending = await listPendingFor(handle);
  if (pending.length === 0) return { released: 0, held: 0, stopped: null };

  let released = 0;

  for (const queued of pending) {
    const result = await sendMessage({
      to: handle,
      body: queued.body,
      ...(queued.linkUrl !== null ? { linkPreviewUrl: queued.linkUrl } : {}),
      /* Stable per row, so a duplicate drain cannot double-send even if the
       * in-process guard was lost to a restart between the two deliveries. */
      idempotencyKey: `release-${queued.id}`,
    });

    const baseRefs = refsOf([
      ['handle', redacted],
      ['queued', queued.id],
      ['purpose', queued.purpose],
      ['opportunity', queued.opportunityId],
      ['inbound', event.messageId],
    ]);

    if (!result.ok) {
      if (result.skipped) {
        const stillHeld = pending.length - released;
        await logEvent({
          agent: 'sales',
          decision: 'outbound.release_skipped',
          summary: `${stillHeld} ${stillHeld === 1 ? 'message' : 'messages'} held for ${redacted} stayed in the queue because the delivery channel is not configured on this deploy.`,
          refs: { ...baseRefs, reason: result.reason },
        });
        return { released, held: stillHeld, stopped: result.reason };
      }

      await logEvent({
        agent: 'sales',
        decision: 'outbound.release_failed',
        summary: `${PURPOSE_LABEL[queued.purpose]} held for ${redacted} could not be sent after they made contact, so it is still waiting and was not recorded as delivered.`,
        refs: {
          ...baseRefs,
          reason: result.reason,
          ...(result.requiresInboundFirst === true ? { requiresInboundFirst: 'true' } : {}),
          ...(result.optedOut === true ? { optedOut: 'true' } : {}),
        },
      });
      continue;
    }

    const receipt = result.value;

    /* The provider has it. From here the only failure left is bookkeeping, and
     * bookkeeping must not cause a resend of a message already on a phone. */
    try {
      await markQueuedSent(queued.id, receipt.messageId);
    } catch (error) {
      console.error(
        `[linq/inbound] sent queued message ${queued.id} but could not stamp it sent:`,
        error,
      );
      await logEvent({
        agent: 'sales',
        decision: 'outbound.release_unstamped',
        summary: `${PURPOSE_LABEL[queued.purpose]} held for ${redacted} was accepted by the delivery channel but its queue row could not be updated, so the queue may still show it as waiting.`,
        refs: { ...baseRefs, message: receipt.messageId, channel: receipt.channel },
      });
      released += 1;
      continue;
    }

    released += 1;
    await logEvent({
      agent: 'sales',
      decision: 'outbound.released',
      summary: `${PURPOSE_LABEL[queued.purpose]} that had been waiting for first contact from ${redacted} went out through ${channelLabel()} now that they have made contact.`,
      refs: { ...baseRefs, message: receipt.messageId, channel: receipt.channel, status: receipt.status },
    });
  }

  return { released, held: pending.length - released, stopped: null };
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

export async function POST(request: Request): Promise<NextResponse> {
  /* Raw bytes first. Nothing may parse or re-serialize the body before this. */
  const rawBody = await request.text();
  const headers = collectHeaders(request);

  const missing = inboundConfigMissing();
  if (missing.length > 0) {
    return jsonResponse(
      {
        error: 'linq_unconfigured',
        message: 'Inbound deliveries cannot be verified on this deploy.',
        /* Key names only. This response is safe to paste into a chat window. */
        missing,
      },
      503,
    );
  }

  const verified = verifyLinqWebhook(rawBody, headers);
  if (!verified.ok) {
    if (verified.skipped) {
      return jsonResponse({ error: 'linq_unconfigured', missing: missingKeys('linq') }, 503);
    }
    /* Reason logged server side only: it echoes caller-supplied header data. */
    console.warn('[linq/inbound] rejected an unverified delivery:', verified.reason);
    return jsonResponse({ error: 'invalid_signature' }, 400);
  }

  const event = verified.value;

  /* Delivery receipts and every other subscribed type are real events that
   * simply are not ours to act on. Acknowledge without writing a log row, so
   * the decision log stays a record of decisions rather than of traffic. */
  if (event.eventType !== LINQ_INBOUND_EVENT) {
    return jsonResponse({ received: true, handled: false, reason: 'ignored', type: event.eventType }, 200);
  }

  if (!isStoreReady()) {
    /* 503 so Linq retries once persistence exists. Answering 200 would drop a
     * first contact, and a first contact is the only thing that can ever
     * release the messages held for that handle. */
    return jsonResponse(
      {
        error: 'store_unconfigured',
        message: 'Persistence is not configured, so inbound contact cannot be recorded.',
        missing: missingKeys('supabase'),
      },
      503,
    );
  }

  if (!claimMessage(event.messageId)) {
    return jsonResponse({ received: true, handled: false, reason: 'duplicate' }, 200);
  }

  try {
    const rawHandle = event.handle;
    if (rawHandle === null || rawHandle.trim().length === 0) {
      await logEvent({
        agent: 'customer',
        decision: 'inbound.no_handle',
        summary:
          'A verified inbound message arrived with no sender handle, so it could not be attributed to a contact and nothing was released.',
        refs: refsOf([
          ['message', event.messageId],
          ['chat', event.chatId],
        ]),
      });
      return jsonResponse({ received: true, handled: false, reason: 'no_handle' }, 200);
    }

    /* Normalized through the delivery seam, which is what wrote the handles in
     * `inbound_contacts` and `outbound_queue`. Using a second normalization
     * here would key the release lookup differently from the queueing. */
    const handle = normalizeRecipient(rawHandle);
    if (handle === null) {
      await logEvent({
        agent: 'customer',
        decision: 'inbound.unusable_handle',
        summary:
          'A verified inbound message arrived from a handle the delivery channel cannot address, so it was recorded here and nothing was released.',
        refs: refsOf([
          ['handle', redactHandle(rawHandle)],
          ['message', event.messageId],
        ]),
      });
      return jsonResponse({ received: true, handled: false, reason: 'unusable_handle' }, 200);
    }

    const redacted = redactHandle(handle);

    /* Step 1, and the reason this route exists: they have texted us, so the
     * sandbox now permits us to text them. */
    const contact = await recordInboundContact({
      handle,
      channel: 'linq',
      chatId: event.chatId,
    });

    if (contact.messageCount <= 1) {
      /* Attributed to Sales because of what the row means: the gate on
       * outbound contact for this handle has opened. A repeat sighting logs
       * nothing here; the feedback and release rows below carry that story. */
      await logEvent({
        agent: 'sales',
        decision: 'inbound.first_contact',
        summary: `${redacted} made contact for the first time, so anything prepared for them may now be sent.`,
        refs: refsOf([
          ['handle', redacted],
          ['message', event.messageId],
          ['chat', event.chatId],
        ]),
      });
    }

    /* Step 2. Before any reading of the text as feedback: a stop request is a
     * withdrawal of consent, never a verdict on a job. */
    if (isOptOut(event.text)) {
      await markOptedOut(handle);
      await logEvent({
        agent: 'customer',
        decision: 'feedback.opt_out',
        summary: `${redacted} asked to stop receiving messages. Nothing was filed as feedback, nothing held for them was released, and the queue stays closed to them.`,
        refs: refsOf([
          ['handle', redacted],
          ['message', event.messageId],
        ]),
      });
      return jsonResponse(
        {
          received: true,
          handled: true,
          handle: redacted,
          optedOut: true,
          feedback: null,
          released: 0,
          held: 0,
        },
        200,
      );
    }

    /* Step 3. */
    const outcome = await applyFeedback(handle, redacted, event);

    /* Step 4. Consent is re-read from the store rather than assumed from the
     * absence of a stop word in this message, so a handle that opted out
     * earlier and has now texted something else still gets nothing sent. Their
     * held rows stay pending on purpose: a pending row also occupies the
     * one-per-handle-per-purpose index, which keeps a second copy from being
     * composed for someone who cannot receive it. */
    const reachable = await isReachable(handle);
    if (!reachable) {
      await logEvent({
        agent: 'sales',
        decision: 'outbound.release_blocked',
        summary: `${redacted} has asked us to stop, so nothing held for them was released.`,
        refs: refsOf([
          ['handle', redacted],
          ['message', event.messageId],
        ]),
      });
      return jsonResponse(
        {
          received: true,
          handled: true,
          handle: redacted,
          optedOut: true,
          feedback: outcome.feedback,
          feedbackNote: outcome.note,
          released: 0,
        },
        200,
      );
    }

    const release = await releaseQueue(handle, redacted, event);

    return jsonResponse(
      {
        received: true,
        handled: true,
        handle: redacted,
        optedOut: false,
        feedback: outcome.feedback,
        feedbackNote: outcome.note,
        released: release.released,
        held: release.held,
        ...(release.stopped === null ? {} : { releaseStopped: release.stopped }),
      },
      200,
    );
  } catch (error) {
    /* Hand the claim back so Linq's retry is a real second attempt rather than
     * a no-op, then fail loudly enough that the retry has somewhere to land. */
    releaseClaim(event.messageId);
    console.error('[linq/inbound] failed to process a verified inbound message:', error);
    return jsonResponse(
      { error: 'inbound_failed', message: 'The inbound message could not be processed.' },
      500,
    );
  }
}
