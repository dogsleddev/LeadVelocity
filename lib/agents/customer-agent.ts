/**
 * The Customer Agent: the subscriber's replies become the scorer's weights.
 *
 * WHAT THIS IS
 * ------------
 * The only feedback loop in the company that is driven by a human. A subscriber
 * texts back one of three words about a delivered opportunity, the inbound webhook
 * for whichever channel carried the message records it on
 * `opportunities.feedback`, and this agent turns that verdict into a bounded
 * change to `customers.effective_weights`, which the deterministic scorer reads on
 * the very next tick.
 *
 * This agent is channel-neutral by construction. It reads `opportunities` and
 * writes `customers`, so it neither knows nor cares whether the reply arrived over
 * Linq or Twilio, and it holds no import from either integration. Which channel is
 * live is `lib/delivery/channel.ts`'s business and nobody else's.
 *
 * The vocabulary is exactly `good | too_small | wrong_scope` (`core.ts`). Anything
 * richer would be inventing input the contractor never gave.
 *
 * WHY THE ARITHMETIC IS IN CODE
 * -----------------------------
 * CLAUDE.md hard rule #2. A model is not asked what "too small" should do to the
 * value weight, because that answer must be reproducible, bounded, and legible in
 * the decision log. {@link adjustWeights} is a pure function of (weights,
 * feedback): the same reply always moves the same numbers by the same amount, and
 * a judge can check the arithmetic by hand from the before and after in the log.
 *
 * WHY THE BOUNDS EXIST
 * --------------------
 * Weights are clamped to 0.5 to 1.5. A subscriber who replies `too_small` nine
 * times in a row should end up with a strong value preference, not a scorer whose
 * value component has eaten the other four. The scorer clamps again at 0 to 3 on
 * its own side, so this range sits comfortably inside its tolerance.
 *
 * IDEMPOTENCE
 * -----------
 * There is no "feedback processed" column in the schema, and adding one would be
 * a migration this agent does not need. Instead the agent reads its own decision
 * log: an opportunity whose id already appears in a `feedback.applied` or
 * `feedback.noop` ref has been handled. The events table is append-only and
 * indexed on (agent, ts), so this is a cheap, honest source of truth, and it has
 * the pleasant property that the audit trail and the idempotence key are the same
 * artefact.
 */
import { envInt } from '@/lib/config/deployment-env';
import type { Feedback } from '@/lib/domain/schemas/core';
import {
  getCustomer,
  listEvents,
  listOpportunities,
  updateEffectiveWeights,
  type EffectiveWeights,
  type OpportunityRecord,
} from '@/lib/store';

import { round2, runTick, type TickContext, type TickResult } from './tick';

/* -------------------------------------------------------------------------- */
/* Bounds and the adjustment table                                            */
/* -------------------------------------------------------------------------- */

/** Lower bound on any effective weight. A component is never switched off. */
export const WEIGHT_FLOOR = 0.5;

/** Upper bound on any effective weight. No component ever swamps the other four. */
export const WEIGHT_CEILING = 1.5;

/**
 * How far a `good` reply pulls every weight back toward the subscriber's stated
 * intent of 1.0. The tuning exists to correct a mismatch; a hit means there is
 * less mismatch left to correct.
 */
export const GOOD_REGRESSION = 0.25;

/**
 * Signed moves for the two corrective replies.
 *
 * `too_small` means the job was not worth the drive: raise the weight on value
 * relative to the subscriber's floor, and on absolute demand, and take a little
 * off timing so a fresh but trivial permit stops outranking a large older one.
 *
 * `wrong_scope` means the job was the wrong kind of work: raise fit, which is the
 * component that reads use category and trade language, and raise evidence, since
 * a wrong-scope hit usually means the read was thin rather than wrong.
 */
export const FEEDBACK_DELTAS: Readonly<Record<Exclude<Feedback, 'good'>, Readonly<Partial<EffectiveWeights>>>> =
  Object.freeze({
    too_small: Object.freeze({ value: 0.2, demand: 0.1, timing: -0.05 }),
    wrong_scope: Object.freeze({ fit: 0.25, evidence: 0.1, demand: -0.05 }),
  });

const COMPONENTS = ['fit', 'demand', 'timing', 'value', 'evidence'] as const;
type Component = (typeof COMPONENTS)[number];

function clampWeight(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return round2(Math.min(WEIGHT_CEILING, Math.max(WEIGHT_FLOOR, value)));
}

/**
 * Apply one piece of feedback to a weight set.
 *
 * PURE: no clock, no network, no randomness. Same weights plus same reply always
 * produce the same weights out, which is what makes the before and after in the
 * decision log checkable rather than merely displayed.
 */
export function adjustWeights(current: EffectiveWeights, feedback: Feedback): EffectiveWeights {
  const next = {} as Record<Component, number>;

  if (feedback === 'good') {
    for (const component of COMPONENTS) {
      const value = current[component];
      const safe = Number.isFinite(value) ? value : 1;
      next[component] = clampWeight(safe + (1 - safe) * GOOD_REGRESSION);
    }
    return next;
  }

  const deltas = FEEDBACK_DELTAS[feedback];
  for (const component of COMPONENTS) {
    const value = current[component];
    const safe = Number.isFinite(value) ? value : 1;
    next[component] = clampWeight(safe + (deltas[component] ?? 0));
  }
  return next;
}

/** `fit 1.00, demand 1.00, timing 1.00, value 1.20, evidence 1.00` */
export function describeWeights(weights: EffectiveWeights): string {
  return COMPONENTS.map((component) => `${component} ${weights[component].toFixed(2)}`).join(', ');
}

/** True when a reply would not move a single component, e.g. every weight is at a bound. */
export function weightsUnchanged(before: EffectiveWeights, after: EffectiveWeights): boolean {
  return COMPONENTS.every((component) => before[component] === after[component]);
}

/** Only the components that actually moved, e.g. `value 1.00 to 1.20`. */
export function describeChange(before: EffectiveWeights, after: EffectiveWeights): string {
  const moved = COMPONENTS.filter((component) => before[component] !== after[component]).map(
    (component) => `${component} ${before[component].toFixed(2)} to ${after[component].toFixed(2)}`,
  );
  return moved.length === 0 ? 'no component moved' : moved.join(', ');
}

/* -------------------------------------------------------------------------- */
/* Which feedback has already been acted on                                   */
/* -------------------------------------------------------------------------- */

/** Decisions that mean "this opportunity's reply has been dealt with". */
const SETTLED_DECISIONS: ReadonlySet<string> = new Set(['feedback.applied', 'feedback.noop']);

/** How far back the idempotence scan reads. */
const historyLimit = (): number => envInt('CUSTOMER_HISTORY_LIMIT', 200);

/** How many replies one tick will act on. */
const batchLimit = (): number => envInt('CUSTOMER_BATCH_SIZE', 10);

/** How many recent opportunities are examined for an unhandled reply. */
const scanLimit = (): number => envInt('CUSTOMER_SCAN_LIMIT', 100);

/**
 * Opportunity ids this agent has already settled, read out of its own log.
 *
 * A window rather than the whole history: the events table is append-only and
 * grows for the life of the demo, and a reply older than the window has long
 * since been applied.
 */
async function settledOpportunityIds(): Promise<Set<string>> {
  const history = await listEvents({ agent: 'customer', limit: historyLimit() });
  const settled = new Set<string>();
  for (const event of history) {
    if (!SETTLED_DECISIONS.has(event.decision)) continue;
    const id = event.refs['opportunity'];
    if (id !== undefined && id.length > 0) settled.add(id);
  }
  return settled;
}

/* -------------------------------------------------------------------------- */
/* The tick                                                                   */
/* -------------------------------------------------------------------------- */

/** What one Customer tick got through, for the scheduler's console line. */
export interface CustomerTickSummary {
  scanned: number;
  withFeedback: number;
  applied: number;
  alreadySettled: number;
}

/**
 * One Customer Agent tick.
 *
 * Reads recent opportunities, finds the ones carrying a reply this agent has not
 * yet acted on, and applies each in turn. Every reply produces exactly one
 * decision carrying the numbers before and the numbers after, so the learning is
 * a readable trail rather than a claim.
 */
export async function customerAgentTick(): Promise<TickResult<CustomerTickSummary>> {
  return runTick('customer', async (ctx) => runCustomerTick(ctx));
}

async function runCustomerTick(ctx: TickContext): Promise<CustomerTickSummary> {
  const summary: CustomerTickSummary = { scanned: 0, withFeedback: 0, applied: 0, alreadySettled: 0 };

  /* --- 2. pull work ------------------------------------------------------ */
  const opportunities = await listOpportunities({ limit: scanLimit() });
  summary.scanned = opportunities.length;

  const withFeedback = opportunities.filter(
    (opportunity): opportunity is OpportunityRecord & { feedback: Feedback } =>
      opportunity.feedback !== null,
  );
  summary.withFeedback = withFeedback.length;

  if (withFeedback.length === 0) {
    await ctx.decide({
      decision: 'feedback.none',
      summary: `Read the ${summary.scanned} most recent opportunities and found no new reply from the subscriber, so the scoring weights were left exactly as they are.`,
    });
    return summary;
  }

  const settled = await settledOpportunityIds();
  /* Oldest reply first, so a run of replies applies in the order it arrived. */
  const pending = withFeedback
    .filter((opportunity) => !settled.has(opportunity.id))
    .sort((a, b) => (a.feedbackAt ?? a.createdAt).localeCompare(b.feedbackAt ?? b.createdAt));
  summary.alreadySettled = withFeedback.length - pending.length;

  if (pending.length === 0) {
    await ctx.decide({
      decision: 'feedback.none',
      summary: `All ${withFeedback.length} replies on recent opportunities have already been folded into the scoring weights, so nothing changed this tick.`,
    });
    return summary;
  }

  /* --- 3 and 4. decide and act, one reply at a time ---------------------- */
  const batch = pending.slice(0, batchLimit());

  for (const opportunity of batch) {
    const customer = await getCustomer(opportunity.customerId);
    if (customer === null) {
      await ctx.decide({
        decision: 'feedback.noop',
        summary: `A reply of "${opportunity.feedback}" arrived for an opportunity whose subscriber profile no longer exists, so no weight was changed.`,
        refs: { opportunity: opportunity.id, customer: opportunity.customerId },
      });
      continue;
    }

    const before = customer.effectiveWeights;
    const after = adjustWeights(before, opportunity.feedback);
    const change = describeChange(before, after);

    if (weightsUnchanged(before, after)) {
      await ctx.decide({
        decision: 'feedback.noop',
        summary: `Reply "${opportunity.feedback}" on the ${opportunity.score} point job left the weights where they already sit at their bounds: ${describeWeights(after)}.`,
        refs: {
          opportunity: opportunity.id,
          customer: customer.id,
          feedback: opportunity.feedback,
        },
      });
      summary.applied += 1;
      continue;
    }

    await updateEffectiveWeights(customer.id, after);
    summary.applied += 1;

    await ctx.decide({
      decision: 'feedback.applied',
      summary: `${customer.businessName} replied "${opportunity.feedback}" to the ${opportunity.score} point job, so the scoring weights moved ${change}. Now ${describeWeights(after)}.`,
      refs: {
        opportunity: opportunity.id,
        customer: customer.id,
        feedback: opportunity.feedback,
        before: describeWeights(before),
        after: describeWeights(after),
      },
    });
  }

  if (pending.length > batch.length) {
    await ctx.decide({
      decision: 'feedback.deferred',
      summary: `${pending.length - batch.length} further replies are queued and will be folded in on the next tick.`,
    });
  }

  return summary;
}
