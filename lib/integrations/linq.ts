/**
 * Linq delivery channel: iMessage, RCS and SMS through one API.
 *
 * Linq is the delivery channel for this build. Twilio remains implemented behind
 * `lib/delivery/channel.ts` as a fallback so a channel outage is a config flip
 * rather than a rewrite, but Linq is the default and the demo path.
 *
 * ==========================================================================
 * WIRE CONTRACT: VERIFIED against the official TypeScript SDK `@linqapp/sdk`
 * v0.39.1, read from its type declarations rather than the published web docs.
 *
 * That distinction matters. docs.linqapp.com's API reference documents a text
 * part as `{ type: 'text', content: string }`. The SDK declares
 * `{ type: 'text', value: string }`, and the SDK is what the API actually
 * accepts. The published reference also lists the auth header three different
 * ways across pages. Everything below follows the SDK.
 * ==========================================================================
 *
 * Base URL  https://api.linqapp.com/api/partner  (SDK appends /v3)
 * Auth      Authorization: Bearer <LINQ_API_V3_API_KEY>
 * Send      POST /v3/messages  { message: { parts }, to: string[] }
 * Inbound   webhook subscription on `message.received`, Standard Webhooks
 *           signature verified with LINQ_WEBHOOK_SECRET
 *
 * TWO PLATFORM RULES THAT SHAPE THE CODE
 * --------------------------------------
 * 1. INBOUND FIRST. On the hackathon sandbox, "your agent can only message
 *    people who have texted your Linq number first." Outbound cold contact is
 *    not merely discouraged, it is refused. `sendLinqMessage` surfaces that as
 *    a typed `requiresInboundFirst` result so the Sales Agent can log "sample
 *    prepared, waiting for first contact" instead of pretending it sent
 *    something. See `lib/delivery/channel.ts` for how a pending send is held.
 *
 * 2. A LINK PART MUST BE THE ONLY PART in a message. So a message that carries
 *    both copy and a URL is either one text part with the URL inline (no
 *    preview card), or two sends. `linkPreviewUrl` opts into the second send;
 *    by default the URL goes inline, which is what SMS would have done anyway.
 *
 * Customer-facing copy rules (CLAUDE.md rule 9) are enforced here, before the
 * capability check, so a banned-language violation throws on a machine with no
 * credentials rather than only in production.
 */
import Linq from '@linqapp/sdk';

import { hasCapability, missingKeys, optionalEnv, requireEnv } from '@/lib/config/deployment-env';
import { assertCustomerSafe } from '@/lib/copy/templates';

/* -------------------------------------------------------------------------- */
/* Result types                                                               */
/* -------------------------------------------------------------------------- */

export interface SentLinqMessage {
  messageId: string;
  chatId: string | null;
  /** The line Linq actually sent from, which it may pick for us. */
  from: string | null;
  /** Present only when a rich link card was sent as a second message. */
  linkMessageId: string | null;
}

/**
 * Distinguishes the four outcomes that need different handling:
 * configured-and-worked, not-configured, refused-because-inbound-first, and
 * everything else. `requiresInboundFirst` and `optedOut` are NOT failures to
 * retry; they are states the caller should record and respect.
 */
export type LinqResult<T> =
  | { ok: true; skipped: false; value: T }
  | { ok: false; skipped: true; reason: string }
  | {
      ok: false;
      skipped: false;
      reason: string;
      requiresInboundFirst?: boolean;
      optedOut?: boolean;
    };

export interface SendLinqOptions {
  /** Recipient handle. E.164 phone number or Apple ID email. */
  to: string;
  /** Message body. Subject to the customer-facing copy rules. */
  body: string;
  /**
   * Send a rich link preview card as a SECOND message after the copy. Linq
   * requires a link part to be alone in its message, so this is genuinely two
   * sends. Omit to keep the URL inline in the text, which is one send.
   */
  linkPreviewUrl?: string;
  /** Reuse across retries so a retry cannot double-send. */
  idempotencyKey?: string;
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

let cached: { key: string; client: Linq } | null = null;

/** Lazily constructed, memoized on the key so a rotated key rebuilds it. */
function client(): Linq {
  const key = requireEnv('LINQ_API_V3_API_KEY');
  if (cached !== null && cached.key === key) return cached.client;
  const created = new Linq({
    apiKey: key,
    ...(optionalEnv('LINQ_API_V3_BASE_URL') !== null
      ? { baseURL: requireEnv('LINQ_API_V3_BASE_URL') }
      : {}),
    ...(optionalEnv('LINQ_WEBHOOK_SECRET') !== null
      ? { webhookSecret: requireEnv('LINQ_WEBHOOK_SECRET') }
      : {}),
  });
  cached = { key, client: created };
  return created;
}

export function linqReady(): boolean {
  return hasCapability('linq');
}

function skipped<T>(): LinqResult<T> {
  return {
    ok: false,
    skipped: true,
    reason: `linq capability unconfigured (missing: ${missingKeys('linq').join(', ')})`,
  };
}

/* -------------------------------------------------------------------------- */
/* Handles                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Normalize to E.164, which Linq requires for phone handles.
 *
 * Rejects rather than guesses: a bare 10-digit number is assumed US only
 * because this build sells in San Francisco, and anything else returns null so
 * the caller reports a bad handle instead of texting a stranger.
 */
export function toHandle(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.includes('@')) return trimmed; // Apple ID email handle
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (digits.startsWith('+') && /^\+\d{8,15}$/.test(digits)) return digits;
  const bare = digits.replace(/\D/g, '');
  if (bare.length === 10) return `+1${bare}`;
  if (bare.length === 11 && bare.startsWith('1')) return `+${bare}`;
  return null;
}

/* -------------------------------------------------------------------------- */
/* Error classification                                                       */
/* -------------------------------------------------------------------------- */

/** Linq's documented opt-out refusal: HTTP 403 with error code 2024. */
const OPTOUT_CODE = 2024;

/**
 * Does this failure mean "they have not texted us first"?
 *
 * The sandbox enforces inbound-first, and the refusal arrives as a 403. There
 * is no documented distinct error code for it, so this reads the message text.
 * The check is deliberately narrow: an unrecognised 403 is reported as a plain
 * failure rather than silently reclassified into a state that looks benign.
 */
function classify(error: unknown): { requiresInboundFirst: boolean; optedOut: boolean; reason: string } {
  const status = typeof error === 'object' && error !== null && 'status' in error
    ? Number((error as { status: unknown }).status)
    : null;
  const raw = error instanceof Error ? error.message : String(error);
  const text = raw.toLowerCase();

  const optedOut =
    text.includes(String(OPTOUT_CODE)) || text.includes('opted out') || text.includes('opt-out');

  const requiresInboundFirst =
    status === 403 &&
    !optedOut &&
    (text.includes('inbound') ||
      text.includes('first') ||
      text.includes('not allowed to message') ||
      text.includes('sandbox'));

  return { requiresInboundFirst, optedOut, reason: raw };
}

/* -------------------------------------------------------------------------- */
/* Send                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Send one message.
 *
 * Copy safety runs first and THROWS rather than returning a result, because
 * banned language reaching a customer is a build defect, not a runtime
 * condition to handle (CLAUDE.md rule 9).
 */
export async function sendLinqMessage(opts: SendLinqOptions): Promise<LinqResult<SentLinqMessage>> {
  assertCustomerSafe(opts.body, 'linq outbound message');

  const handle = toHandle(opts.to);
  if (handle === null) {
    return { ok: false, skipped: false, reason: `not a usable Linq handle: ${opts.to}` };
  }
  if (!linqReady()) return skipped<SentLinqMessage>();

  try {
    const sent = await client().messages.create(
      {
        to: [handle],
        message: {
          parts: [{ type: 'text', value: opts.body }],
          ...(opts.idempotencyKey !== undefined ? { idempotency_key: opts.idempotencyKey } : {}),
        },
      },
      opts.idempotencyKey !== undefined
        ? { headers: { 'Idempotency-Key': opts.idempotencyKey } }
        : undefined,
    );

    const record = sent as unknown as Record<string, unknown>;
    const messageId = typeof record['id'] === 'string' ? record['id'] : '';
    const chatId = typeof record['chat_id'] === 'string' ? record['chat_id'] : null;
    const from = typeof record['from'] === 'string' ? record['from'] : null;

    // A link part must be alone in its message, so the preview card is a
    // separate send that must not fail the message that already landed.
    let linkMessageId: string | null = null;
    if (opts.linkPreviewUrl !== undefined) {
      try {
        const card = await client().messages.create({
          to: [handle],
          message: { parts: [{ type: 'link', value: opts.linkPreviewUrl }] },
        });
        const cardRecord = card as unknown as Record<string, unknown>;
        linkMessageId = typeof cardRecord['id'] === 'string' ? cardRecord['id'] : null;
      } catch {
        linkMessageId = null; // copy landed; the card is a nicety
      }
    }

    return { ok: true, skipped: false, value: { messageId, chatId, from, linkMessageId } };
  } catch (error) {
    const { requiresInboundFirst, optedOut, reason } = classify(error);
    return {
      ok: false,
      skipped: false,
      reason: `linq send failed: ${reason}`,
      ...(requiresInboundFirst ? { requiresInboundFirst: true } : {}),
      ...(optedOut ? { optedOut: true } : {}),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Inbound webhook                                                            */
/* -------------------------------------------------------------------------- */

/** Event types worth subscribing to. `message.received` drives the feedback loop. */
export const LINQ_INBOUND_EVENT = 'message.received';

/** The parts of an inbound message this app actually acts on. */
export interface InboundMessage {
  eventType: string;
  messageId: string;
  chatId: string | null;
  /** Sender handle, E.164 or email. This is who texted us first. */
  handle: string | null;
  /** Concatenated text of every text part, trimmed. */
  text: string;
}

/**
 * Verify and unwrap an inbound webhook.
 *
 * Signature verification is delegated to the SDK, which implements Standard
 * Webhooks (`webhook-id` / `webhook-timestamp` / `webhook-signature`). An
 * unverified body is never parsed for content.
 */
export function verifyLinqWebhook(
  rawBody: string,
  headers: Record<string, string>,
): LinqResult<InboundMessage> {
  if (!linqReady()) return skipped<InboundMessage>();
  if (optionalEnv('LINQ_WEBHOOK_SECRET') === null) {
    return { ok: false, skipped: false, reason: 'LINQ_WEBHOOK_SECRET is not set; refusing to trust an unverified webhook' };
  }

  let event: unknown;
  try {
    event = client().webhooks.unwrap(rawBody, {
      headers,
      key: requireEnv('LINQ_WEBHOOK_SECRET'),
    });
  } catch (error) {
    return {
      ok: false,
      skipped: false,
      reason: `linq webhook signature verification failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return { ok: true, skipped: false, value: readInbound(event) };
}

/**
 * Flatten an unwrapped event into the fields we use.
 *
 * Tolerates both webhook payload versions: V1 nests the message under `message`
 * and marks direction with `is_from_me`; V2 (`?version=2026-02-03`) puts message
 * fields at the top level with an explicit `direction` and `sender_handle`.
 * Reading both means a subscription created either way still works.
 */
function readInbound(event: unknown): InboundMessage {
  const root = (event ?? {}) as Record<string, unknown>;
  const eventType = typeof root['type'] === 'string' ? root['type'] : 'unknown';
  const data = (root['data'] ?? root) as Record<string, unknown>;
  const nested = (data['message'] ?? data) as Record<string, unknown>;

  const parts = Array.isArray(nested['parts']) ? (nested['parts'] as unknown[]) : [];
  const text = parts
    .map((part) => {
      const p = (part ?? {}) as Record<string, unknown>;
      if (p['type'] !== 'text') return '';
      // SDK declares text parts as `value`; accept `content` too because the
      // published reference documents that spelling and payloads may vary.
      const v = p['value'] ?? p['content'];
      return typeof v === 'string' ? v : '';
    })
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  const senderHandle = data['sender_handle'] ?? nested['sender_handle'];
  const handleFromObject =
    typeof senderHandle === 'object' && senderHandle !== null
      ? (senderHandle as Record<string, unknown>)['handle']
      : senderHandle;

  const handle =
    typeof handleFromObject === 'string'
      ? handleFromObject
      : typeof data['from'] === 'string'
        ? data['from']
        : typeof nested['from'] === 'string'
          ? nested['from']
          : null;

  const chat = (data['chat'] ?? {}) as Record<string, unknown>;
  const chatId =
    typeof nested['chat_id'] === 'string'
      ? nested['chat_id']
      : typeof data['chat_id'] === 'string'
        ? data['chat_id']
        : typeof chat['id'] === 'string'
          ? chat['id']
          : null;

  const messageId =
    typeof nested['id'] === 'string' ? nested['id'] : typeof data['id'] === 'string' ? data['id'] : '';

  return { eventType, messageId, chatId, handle, text };
}
