/**
 * Stripe adapter: webhook verification, event narrowing, and honest mode reporting.
 *
 * Billing state is deterministic code, never model output (CLAUDE.md hard rule #2).
 * Nothing in this file asks anything to reason. It verifies a signature, narrows
 * the five event types the company acts on, and maps Stripe's subscription status
 * vocabulary onto the four values the `subscriptions` table allows.
 *
 * Three notes that matter on event day:
 *
 * - `stripeMode()` is derived from the key prefix in `deployment-env`, not from a
 *   separate flag, so the badge on the dashboard cannot disagree with the key
 *   actually in use. The eligibility rule requires the demo checkout to run live,
 *   and the only defensible way to show that is to read it off the live key.
 * - `verifyWebhookSignature` takes the RAW body. Next.js route handlers must read
 *   `await request.text()` and pass that string through untouched. A parsed and
 *   re-serialized body will not verify, and that failure looks like a Stripe
 *   outage when it is actually a route bug.
 * - An unverified event is never trusted. Signature failure returns a typed
 *   failure result; the caller answers 400 and writes nothing.
 *
 * Capability gated on `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET`. Unconfigured
 * is a skipped result, never a throw at import time.
 */
import Stripe from 'stripe';

import { hasCapability, missingKeys, optionalEnv, requireEnv, stripeMode } from '@/lib/config/deployment-env';

/* Passthrough so the UI can render test vs live without importing config. */
export { stripeMode };

/** See `AnthropicResult` for why "skipped" and "failed" stay distinguishable. */
export type StripeResult<T> =
  | { ok: true; skipped: false; value: T }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; reason: string };

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Cached client keyed on the secret key. `apiVersion` is deliberately left to the
 * SDK default: pinning the literal here would break `tsc` on any SDK bump for no
 * behavioural gain, since the SDK default IS the version its types describe.
 */
let cached: { secretKey: string; client: Stripe } | null = null;

function getClient(): Stripe {
  const secretKey = requireEnv('STRIPE_SECRET_KEY');
  if (cached !== null && cached.secretKey === secretKey) return cached.client;

  const client = new Stripe(secretKey, {
    typescript: true,
    appInfo: { name: 'LeadVelocity', version: '0.1.0' },
  });
  cached = { secretKey, client };
  return client;
}

/** True when Stripe calls and webhook verification would actually work. */
export function stripeReady(): boolean {
  return hasCapability('stripe');
}

function skipped<T>(): StripeResult<T> {
  return {
    ok: false,
    skipped: true,
    reason: `stripe capability unconfigured (missing: ${missingKeys('stripe').join(', ')})`,
  };
}

/* -------------------------------------------------------------------------- */
/* Checkout                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Payment Link the sample message points at.
 *
 * Configured rather than created at runtime: the link is a durable object set up
 * once in the dashboard, and creating one per send would leave a trail of orphans.
 * Returns null when unset so the caller can log a skipped decision instead of
 * texting a broken URL.
 */
export function checkoutUrl(): string | null {
  return optionalEnv('STRIPE_PAYMENT_LINK_URL');
}

/* -------------------------------------------------------------------------- */
/* Webhook verification                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Verify a webhook signature and return the parsed event.
 *
 * @param rawBody   The exact bytes Stripe posted. Not a re-serialized object.
 * @param signature The `stripe-signature` header.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signature: string,
): StripeResult<Stripe.Event> {
  if (!stripeReady()) return skipped<Stripe.Event>();

  const secret = requireEnv('STRIPE_WEBHOOK_SECRET');
  try {
    const event = getClient().webhooks.constructEvent(rawBody, signature, secret);
    return { ok: true, skipped: false, value: event };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { ok: false, skipped: false, reason: `stripe signature verification failed: ${message}` };
  }
}

/* -------------------------------------------------------------------------- */
/* Event narrowing                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The only Stripe events this company acts on.
 *
 * Everything else is acknowledged with 200 and ignored. Stripe sends a great deal
 * more than this and treating an unrecognized type as an error would turn normal
 * traffic into a red dashboard.
 */
export const RELEVANT_STRIPE_EVENT_TYPES = [
  'checkout.session.completed',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
] as const;

export type RelevantStripeEventType = (typeof RELEVANT_STRIPE_EVENT_TYPES)[number];

/** Fields every narrowed event carries, including the id used for idempotency. */
interface StripeEventEnvelope {
  /** Stripe event id. Insert into `stripe_events` first; a duplicate is a no-op. */
  id: string;
  /** Stripe's creation timestamp, seconds since epoch. */
  created: number;
  /** Which account mode produced this event, straight off the event itself. */
  livemode: boolean;
}

/**
 * A verified event we know how to handle, with its payload already narrowed to a
 * concrete Stripe type. The union means a handler cannot read `.subscription` off
 * a checkout event without the compiler objecting.
 */
export type RelevantStripeEvent =
  | (StripeEventEnvelope & { type: 'checkout.session.completed'; session: Stripe.Checkout.Session })
  | (StripeEventEnvelope & {
      type: 'customer.subscription.created' | 'customer.subscription.updated' | 'customer.subscription.deleted';
      subscription: Stripe.Subscription;
    })
  | (StripeEventEnvelope & { type: 'invoice.payment_failed'; invoice: Stripe.Invoice });

/** True for the five types the company acts on. */
export function isRelevantEventType(type: string): type is RelevantStripeEventType {
  return (RELEVANT_STRIPE_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Narrow a verified event, or return null when it is one we deliberately ignore.
 *
 * Null is the expected outcome for most webhook traffic and is not a failure.
 */
export function narrowStripeEvent(event: Stripe.Event): RelevantStripeEvent | null {
  const envelope: StripeEventEnvelope = {
    id: event.id,
    created: event.created,
    livemode: event.livemode,
  };

  switch (event.type) {
    case 'checkout.session.completed':
      return { ...envelope, type: event.type, session: event.data.object };
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return { ...envelope, type: event.type, subscription: event.data.object };
    case 'invoice.payment_failed':
      return { ...envelope, type: event.type, invoice: event.data.object };
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Billing state mapping                                                      */
/* -------------------------------------------------------------------------- */

/** The four values the `subscriptions.status` check constraint allows. */
export type SubscriptionState = 'inactive' | 'active' | 'past_due' | 'cancelled';

/**
 * Map Stripe's eight subscription statuses onto our four.
 *
 * Pure and total: every Stripe status has an explicit destination, so a new value
 * from Stripe lands in `inactive` rather than silently keeping an account live.
 * Only `active` accounts are fulfilled by the Lead Agent, which makes this the
 * function that decides whether a subscriber gets served. Deterministic by
 * requirement, never model output.
 *
 * `trialing` maps to `active` because a trialing account is entitled to delivery.
 * `paused` and `incomplete` map to `inactive` because they are not.
 */
export function mapSubscriptionState(status: Stripe.Subscription.Status): SubscriptionState {
  switch (status) {
    case 'active':
    case 'trialing':
      return 'active';
    case 'past_due':
    case 'unpaid':
      return 'past_due';
    case 'canceled':
    case 'incomplete_expired':
      return 'cancelled';
    case 'incomplete':
    case 'paused':
      return 'inactive';
    default:
      return 'inactive';
  }
}

/** Read an id off a field Stripe types as `string | object | null`. */
export function stripeIdOf(value: string | { id: string } | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : value.id;
}

/**
 * Fetch a subscription by id, for the reconciliation pass that repairs state when
 * a webhook was missed. Returns a skipped result when Stripe is unconfigured.
 */
export async function fetchSubscription(subscriptionId: string): Promise<StripeResult<Stripe.Subscription>> {
  if (!stripeReady()) return skipped<Stripe.Subscription>();
  try {
    const subscription = await getClient().subscriptions.retrieve(subscriptionId);
    return { ok: true, skipped: false, value: subscription };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { ok: false, skipped: false, reason: `stripe subscription fetch failed: ${message}` };
  }
}
