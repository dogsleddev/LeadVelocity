/**
 * Inbound contacts and the outbound queue (`inbound_contacts`, `outbound_queue`).
 *
 * These two tables exist because of one platform rule, not a design preference:
 * Linq's sandbox will only let the company message a handle that has texted the
 * Linq number first. So "may we message this person" is a question with a real
 * answer that has to be looked up before composing, and a message composed for
 * someone who has not made contact yet has to go somewhere honest.
 *
 *   `inbound_contacts`  who has texted us, when, how often, and whether they
 *                       asked us to stop. {@link isReachable} is the gate.
 *   `outbound_queue`    a message that was composed and is waiting on consent.
 *                       Status `waiting_for_inbound` means prepared, NOT sent.
 *
 * A queued row is never a delivery. `sent_at` and `message_id` are written by
 * {@link markQueuedSent} and only after a provider accepted the message, so
 * nothing in this module can make a held message look like a delivered one.
 *
 * Opt-out is one-way. {@link markOptedOut} sets it, nothing here clears it, and
 * a later sighting of the same handle bumps the counters without reviving
 * consent. Undoing an opt-out is a deliberate human act against the database,
 * which is the point.
 *
 * Handles are stored exactly as the delivery layer normalizes them
 * (`normalizeRecipient` in `lib/delivery/channel.ts`, which is `toHandle` for
 * Linq: E.164 or an Apple ID email). Callers pass that value on both the write
 * and the read side; this module trims and otherwise treats a handle as an
 * opaque key rather than inventing a second normalization that could disagree.
 */
import { z } from 'zod';

import { assertCustomerSafe } from '@/lib/copy/templates';

import {
  type Database,
  dbTimestamp,
  dbTimestampNullable,
  isUniqueViolation,
  nowIso,
  parseRow,
  parseRows,
  requireClient,
  StoreError,
  unwrap,
  unwrapCount,
  unwrapMaybe,
} from './client';

/* -------------------------------------------------------------------------- */
/* Table types                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The 0002 tables are declared in `client.ts` alongside the rest of the schema,
 * so this module needs no widening and no cast. This alias is readability only.
 *
 * Note for anyone editing those declarations: `Insert` marks every column with
 * a database default optional, and `Update` deliberately omits the columns that
 * must never move once the row exists. A handle is a primary key, a first
 * sighting cannot happen twice, and the body of a queued message is what the
 * company decided to say, not something a later tick may rewrite.
 */
type Tables = Database['public']['Tables'];

/**
 * The service-role client.
 *
 * Every function here uses {@link requireClient} rather than degrading to a
 * default, because there is no honest default. "Is this handle reachable" and
 * "is this message still waiting" are questions about stored state; answering
 * them from thin air when Postgres is unreachable would be a guess dressed as a
 * fact, and the gate it feeds decides whether a stranger gets a text.
 */
function tables(operation: string) {
  return requireClient(operation);
}

/** Lost-race retries on the read-modify-write paths. Mirrors `findings.ts`. */
const MAX_RACE_RETRIES = 3;

/* -------------------------------------------------------------------------- */
/* Shape: inbound contacts                                                    */
/* -------------------------------------------------------------------------- */

/** Mirrors the CHECK on `inbound_contacts.channel`, and `ChannelName`. */
export const inboundChannelSchema = z.enum(['linq', 'twilio']);
export type InboundChannel = z.infer<typeof inboundChannelSchema>;

const DEFAULT_CHANNEL: InboundChannel = 'linq';

const inboundContactRowSchema = z.object({
  handle: z.string().min(1),
  channel: inboundChannelSchema,
  chat_id: z.string().nullable(),
  first_seen_at: dbTimestamp,
  last_seen_at: dbTimestamp,
  message_count: z.number().int().nonnegative(),
  opted_out: z.boolean(),
  opted_out_at: dbTimestampNullable,
});

/** A handle that has messaged the company, and its consent state. */
export interface InboundContact {
  handle: string;
  channel: InboundChannel;
  /** Linq conversation id, when the webhook carried one. */
  chatId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Inbound messages seen from this handle. Never decreases. */
  messageCount: number;
  optedOut: boolean;
  optedOutAt: string | null;
}

export interface RecordInboundContactInput {
  /** Channel-normalized handle, e.g. the output of `normalizeRecipient`. */
  handle: string;
  /** Where the message arrived. Defaults to `linq`, matching the column. */
  channel?: InboundChannel;
  /** Conversation id from the webhook, when present. */
  chatId?: string | null;
}

function toContact(row: unknown, context: string): InboundContact {
  const parsed = parseRow(inboundContactRowSchema, row, context);
  return {
    handle: parsed.handle,
    channel: parsed.channel,
    chatId: parsed.chat_id,
    firstSeenAt: parsed.first_seen_at,
    lastSeenAt: parsed.last_seen_at,
    messageCount: parsed.message_count,
    optedOut: parsed.opted_out,
    optedOutAt: parsed.opted_out_at,
  };
}

/** Trim a handle for use as a key, refusing an empty one rather than storing it. */
function handleKey(raw: string, operation: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new StoreError(`${operation} requires a handle, received an empty string`);
  return trimmed;
}

/* -------------------------------------------------------------------------- */
/* Inbound contacts: writes                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Record that a handle has messaged us.
 *
 * First sighting inserts with `message_count` 1. A repeat bumps the count and
 * `last_seen_at`. `opted_out` is deliberately absent from both payloads: seeing
 * someone again is not consent, and this function must not be the way a stop
 * request gets undone.
 *
 * The insert runs as `ON CONFLICT DO NOTHING` so two concurrent webhook
 * deliveries cannot both believe they created the row; the loser falls through
 * to the bump path.
 */
export async function recordInboundContact(
  input: RecordInboundContactInput,
): Promise<InboundContact> {
  const handle = handleKey(input.handle, 'recordInboundContact');
  const channel = input.channel === undefined ? undefined : inboundChannelSchema.parse(input.channel);
  const chatId = input.chatId ?? null;
  const seenAt = nowIso();
  const client = tables('recordInboundContact');

  const inserted = unwrap(
    await client
      .from('inbound_contacts')
      .upsert(
        {
          handle,
          channel: channel ?? DEFAULT_CHANNEL,
          chat_id: chatId,
          first_seen_at: seenAt,
          last_seen_at: seenAt,
          message_count: 1,
        },
        { onConflict: 'handle', ignoreDuplicates: true },
      )
      .select('*'),
    'recordInboundContact (first sighting)',
  );

  const first = inserted[0];
  if (first !== undefined) return toContact(first, 'inbound_contacts');

  return bumpSighting({ handle, channel, chatId, seenAt }, 0);
}

interface BumpInput {
  handle: string;
  /** Only overwrites the stored channel when the caller actually knew it. */
  channel: InboundChannel | undefined;
  /** Only overwrites the stored chat id when non-null. Never clears one. */
  chatId: string | null;
  seenAt: string;
}

/**
 * Increment the sighting counter for a handle that already exists.
 *
 * PostgREST cannot express `message_count = message_count + 1`, and 0002 ships
 * no function to call, so this is a compare-and-set: read the count, write back
 * `count + 1` guarded on the value we read. A concurrent bump makes the guarded
 * update match zero rows, and we try again rather than silently clobbering it.
 */
async function bumpSighting(input: BumpInput, attempt: number): Promise<InboundContact> {
  const client = tables('recordInboundContact');

  const existingRow = unwrapMaybe(
    await client.from('inbound_contacts').select('*').eq('handle', input.handle).maybeSingle(),
    'recordInboundContact (read)',
  );

  if (existingRow === null) {
    // Nothing in this codebase deletes a contact, so the row can only be absent
    // if the insert above lost a race with something that then vanished.
    throw new StoreError(
      `recordInboundContact: contact ${input.handle} was neither inserted nor found`,
    );
  }

  const current = toContact(existingRow, 'inbound_contacts');

  const patch: Tables['inbound_contacts']['Update'] = {
    last_seen_at: input.seenAt,
    message_count: current.messageCount + 1,
  };
  if (input.chatId !== null) patch.chat_id = input.chatId;
  if (input.channel !== undefined) patch.channel = input.channel;

  const updated = unwrapMaybe(
    await client
      .from('inbound_contacts')
      .update(patch)
      .eq('handle', input.handle)
      .eq('message_count', current.messageCount)
      .select('*')
      .maybeSingle(),
    'recordInboundContact (bump)',
  );

  if (updated !== null) return toContact(updated, 'inbound_contacts');
  if (attempt < MAX_RACE_RETRIES) return bumpSighting(input, attempt + 1);

  // Losing this many races means other writers are incrementing the same row.
  // Report the stored truth and say plainly that this sighting may not be in it
  // rather than returning a count nobody wrote.
  console.warn(
    `[inbound] gave up bumping message_count for ${input.handle} after ${MAX_RACE_RETRIES} retries; the stored count may be one short`,
  );
  return current;
}

/**
 * Record that a contact asked us to stop.
 *
 * One-way by design, and the migration says so in a comment: there is no
 * corresponding clear function here and there never should be. Re-stating a
 * stop request keeps the original `opted_out_at`, because the moment consent
 * was withdrawn is the fact worth holding.
 *
 * A stop request from a handle we have never heard from is still honoured, and
 * the row it creates carries `message_count` 0 rather than the column default
 * of 1. We would be recording a message that never arrived otherwise, and the
 * inbound count is shown in the UI as evidence of contact.
 */
export async function markOptedOut(handle: string): Promise<InboundContact> {
  const key = handleKey(handle, 'markOptedOut');
  return markOptedOutAttempt(key, 0);
}

async function markOptedOutAttempt(key: string, attempt: number): Promise<InboundContact> {
  const client = tables('markOptedOut');
  const existing = await getContact(key);

  if (existing !== null) {
    if (existing.optedOut) return existing;
    const row = unwrap(
      await client
        .from('inbound_contacts')
        .update({ opted_out: true, opted_out_at: nowIso() })
        .eq('handle', key)
        .select('*')
        .single(),
      'markOptedOut',
    );
    return toContact(row, 'inbound_contacts');
  }

  const insert = await client
    .from('inbound_contacts')
    .insert({ handle: key, opted_out: true, opted_out_at: nowIso(), message_count: 0 })
    .select('*')
    .single();

  if (isUniqueViolation(insert.error) && attempt < MAX_RACE_RETRIES) {
    // Their first message landed between the read and the insert. Re-read and
    // take the update path so the sighting that just arrived is not discarded.
    return markOptedOutAttempt(key, attempt + 1);
  }

  return toContact(unwrap(insert, 'markOptedOut (new contact)'), 'inbound_contacts');
}

/* -------------------------------------------------------------------------- */
/* Inbound contacts: reads                                                    */
/* -------------------------------------------------------------------------- */

/** One contact by handle, or `null` if they have never messaged us. */
async function getContact(handle: string): Promise<InboundContact | null> {
  const client = tables('getContact');
  const row = unwrapMaybe(
    await client.from('inbound_contacts').select('*').eq('handle', handle).maybeSingle(),
    'getContact',
  );
  return row === null ? null : toContact(row, 'inbound_contacts');
}

const reachabilityRowSchema = z.object({
  handle: z.string().min(1),
  opted_out: z.boolean(),
});

/**
 * May the company message this handle?
 *
 * True only when the handle has messaged us AND has not opted out. This is the
 * gate the Sales Agent consults before composing, so that a refusal is a
 * decision it can log rather than a 403 discovered halfway through a tick.
 *
 * It answers a question about consent, not about configuration. Whether the
 * active channel enforces inbound-first at all is `requiresInboundFirst()` in
 * `lib/delivery/channel.ts`, and it is the caller that combines the two.
 */
export async function isReachable(handle: string): Promise<boolean> {
  const key = handle.trim();
  if (key === '') return false;

  const client = tables('isReachable');
  const row = unwrapMaybe(
    await client.from('inbound_contacts').select('handle, opted_out').eq('handle', key).maybeSingle(),
    'isReachable',
  );
  if (row === null) return false;

  return !parseRow(reachabilityRowSchema, row, 'inbound_contacts').opted_out;
}

/** Most recently active contacts first. Drives the inbound panel in the UI. */
export async function listInboundContacts(limit = 25): Promise<InboundContact[]> {
  const client = tables('listInboundContacts');
  const rows = unwrap(
    await client
      .from('inbound_contacts')
      .select('*')
      .order('last_seen_at', { ascending: false })
      .limit(limit),
    'listInboundContacts',
  );
  return parseRows(inboundContactRowSchema, rows, 'inbound_contacts').map((row) =>
    toContact(row, 'inbound_contacts'),
  );
}

/* -------------------------------------------------------------------------- */
/* Shape: outbound queue                                                      */
/* -------------------------------------------------------------------------- */

/** Mirrors the CHECK on `outbound_queue.purpose`. */
export const queuePurposeSchema = z.enum(['sales_sample', 'opportunity', 'other']);
export type QueuePurpose = z.infer<typeof queuePurposeSchema>;

/** Mirrors the CHECK on `outbound_queue.status`. */
export const queueStatusSchema = z.enum(['waiting_for_inbound', 'sent', 'abandoned']);
export type QueueStatus = z.infer<typeof queueStatusSchema>;

/** The status a message is held in until its recipient makes contact. */
const PENDING: QueueStatus = 'waiting_for_inbound';

const queuedMessageRowSchema = z.object({
  id: z.string().min(1),
  handle: z.string().min(1),
  body: z.string().min(1),
  link_url: z.string().nullable(),
  purpose: queuePurposeSchema,
  opportunity_id: z.string().nullable(),
  status: queueStatusSchema,
  created_at: dbTimestamp,
  sent_at: dbTimestampNullable,
  message_id: z.string().nullable(),
});

/** A composed message and what has happened to it. */
export interface QueuedMessage {
  id: string;
  handle: string;
  body: string;
  linkUrl: string | null;
  purpose: QueuePurpose;
  opportunityId: string | null;
  /** `waiting_for_inbound` means prepared and held. It does not mean sent. */
  status: QueueStatus;
  createdAt: string;
  /** Written only by {@link markQueuedSent}, after a provider accepted it. */
  sentAt: string | null;
  /** Provider message id. Null while the message is still waiting. */
  messageId: string | null;
}

export interface QueueOutboundInput {
  /** Channel-normalized handle. */
  handle: string;
  /** Customer-facing copy. Checked against the copy rules before it is stored. */
  body: string;
  /** Optional link to send as a preview card when the message is released. */
  linkUrl?: string | null;
  /** Defaults to `sales_sample`, matching the column. */
  purpose?: QueuePurpose;
  /** The opportunity this message is about, when there is one. */
  opportunityId?: string | null;
}

/**
 * The queued row, plus whether this call is what put it there.
 *
 * Every field of the row is on this object, so a caller can read `.id` or
 * `.body` off the result directly. `inserted` exists for the decision log: a
 * tick that re-prepares the same sample every two minutes should log the
 * queueing once, not eighty times.
 */
export interface QueueOutboundResult extends QueuedMessage {
  /** True when this call created the row, false when one was already waiting. */
  inserted: boolean;
}

function toQueued(row: unknown, context: string): QueuedMessage {
  const parsed = parseRow(queuedMessageRowSchema, row, context);
  return {
    id: parsed.id,
    handle: parsed.handle,
    body: parsed.body,
    linkUrl: parsed.link_url,
    purpose: parsed.purpose,
    opportunityId: parsed.opportunity_id,
    status: parsed.status,
    createdAt: parsed.created_at,
    sentAt: parsed.sent_at,
    messageId: parsed.message_id,
  };
}

/* -------------------------------------------------------------------------- */
/* Outbound queue: writes                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Hold a composed message until its recipient has made contact.
 *
 * The copy check runs first and throws, exactly as it does in the integrations:
 * banned language is a build defect, and a message that could never legally be
 * sent has no business sitting in a queue waiting to be sent.
 *
 * Idempotent per `(handle, purpose)` while pending, which is what the partial
 * unique index in 0002 enforces. A repeat is a no-op that returns the row that
 * is already waiting, so a worker looping every two minutes cannot pile up
 * twenty copies of one sample.
 */
export async function queueOutbound(input: QueueOutboundInput): Promise<QueueOutboundResult> {
  assertCustomerSafe(input.body, 'outbound queue entry');

  const handle = handleKey(input.handle, 'queueOutbound');
  const purpose = queuePurposeSchema.parse(input.purpose ?? 'sales_sample');
  return queueOutboundAttempt(
    {
      handle,
      body: input.body,
      link_url: input.linkUrl ?? null,
      purpose,
      opportunity_id: input.opportunityId ?? null,
      status: PENDING,
    },
    0,
  );
}

async function queueOutboundAttempt(
  payload: Tables['outbound_queue']['Insert'] & { handle: string; purpose: string },
  attempt: number,
): Promise<QueueOutboundResult> {
  const client = tables('queueOutbound');
  const insert = await client.from('outbound_queue').insert(payload).select('*').single();

  if (!isUniqueViolation(insert.error)) {
    return { ...toQueued(unwrap(insert, 'queueOutbound'), 'outbound_queue'), inserted: true };
  }

  // The partial unique index fired: something is already waiting for this
  // handle and purpose. Return it rather than raising, and rather than adding a
  // second copy of a message the recipient would receive twice.
  const existing = unwrapMaybe(
    await client
      .from('outbound_queue')
      .select('*')
      .eq('handle', payload.handle)
      .eq('purpose', payload.purpose)
      .eq('status', PENDING)
      .maybeSingle(),
    'queueOutbound (existing)',
  );

  if (existing !== null) {
    return { ...toQueued(existing, 'outbound_queue'), inserted: false };
  }

  // The pending row was released or abandoned between the insert and this read,
  // so the index is free again. Retry once rather than reporting a conflict
  // with a row that no longer exists.
  if (attempt < MAX_RACE_RETRIES) return queueOutboundAttempt(payload, attempt + 1);

  throw new StoreError(
    `queueOutbound: conflict on (${payload.handle}, ${payload.purpose}) that no pending row explains, after ${MAX_RACE_RETRIES} retries`,
  );
}

/**
 * Mark a held message as actually sent.
 *
 * Guarded on the row still being pending, so a duplicate release cannot stamp a
 * second provider id over a message that already went out. Calling it again on
 * a row that is already `sent` returns the stored row unchanged; calling it on
 * an abandoned one raises, because that would be inventing a delivery.
 */
export async function markQueuedSent(id: string, messageId: string): Promise<QueuedMessage> {
  const client = tables('markQueuedSent');

  const updated = unwrapMaybe(
    await client
      .from('outbound_queue')
      .update({ status: 'sent', sent_at: nowIso(), message_id: messageId })
      .eq('id', id)
      .eq('status', PENDING)
      .select('*')
      .maybeSingle(),
    'markQueuedSent',
  );
  if (updated !== null) return toQueued(updated, 'outbound_queue');

  const current = await getQueued(id);
  if (current === null) throw new StoreError(`markQueuedSent: no queued message ${id}`);
  if (current.status === 'sent') {
    console.warn(
      `[inbound] queued message ${id} was already sent as ${current.messageId ?? 'unknown'}; keeping the first provider id`,
    );
    return current;
  }
  throw new StoreError(
    `markQueuedSent: queued message ${id} is ${current.status}, so it cannot be marked sent`,
  );
}

/**
 * Give up on a held message.
 *
 * Same guard in the other direction: an already-sent message cannot be
 * abandoned, because the recipient has it.
 */
export async function abandonQueued(id: string): Promise<QueuedMessage> {
  const client = tables('abandonQueued');

  const updated = unwrapMaybe(
    await client
      .from('outbound_queue')
      .update({ status: 'abandoned' })
      .eq('id', id)
      .eq('status', PENDING)
      .select('*')
      .maybeSingle(),
    'abandonQueued',
  );
  if (updated !== null) return toQueued(updated, 'outbound_queue');

  const current = await getQueued(id);
  if (current === null) throw new StoreError(`abandonQueued: no queued message ${id}`);
  if (current.status === 'abandoned') return current;
  throw new StoreError(`abandonQueued: queued message ${id} was already sent`);
}

/* -------------------------------------------------------------------------- */
/* Outbound queue: reads                                                      */
/* -------------------------------------------------------------------------- */

/** One queued message by id, or `null`. */
async function getQueued(id: string): Promise<QueuedMessage | null> {
  const client = tables('getQueued');
  const row = unwrapMaybe(
    await client.from('outbound_queue').select('*').eq('id', id).maybeSingle(),
    'getQueued',
  );
  return row === null ? null : toQueued(row, 'outbound_queue');
}

/**
 * Everything still waiting for one handle, oldest first.
 *
 * This is what the inbound webhook drains: the handle just texted us, so
 * whatever was prepared for them may now go, in the order it was composed.
 */
export async function listPendingFor(handle: string, limit = 25): Promise<QueuedMessage[]> {
  const key = handle.trim();
  if (key === '') return [];

  const client = tables('listPendingFor');
  const rows = unwrap(
    await client
      .from('outbound_queue')
      .select('*')
      .eq('handle', key)
      .eq('status', PENDING)
      .order('created_at', { ascending: true })
      .limit(limit),
    'listPendingFor',
  );
  return parseRows(queuedMessageRowSchema, rows, 'outbound_queue').map((row) =>
    toQueued(row, 'outbound_queue'),
  );
}

/** How many messages are prepared and waiting. For the dashboard header. */
export async function countPending(): Promise<number> {
  const client = tables('countPending');
  return unwrapCount(
    await client
      .from('outbound_queue')
      .select('id', { count: 'exact', head: true })
      .eq('status', PENDING),
    'countPending',
  );
}
