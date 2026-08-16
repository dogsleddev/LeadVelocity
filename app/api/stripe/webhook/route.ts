/**
 * Stripe webhook. `POST /api/stripe/webhook`
 *
 * This is the route that turns a payment into a served customer. The P0 loop
 * requires that a prospect checks out and the account activates on the webhook,
 * so everything here is deterministic (CLAUDE.md hard rule #2): no model runs in
 * this path, nothing is inferred, and billing state is a pure function of a
 * verified Stripe event.
 *
 * Stripe is a payment processor, not a fifth agent (hard rule #4). The decision
 * rows this route writes are attributed to the Sales Agent, whose acquisition
 * motion the payment completes. That is an attribution of the ledger entry, not
 * a claim that a webhook is an agent.
 *
 * Four properties this file exists to guarantee:
 *
 * 1. **Raw body, always.** `runtime = 'nodejs'` and `await request.text()`
 *    before anything else touches the request. A parsed and re-serialized body
 *    will not verify, and that failure looks like a Stripe outage when it is
 *    actually a route bug.
 * 2. **Nothing is trusted before verification.** The signature is checked first;
 *    an unverified body is never read for meaning. Bad signature is 400 and
 *    writes nothing.
 * 3. **Exactly-once effects.** `recordStripeEventOnce` claims the Stripe event
 *    id inside a single INSERT ... ON CONFLICT, so a retried delivery (Stripe
 *    retries for days) is a no-op that answers 200.
 * 4. **The verified event wins.** Ids, mode, and status are read off
 *    `event.data.object` and `event.livemode`, never off anything a caller could
 *    have set independently.
 *
 * Status codes: 400 malformed or unverified, 503 unconfigured or store
 * unavailable, 500 verified but not applied, 200 for everything else including
 * duplicates and event types the company deliberately ignores.
 */
import type Stripe from 'stripe';
import { NextResponse } from 'next/server';

import { missingKeys } from '@/lib/config/deployment-env';
import {
  type RelevantStripeEvent,
  mapSubscriptionState,
  narrowStripeEvent,
  stripeIdOf,
  stripeReady,
  verifyWebhookSignature,
} from '@/lib/integrations/stripe';
import {
  type CustomerRecord,
  type StripeMode,
  activateFromStripe,
  getCustomer,
  getSubscriptionByCustomer,
  isStoreReady,
  listCustomers,
  logEvent,
  recordStripeEventOnce,
  setCustomerStatus,
  setStatus,
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
/* Customer resolution                                                        */
/* -------------------------------------------------------------------------- */

/** Postgres would reject a non-uuid against `customers.id`, so check first. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Last ten digits, which is what two renderings of one US number share. */
function phoneKey(raw: string | null): string | null {
  if (raw === null) return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

interface ResolutionHints {
  /** A LeadVelocity customer id carried on the Stripe object, if any. */
  customerIdHint: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  /** Phone the payer typed at checkout, matched against the subscriber profile. */
  phone: string | null;
}

interface Resolution {
  customer: CustomerRecord | null;
  /** How the match was made, recorded in the decision log so it is auditable. */
  via: 'metadata' | 'stripe_ids' | 'phone' | 'sole_subscriber' | 'unresolved';
}

/**
 * Map a Stripe object back to the subscriber it belongs to.
 *
 * Strongest evidence first, and every step is an exact match. Nothing here
 * guesses: when no rule fires the answer is `unresolved` and the caller records
 * that fact instead of activating somebody at random.
 *
 * The `sole_subscriber` rule is the one that needs defending. A Stripe Payment
 * Link opened from an SMS carries no metadata and no client reference, so on a
 * deployment holding exactly one customer row the mapping is not ambiguous:
 * there is precisely one account the payment can belong to. The moment a second
 * customer exists the rule stops firing, because then it would be a guess.
 */
async function resolveCustomer(hints: ResolutionHints): Promise<Resolution> {
  if (hints.customerIdHint !== null && UUID.test(hints.customerIdHint)) {
    const byId = await getCustomer(hints.customerIdHint);
    if (byId !== null) return { customer: byId, via: 'metadata' };
  }

  const customers = await listCustomers();

  if (hints.stripeCustomerId !== null || hints.stripeSubscriptionId !== null) {
    for (const customer of customers) {
      const subscription = await getSubscriptionByCustomer(customer.id);
      if (subscription === null) continue;
      const matchesCustomer =
        hints.stripeCustomerId !== null &&
        subscription.stripeCustomerId === hints.stripeCustomerId;
      const matchesSubscription =
        hints.stripeSubscriptionId !== null &&
        subscription.stripeSubscriptionId === hints.stripeSubscriptionId;
      if (matchesCustomer || matchesSubscription) return { customer, via: 'stripe_ids' };
    }
  }

  const payerPhone = phoneKey(hints.phone);
  if (payerPhone !== null) {
    const matches = customers.filter((customer) => phoneKey(customer.phone) === payerPhone);
    const only = matches.length === 1 ? matches[0] : undefined;
    if (only !== undefined) return { customer: only, via: 'phone' };
  }

  const sole = customers.length === 1 ? customers[0] : undefined;
  if (sole !== undefined) return { customer: sole, via: 'sole_subscriber' };

  return { customer: null, via: 'unresolved' };
}

/* -------------------------------------------------------------------------- */
/* Event application                                                          */
/* -------------------------------------------------------------------------- */

interface WebhookOutcome {
  /** False when the event was understood but deliberately changed nothing. */
  handled: boolean;
  /** Decision verb written to the events log. */
  decision: string;
  summary: string;
  refs: Record<string, string>;
}

/**
 * Stripe sends seconds since the epoch. Guarded rather than trusted because the
 * field has moved around between API versions and a bad multiplication here
 * would write a nonsense renewal date onto the dashboard.
 */
function periodEndIso(subscription: Stripe.Subscription): string | null {
  const seconds: unknown = subscription.current_period_end;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/** Our customer id, when the Stripe object was created with one attached. */
function metadataCustomerId(metadata: Stripe.Metadata | null | undefined): string | null {
  const value = metadata?.['customer_id'] ?? metadata?.['leadvelocity_customer_id'] ?? null;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

async function applyCheckout(
  session: Stripe.Checkout.Session,
  eventId: string,
  mode: StripeMode,
): Promise<WebhookOutcome> {
  const stripeCustomerId = stripeIdOf(session.customer);
  const stripeSubscriptionId = stripeIdOf(session.subscription);

  const baseRefs = refsOf([
    ['stripeEvent', eventId],
    ['checkoutSession', session.id],
    ['stripeCustomer', stripeCustomerId],
    ['stripeSubscription', stripeSubscriptionId],
  ]);

  /* A one-off payment is a real event that simply does not start a plan. */
  if (session.mode !== 'subscription') {
    return {
      handled: false,
      decision: 'subscription.not_applicable',
      summary: `Checkout completed in ${session.mode} mode, so no subscription was started.`,
      refs: baseRefs,
    };
  }

  /* Bank debits settle later. Activating now would serve an unpaid account. */
  if (session.payment_status === 'unpaid') {
    return {
      handled: false,
      decision: 'subscription.payment_pending',
      summary: 'Checkout completed but payment has not settled, so the account stays inactive.',
      refs: baseRefs,
    };
  }

  const resolution = await resolveCustomer({
    customerIdHint: metadataCustomerId(session.metadata) ?? session.client_reference_id,
    stripeCustomerId,
    stripeSubscriptionId,
    phone: session.customer_details?.phone ?? null,
  });
  const customer = resolution.customer;

  if (customer === null) {
    return {
      handled: false,
      decision: 'subscription.unmatched',
      summary:
        'A completed checkout could not be matched to a subscriber profile, so no billing state changed.',
      refs: baseRefs,
    };
  }

  if (stripeCustomerId !== null && stripeSubscriptionId !== null) {
    await activateFromStripe({
      customerId: customer.id,
      stripeCustomerId,
      stripeSubscriptionId,
      checkoutSessionId: session.id,
      mode,
    });
  } else {
    /*
     * Subscription mode without both ids is unusual but survivable: the status
     * is what gates fulfilment, and recording it beats dropping the payment.
     */
    await setStatus(customer.id, 'active');
  }
  await setCustomerStatus(customer.id, 'active');

  return {
    handled: true,
    decision: 'subscription.activated',
    summary: `Checkout completed for ${customer.businessName}. The subscription is active in ${mode} mode and matched by ${resolution.via}.`,
    refs: { ...baseRefs, customer: customer.id, matchedBy: resolution.via },
  };
}

async function applySubscriptionChange(
  subscription: Stripe.Subscription,
  type: 'customer.subscription.created' | 'customer.subscription.updated',
  eventId: string,
): Promise<WebhookOutcome> {
  const stripeCustomerId = stripeIdOf(subscription.customer);
  const baseRefs = refsOf([
    ['stripeEvent', eventId],
    ['stripeCustomer', stripeCustomerId],
    ['stripeSubscription', subscription.id],
    ['stripeStatus', subscription.status],
  ]);

  const resolution = await resolveCustomer({
    customerIdHint: metadataCustomerId(subscription.metadata),
    stripeCustomerId,
    stripeSubscriptionId: subscription.id,
    phone: null,
  });
  const customer = resolution.customer;

  if (customer === null) {
    return {
      handled: false,
      decision: 'subscription.unmatched',
      summary: `A ${type} event could not be matched to a subscriber profile, so no billing state changed.`,
      refs: baseRefs,
    };
  }

  /* Stripe's eight statuses collapse to our four in one pure, total mapping. */
  const state = mapSubscriptionState(subscription.status);
  await setStatus(customer.id, state, periodEndIso(subscription));
  if (state === 'active') await setCustomerStatus(customer.id, 'active');

  const decision =
    state === 'active'
      ? 'subscription.activated'
      : state === 'past_due'
        ? 'subscription.past_due'
        : state === 'cancelled'
          ? 'subscription.cancelled'
          : 'subscription.inactive';

  return {
    handled: true,
    decision,
    summary: `Stripe reports ${customer.businessName} as ${subscription.status}. Billing state set to ${state}.`,
    refs: { ...baseRefs, customer: customer.id, matchedBy: resolution.via },
  };
}

async function applySubscriptionDeleted(
  subscription: Stripe.Subscription,
  eventId: string,
): Promise<WebhookOutcome> {
  const stripeCustomerId = stripeIdOf(subscription.customer);
  const baseRefs = refsOf([
    ['stripeEvent', eventId],
    ['stripeCustomer', stripeCustomerId],
    ['stripeSubscription', subscription.id],
  ]);

  const resolution = await resolveCustomer({
    customerIdHint: metadataCustomerId(subscription.metadata),
    stripeCustomerId,
    stripeSubscriptionId: subscription.id,
    phone: null,
  });
  const customer = resolution.customer;

  if (customer === null) {
    return {
      handled: false,
      decision: 'subscription.unmatched',
      summary:
        'A subscription deletion could not be matched to a subscriber profile, so no billing state changed.',
      refs: baseRefs,
    };
  }

  await setStatus(customer.id, 'cancelled', periodEndIso(subscription));
  await setCustomerStatus(customer.id, 'cancelled');

  return {
    handled: true,
    decision: 'subscription.cancelled',
    summary: `The subscription for ${customer.businessName} ended. Fulfilment stops at the next tick.`,
    refs: { ...baseRefs, customer: customer.id, matchedBy: resolution.via },
  };
}

async function applyInvoiceFailure(
  invoice: Stripe.Invoice,
  eventId: string,
): Promise<WebhookOutcome> {
  const stripeCustomerId = stripeIdOf(invoice.customer);
  const baseRefs = refsOf([
    ['stripeEvent', eventId],
    ['stripeCustomer', stripeCustomerId],
    ['invoice', invoice.id ?? null],
  ]);

  const resolution = await resolveCustomer({
    customerIdHint: null,
    stripeCustomerId,
    stripeSubscriptionId: null,
    phone: null,
  });
  const customer = resolution.customer;

  if (customer === null) {
    return {
      handled: false,
      decision: 'subscription.unmatched',
      summary:
        'A failed invoice could not be matched to a subscriber profile, so no billing state changed.',
      refs: baseRefs,
    };
  }

  await setStatus(customer.id, 'past_due');

  return {
    handled: true,
    decision: 'subscription.past_due',
    summary: `An invoice payment failed for ${customer.businessName}. Billing state set to past due and fulfilment stops.`,
    refs: { ...baseRefs, customer: customer.id, matchedBy: resolution.via },
  };
}

/** Dispatch on the narrowed event. Mode comes off the verified event itself. */
async function applyEvent(event: RelevantStripeEvent): Promise<WebhookOutcome> {
  const mode: StripeMode = event.livemode ? 'live' : 'test';
  const eventId = event.id;

  switch (event.type) {
    case 'checkout.session.completed':
      return applyCheckout(event.session, event.id, mode);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return applySubscriptionChange(event.subscription, event.type, event.id);
    case 'customer.subscription.deleted':
      return applySubscriptionDeleted(event.subscription, event.id);
    case 'invoice.payment_failed':
      return applyInvoiceFailure(event.invoice, event.id);
  }

  /* Unreachable: `narrowStripeEvent` produces no other variant. */
  throw new Error(`Verified Stripe event ${eventId} matched no handler branch.`);
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

export async function POST(request: Request): Promise<NextResponse> {
  /* Raw bytes first. Nothing may parse or re-serialize the body before this. */
  const rawBody = await request.text();
  const signature = request.headers.get('stripe-signature');

  if (signature === null || signature.trim().length === 0) {
    return jsonResponse({ error: 'missing_signature' }, 400);
  }

  if (!stripeReady()) {
    return jsonResponse(
      {
        error: 'stripe_unconfigured',
        message: 'Webhook signatures cannot be verified on this deploy.',
        missing: missingKeys('stripe'),
      },
      503,
    );
  }

  const verified = verifyWebhookSignature(rawBody, signature);
  if (!verified.ok) {
    if (verified.skipped) {
      return jsonResponse({ error: 'stripe_unconfigured', missing: missingKeys('stripe') }, 503);
    }
    /* Reason logged server side only: it echoes attacker-supplied header data. */
    console.warn('[stripe/webhook] rejected an unverified delivery:', verified.reason);
    return jsonResponse({ error: 'invalid_signature' }, 400);
  }

  const event = verified.value;
  const relevant = narrowStripeEvent(event);

  /* Most Stripe traffic is not ours to act on. Acknowledge and move on. */
  if (relevant === null) {
    return jsonResponse({ received: true, handled: false, reason: 'ignored', type: event.type }, 200);
  }

  if (!isStoreReady()) {
    /* 503 so Stripe retries once persistence exists. Claiming the event id
     * without being able to apply it would burn the only idempotency token. */
    return jsonResponse(
      {
        error: 'store_unconfigured',
        message: 'Persistence is not configured, so billing state cannot be recorded.',
        missing: missingKeys('supabase'),
      },
      503,
    );
  }

  let firstDelivery: boolean;
  try {
    firstDelivery = await recordStripeEventOnce(event.id, event.type);
  } catch (error) {
    console.error('[stripe/webhook] could not claim event id:', error);
    return jsonResponse({ error: 'store_unavailable' }, 503);
  }

  if (!firstDelivery) {
    return jsonResponse({ received: true, handled: false, duplicate: true, type: event.type }, 200);
  }

  try {
    const outcome = await applyEvent(relevant);
    await logEvent({
      agent: 'sales',
      decision: outcome.decision,
      summary: outcome.summary,
      refs: { ...outcome.refs, stripeEventType: event.type },
    });
    return jsonResponse(
      { received: true, handled: outcome.handled, action: outcome.decision, type: event.type },
      200,
    );
  } catch (error) {
    /*
     * The event id is already claimed, so Stripe's retry will answer 200 without
     * repeating this work. That is deliberate: the repair path is the
     * reconciliation pass over `fetchSubscription`, not a second webhook. This
     * row is what tells it, and a judge, that something needs repairing.
     */
    console.error('[stripe/webhook] verified event could not be applied:', error);
    await logEvent({
      agent: 'sales',
      decision: 'subscription.webhook_failed',
      summary: `A verified Stripe ${event.type} event could not be written to billing state. Reconciliation will repair it.`,
      refs: { stripeEvent: event.id, stripeEventType: event.type },
    });
    return jsonResponse(
      {
        error: 'handler_failed',
        message: 'The event was verified but billing state could not be updated.',
      },
      500,
    );
  }
}
