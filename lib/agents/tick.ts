/**
 * The shared tick harness every agent runs inside.
 *
 * Origin: worker-loop and degrade-never-crash posture adapted from SiteVelocity
 * (https://github.com/samshanmukh/SiteVelocity).
 *
 * WHAT THIS IS
 * ------------
 * `runTick` is the only way an agent body is ever executed. It fixes the order of
 * operations for all four agents so the ordering cannot drift between them:
 *
 *   1. check the kill switch (CLAUDE.md hard rule #7)
 *   2. pull work
 *   3. decide
 *   4. act
 *   5. log the decision (CLAUDE.md hard rule #6)
 *
 * Steps 2 to 4 are the agent's body. Steps 1 and 5 are this file's, and they are
 * not optional, which is the point of putting them here instead of trusting four
 * separate implementations to remember.
 *
 * THREE GUARANTEES
 * ----------------
 * 1. KILL SWITCH FIRST. Nothing else happens until the switch has been read. When
 *    it is on the tick returns `halted` immediately and writes NOTHING, not even a
 *    "we were halted" row: a stopped company that keeps filling the decision log
 *    is not stopped, and an operator watching the log needs the silence to be
 *    legible.
 *
 * 2. EVERY TICK LEAVES A TRACE. Hard rule #6 says every agent decision is logged.
 *    A tick that decided nothing still decided something: it decided there was no
 *    work. If an agent body returns without logging, the harness writes
 *    `tick.no_work` on its behalf, so no execution path can run silently.
 *
 * 3. A BAD RECORD NEVER KILLS A WORKER. The body runs inside a try/catch. A thrown
 *    error is caught, summarised into a `tick.failed` decision, and returned as a
 *    typed result. The loop in `scripts/workers.ts` schedules the next tick and the
 *    company keeps running.
 *
 * WHAT IT IS NOT
 * --------------
 * It is not a scheduler (that is `scripts/workers.ts`), it is not a queue, and it
 * is not a fifth agent. It is a function that wraps four functions.
 */
import { killSwitchDefault } from '@/lib/config/deployment-env';
import type { AgentName } from '@/lib/domain/schemas/core';
import { isKillSwitchOn, logEvent } from '@/lib/store';

/* -------------------------------------------------------------------------- */
/* Result vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * How a tick ended.
 *
 * - `ran`    the body completed. It may still have decided to do nothing.
 * - `halted` the kill switch was on. The body never executed.
 * - `failed` the body threw. The failure is logged and the worker survives.
 */
export type TickStatus = 'ran' | 'halted' | 'failed';

/** One decision, as an agent hands it to the harness. */
export interface TickDecision {
  /** Short machine-ish verb, e.g. `shortlist.rejected`, `opportunity.delivered`. */
  decision: string;
  /** One sentence a judge can read without context. No em dashes. */
  summary: string;
  /** Pointers to the rows this decision touched. Values are stringified. */
  refs?: Readonly<Record<string, string | number | boolean | null | undefined>>;
}

/** What the body is handed. The only clock and the only log an agent should use. */
export interface TickContext {
  readonly agent: AgentName;
  /** Frozen tick clock. Pure helpers take this rather than reading `Date.now()`. */
  readonly now: Date;
  /** `now` as an ISO 8601 instant, for Findings and the scorer. */
  readonly nowIso: string;
  /** Append one decision to the log. Never throws. */
  decide(input: TickDecision): Promise<void>;
  /** How many decisions this tick has logged so far. */
  decisionCount(): number;
}

/** Everything the scheduler needs to print one structured line. */
export interface TickResult<T = unknown> {
  agent: AgentName;
  status: TickStatus;
  startedAt: string;
  durationMs: number;
  /** Rows appended to `events` by this tick. */
  decisions: number;
  /** Whatever the body returned, or `null` on `halted` / `failed`. */
  value: T | null;
  /** Failure text on `failed`, otherwise `null`. */
  error: string | null;
}

/* -------------------------------------------------------------------------- */
/* Text hygiene                                                               */
/* -------------------------------------------------------------------------- */

/** Longest summary written to the log. Long enough to explain, short to scan. */
const SUMMARY_LIMIT = 400;

/**
 * Make any string safe to store as an event summary.
 *
 * Summaries carry model rationale, agency descriptions, and error text, none of
 * which is under our editorial control. Three fixes are applied: whitespace is
 * collapsed so a multi-line error renders as one row, em dashes become commas
 * (judge-facing copy convention), and the result is length capped. An empty
 * result is replaced, because `events.summary` is `not null` and the schema
 * demands at least one character.
 */
export function sanitizeSummary(text: string, fallback = 'No summary supplied.'): string {
  const flattened = text.replace(/[—―]/g, ', ').replace(/\s+/g, ' ').trim();
  if (flattened.length === 0) return fallback;
  if (flattened.length <= SUMMARY_LIMIT) return flattened;
  return `${flattened.slice(0, SUMMARY_LIMIT - 3).trimEnd()}...`;
}

/**
 * Coerce a loose ref bag into the `Record<string, string>` the store accepts.
 *
 * Absent values are dropped rather than rendered as the string "null", so a ref
 * that is present is always a real pointer.
 */
export function toRefs(
  refs: Readonly<Record<string, string | number | boolean | null | undefined>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (refs === undefined) return out;
  for (const [key, value] of Object.entries(refs)) {
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (text.length > 0) out[key] = text;
  }
  return out;
}

/** Error text for a log line, without leaking a stack trace into the database. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim().length > 0 ? `${error.name}: ${error.message}` : error.name;
  }
  if (typeof error === 'string' && error.trim().length > 0) return error;
  return 'unknown error';
}

/* -------------------------------------------------------------------------- */
/* The harness                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Run one tick for one agent.
 *
 * @param agent which of the four agents is running. There is no fifth.
 * @param run   the agent body: pull work, decide, act. Use `ctx.decide` to log.
 *
 * The body's return value is passed through on `value` so the scheduler can print
 * a useful line, but nothing in the system depends on it: the durable record of
 * what happened is the `events` rows, not the return value.
 */
export async function runTick<T>(
  agent: AgentName,
  run: (ctx: TickContext) => Promise<T>,
): Promise<TickResult<T>> {
  const startedMs = Date.now();
  const now = new Date(startedMs);
  const startedAt = now.toISOString();

  /* --- 1. kill switch --------------------------------------------------- */
  /*
   * `isKillSwitchOn` already swallows its own failures and answers with the
   * configured default, but it is wrapped anyway: this is the one call that must
   * not be able to throw, because a throw here would run the body of a company
   * that an operator has switched off.
   */
  let halted: boolean;
  try {
    halted = await isKillSwitchOn();
  } catch {
    halted = killSwitchDefault();
  }

  if (halted) {
    return {
      agent,
      status: 'halted',
      startedAt,
      durationMs: Date.now() - startedMs,
      decisions: 0,
      value: null,
      error: null,
    };
  }

  /* --- 2 to 5. pull, decide, act, log ----------------------------------- */
  let logged = 0;

  const decide = async (input: TickDecision): Promise<void> => {
    const result = await logEvent({
      agent,
      decision: input.decision,
      summary: sanitizeSummary(input.summary),
      refs: toRefs(input.refs),
      ts: new Date().toISOString(),
    });
    /*
     * `logEvent` never throws; it reports failure in the return value. Count only
     * rows that actually landed, so the scheduler's per-tick line does not claim
     * a decision log that a judge cannot then find in the table.
     */
    if (result.persisted) logged += 1;
  };

  const ctx: TickContext = {
    agent,
    now,
    nowIso: startedAt,
    decide,
    decisionCount: () => logged,
  };

  try {
    const value = await run(ctx);

    /* Guarantee 2: no execution path runs silently. */
    if (logged === 0) {
      await decide({
        decision: 'tick.no_work',
        summary: `The ${agent} agent found nothing to act on this tick and made no changes.`,
      });
    }

    return {
      agent,
      status: 'ran',
      startedAt,
      durationMs: Date.now() - startedMs,
      decisions: logged,
      value,
      error: null,
    };
  } catch (error) {
    const reason = describeError(error);
    /*
     * Guarantee 3. The failure is a decision like any other: it goes in the log
     * with the reason, and the tick returns cleanly so the loop continues.
     */
    await decide({
      decision: 'tick.failed',
      summary: `The ${agent} agent stopped this tick after an error and changed nothing further: ${reason}`,
    });

    return {
      agent,
      status: 'failed',
      startedAt,
      durationMs: Date.now() - startedMs,
      decisions: logged,
      value: null,
      error: reason,
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Small shared helpers for agent bodies                                      */
/* -------------------------------------------------------------------------- */

/**
 * Run one unit of work without letting it abort the rest of the tick.
 *
 * The Lead Agent processes a batch of permits; one malformed record must cost one
 * permit, not the batch. This is the per-record twin of the try/catch above, and
 * it logs the failure as a decision so the skipped record is visible rather than
 * quietly missing.
 */
export async function attempt<T>(
  ctx: TickContext,
  args: {
    /** Decision verb written when the unit fails, e.g. `candidate.failed`. */
    decision: string;
    /** What was being attempted, e.g. `permit 202603238106`. */
    subject: string;
    refs?: TickDecision['refs'];
    run: () => Promise<T>;
  },
): Promise<T | null> {
  try {
    return await args.run();
  } catch (error) {
    await ctx.decide({
      decision: args.decision,
      summary: `Skipped ${args.subject} after an error and moved on: ${describeError(error)}`,
      refs: args.refs,
    });
    return null;
  }
}

/** Round to two decimals. Used wherever a number lands in a summary line. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** `$8,285,917`. Hand rolled so log text cannot drift with the host locale. */
export function formatUsd(amount: number): string {
  const rounded = Math.round(amount);
  const digits = Math.abs(rounded).toString();
  return `${rounded < 0 ? '-' : ''}$${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
}
