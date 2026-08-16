/**
 * Stripe subscription state (`subscriptions`) and webhook idempotency
 * (`stripe_events`).
 *
 * Billing state is deterministic code, not agent judgement (hard rule #2). The
 * Lead Agent fulfils for a customer if and only if `hasActiveSubscription`
 * returns true; there is no model in that path and no heuristic about whether
 * someone "seems" paid up.
 *
 * Stripe is not a fifth agent (hard rule #4). It is a payment processor whose
 * webhooks this module reduces to a status column.
 *
 * Webhook idempotency is the reason `stripe_events` exists. Stripe retries
 * deliveries, sometimes hours later, and a retried `checkout.session.completed`
 * must not activate an account twice or restart a fulfilment run.
 * {@link recordStripeEventOnce} is the primitive every webhook handler calls
 * first: it returns true exactly once per Stripe event id, forever.
 */
import { z } from 'zod';

import { dbTimestamp, dbTimestampNullable, nowIso, parseRow, requireClient, unwrap, unwrapMaybe } from './client';

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

export const subscriptionStatusSchema = z.enum(['inactive', 'active', 'past_due', 'cancelled']);
export type SubscriptionStatus = z.infer<typeof subscriptionStatusSchema>;

/** Which Stripe account the row was created against. */
export const stripeModeSchema = z.enum(['test', 'live']);
export type StripeMode = z.infer<typeof stripeModeSchema>;

const subscriptionRowSchema = z.object({
  id: z.string().min(1),
  customer_id: z.string().min(1),
  stripe_customer_id: z.string().nullable(),
  stripe_subscription_id: z.string().nullable(),
  stripe_checkout_session_id: z.string().nullable(),
  status: subscriptionStatusSchema,
  mode: stripeModeSchema,
  current_period_end: dbTimestampNullable,
  updated_at: dbTimestamp,
});

export interface SubscriptionRecord {
  id: string;
  customerId: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeCheckoutSessionId: string | null;
  status: SubscriptionStatus;
  /**
   * `test` while building, `live` for the event-day checkout. Derived from the
   * key prefix by `stripeMode()` in deployment-env, so the recorded mode can
   * never disagree with the key that produced the row.
   */
  mode: StripeMode;
  currentPeriodEnd: string | null;
  updatedAt: string;
}

export interface ActivateFromStripeInput {
  customerId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string;
  checkoutSessionId?: string | null;
  mode: StripeMode;
  currentPeriodEnd?: string | null;
}

function toSubscription(row: unknown, context: string): SubscriptionRecord {
  const parsed = parseRow(subscriptionRowSchema, row, context);
  return {
    id: parsed.id,
    customerId: parsed.customer_id,
    stripeCustomerId: parsed.stripe_customer_id,
    stripeSubscriptionId: parsed.stripe_subscription_id,
    stripeCheckoutSessionId: parsed.stripe_checkout_session_id,
    status: parsed.status,
    mode: parsed.mode,
    currentPeriodEnd: parsed.current_period_end,
    updatedAt: parsed.updated_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/** The subscription row for a customer, or `null` if they never checked out. */
export async function getSubscriptionByCustomer(
  customerId: string,
): Promise<SubscriptionRecord | null> {
  const client = requireClient('getSubscriptionByCustomer');
  const row = unwrapMaybe(
    await client.from('subscriptions').select('*').eq('customer_id', customerId).maybeSingle(),
    'getSubscriptionByCustomer',
  );
  return row === null ? null : toSubscription(row, 'subscriptions');
}

/**
 * The gate on fulfilment.
 *
 * Status alone decides. `current_period_end` is stored for the dashboard but is
 * deliberately not consulted here: Stripe owns the lifecycle and tells us via
 * `customer.subscription.updated` when a period lapses. Second-guessing that
 * with a local clock comparison would let a clock-skewed worker cut off a paying
 * customer.
 */
export async function hasActiveSubscription(customerId: string): Promise<boolean> {
  const subscription = await getSubscriptionByCustomer(customerId);
  return subscription !== null && subscription.status === 'active';
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Activate a customer from a completed Stripe checkout.
 *
 * Keyed on `customer_id`, which is unique, so a retried webhook that slipped
 * past the idempotency check still converges on one row in one state.
 */
export async function activateFromStripe(
  input: ActivateFromStripeInput,
): Promise<SubscriptionRecord> {
  const client = requireClient('activateFromStripe');
  const mode = stripeModeSchema.parse(input.mode);

  const row = unwrap(
    await client
      .from('subscriptions')
      .upsert(
        {
          customer_id: input.customerId,
          stripe_customer_id: input.stripeCustomerId,
          stripe_subscription_id: input.stripeSubscriptionId,
          stripe_checkout_session_id: input.checkoutSessionId ?? null,
          status: 'active',
          mode,
          current_period_end: input.currentPeriodEnd ?? null,
          updated_at: nowIso(),
        },
        { onConflict: 'customer_id' },
      )
      .select('*')
      .single(),
    'activateFromStripe',
  );

  return toSubscription(row, 'subscriptions');
}

/**
 * Move a subscription between states on a lifecycle webhook.
 *
 * Creates the row when it is missing so a `customer.subscription.deleted` for a
 * customer whose activation was never recorded still lands somewhere truthful
 * instead of being silently dropped.
 */
export async function setStatus(
  customerId: string,
  status: SubscriptionStatus,
  currentPeriodEnd?: string | null,
): Promise<SubscriptionRecord> {
  const client = requireClient('setStatus');
  const validated = subscriptionStatusSchema.parse(status);

  const patch: {
    customer_id: string;
    status: SubscriptionStatus;
    updated_at: string;
    current_period_end?: string | null;
  } = { customer_id: customerId, status: validated, updated_at: nowIso() };

  if (currentPeriodEnd !== undefined) patch.current_period_end = currentPeriodEnd;

  const row = unwrap(
    await client
      .from('subscriptions')
      .upsert(patch, { onConflict: 'customer_id' })
      .select('*')
      .single(),
    'setStatus',
  );
  return toSubscription(row, 'subscriptions');
}

/* -------------------------------------------------------------------------- */
/* Webhook idempotency                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Claim a Stripe event id. Returns true the first time, false ever after.
 *
 * Implemented as `INSERT ... ON CONFLICT DO NOTHING RETURNING id`, so the claim
 * is decided by the primary key inside one statement. Two concurrent deliveries
 * of the same event cannot both win.
 *
 * Call this before doing anything else in a webhook handler, and do the work
 * only when it returns true.
 */
export async function recordStripeEventOnce(eventId: string, type: string): Promise<boolean> {
  const client = requireClient('recordStripeEventOnce');
  const inserted = unwrap(
    await client
      .from('stripe_events')
      .upsert({ id: eventId, type }, { onConflict: 'id', ignoreDuplicates: true })
      .select('id'),
    'recordStripeEventOnce',
  );
  return inserted.length > 0;
}
