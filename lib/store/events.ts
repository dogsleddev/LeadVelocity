/**
 * The append-only decision log (`events`).
 *
 * Hard rule #6: every agent decision writes one row here with ts, agent,
 * decision, summary, and refs. Hard rule #4 constrains `agent` to the four real
 * agents; the database repeats that constraint in a CHECK so a fifth agent
 * cannot be invented by a typo.
 *
 * Append-only is enforced by the `events_no_update` trigger, not by convention.
 * This module therefore exposes exactly two operations, insert and read, and no
 * update or delete path exists to be called by accident.
 *
 * Degradation: `logEvent` never throws. Losing the ability to narrate a decision
 * must not abort the decision itself, so a failed write is reported in the
 * return value and mirrored to stderr rather than raised. Callers that care can
 * inspect `persisted`.
 */
import { z } from 'zod';

import { type AgentEvent, type AgentName, agentNameSchema } from '@/lib/domain/schemas/core';

import { dbTimestamp, isStoreReady, nowIso, parseRows, requireClient, unwrap } from './client';

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

const eventRowSchema = z.object({
  id: z.union([z.number(), z.string()]).transform((value) => String(value)),
  ts: dbTimestamp,
  agent: agentNameSchema,
  decision: z.string().min(1),
  summary: z.string().min(1),
  refs: z.record(z.string(), z.string()),
});

function toEvent(row: z.infer<typeof eventRowSchema>): AgentEvent {
  return {
    id: row.id,
    ts: row.ts,
    agent: row.agent,
    decision: row.decision,
    summary: row.summary,
    refs: row.refs,
  };
}

/** What a caller supplies. `ts` and `refs` have sensible defaults. */
export interface LogEventInput {
  agent: AgentName;
  /** Short machine-ish verb, e.g. `shortlist.rejected`. */
  decision: string;
  /** One sentence a judge can read without context. No em dashes. */
  summary: string;
  /** Pointers to the rows this decision touched, e.g. `{ permit: '2026...' }`. */
  refs?: Record<string, string>;
  /** Override the timestamp, e.g. when replaying at an accelerated clock. */
  ts?: string;
}

/**
 * Outcome of a log write. `event` is always populated so a caller can render or
 * forward the decision even when persistence was unavailable.
 */
export type LogEventResult =
  | { persisted: true; event: AgentEvent }
  | { persisted: false; reason: 'store_unavailable' | 'write_failed'; event: AgentEvent };

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

/** Append one decision to the log. Never throws. */
export async function logEvent(input: LogEventInput): Promise<LogEventResult> {
  const draft: AgentEvent = {
    ts: input.ts ?? nowIso(),
    agent: input.agent,
    decision: input.decision,
    summary: input.summary,
    refs: input.refs ?? {},
  };

  if (!isStoreReady()) {
    console.warn(`[events] store unavailable, decision not persisted: ${draft.agent} ${draft.decision}`);
    return { persisted: false, reason: 'store_unavailable', event: draft };
  }

  try {
    const client = requireClient('logEvent');
    const rows = unwrap(
      await client
        .from('events')
        .insert({
          ts: draft.ts,
          agent: draft.agent,
          decision: draft.decision,
          summary: draft.summary,
          refs: draft.refs,
        })
        .select('*'),
      'logEvent',
    );
    const parsed = parseRows(eventRowSchema, rows, 'events');
    const stored = parsed[0];
    return { persisted: true, event: stored === undefined ? draft : toEvent(stored) };
  } catch (error) {
    console.error(
      `[events] failed to persist decision ${draft.agent} ${draft.decision}:`,
      error instanceof Error ? error.message : error,
    );
    return { persisted: false, reason: 'write_failed', event: draft };
  }
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

export interface ListEventsOptions {
  /** Newest N entries. Defaults to 50. */
  limit?: number;
  /** Restrict to one agent's decisions. */
  agent?: AgentName;
}

/**
 * Newest-first slice of the decision log.
 *
 * Ordered by `ts` then by `id` so entries written inside the same millisecond
 * (a tick that logs several decisions in a row) still come back in the order
 * they were appended rather than in whatever order Postgres happens to scan.
 */
export async function listEvents(options: ListEventsOptions = {}): Promise<AgentEvent[]> {
  if (!isStoreReady()) return [];

  const limit = options.limit ?? 50;
  const client = requireClient('listEvents');

  const base = client.from('events').select('*');
  const filtered = options.agent === undefined ? base : base.eq('agent', options.agent);

  const rows = unwrap(
    await filtered
      .order('ts', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit),
    'listEvents',
  );

  return parseRows(eventRowSchema, rows, 'events').map(toEvent);
}
