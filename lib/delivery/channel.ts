/**
 * The delivery channel: one seam in front of Linq and Twilio.
 *
 * Linq is the channel for this build. Twilio stays implemented behind this
 * interface rather than being deleted, so losing Linq at the venue is a
 * one-variable config flip instead of a rewrite under time pressure. That is
 * also the spirit of the kickoff's fenced-stretch rule, which was written to
 * stop a messaging swap from becoming a single point of failure. The difference
 * from the original plan is which one is the default; the fence's actual
 * protection, "the other one still works", is preserved.
 *
 * Select with `DELIVERY_CHANNEL=linq|twilio`. Default is `linq`.
 *
 * INBOUND FIRST
 * -------------
 * Linq's sandbox will not let the company message anybody who has not texted
 * the Linq number first. That is a hard platform rule, not a preference, and it
 * changes the acquisition motion: the Sales Agent cannot cold-send a sample.
 *
 * Rather than let a send fail somewhere deep in a tick, this module answers the
 * question up front through `canReach`, and `sendMessage` reports a refusal as
 * `requiresInboundFirst` instead of a generic error. Callers hold the message
 * and log "prepared, waiting for first contact", which is honest, is visible in
 * the decision log, and is exactly the consent model the kickoff's cold-outreach
 * note asked for anyway (SMS only after opt-in).
 */
import { envOr } from '@/lib/config/deployment-env';
import {
  linqReady,
  sendLinqMessage,
  toHandle as toLinqHandle,
} from '@/lib/integrations/linq';
import { sendSms, toE164, twilioReady } from '@/lib/integrations/twilio';

export type ChannelName = 'linq' | 'twilio';

/** Which channel this deployment is configured to use. */
export function activeChannel(): ChannelName {
  return envOr('DELIVERY_CHANNEL', 'linq').trim().toLowerCase() === 'twilio' ? 'twilio' : 'linq';
}

/** What a caller learns about a send, independent of which channel ran it. */
export interface DeliveryReceipt {
  channel: ChannelName;
  /** Provider message id: a Linq message id or a Twilio SID. */
  messageId: string;
  /** Provider status at accept time. Not a delivery receipt. */
  status: string;
  to: string;
  bodyLength: number;
}

export type DeliveryResult =
  | { ok: true; skipped: false; value: DeliveryReceipt }
  | { ok: false; skipped: true; reason: string }
  | {
      ok: false;
      skipped: false;
      reason: string;
      /** The recipient has to text us first. Hold the message; do not retry. */
      requiresInboundFirst?: boolean;
      /** The recipient opted out. Never retry, never override.  */
      optedOut?: boolean;
    };

export interface SendOptions {
  to: string;
  body: string;
  /** Rich link card, Linq only. Ignored on Twilio, where the URL goes inline. */
  linkPreviewUrl?: string;
  /** Reuse across retries so a retry cannot double-send. */
  idempotencyKey?: string;
}

/** True when the configured channel has the credentials it needs. */
export function channelReady(): boolean {
  return activeChannel() === 'linq' ? linqReady() : twilioReady();
}

/** Normalize a recipient for the configured channel, or null if unusable. */
export function normalizeRecipient(raw: string): string | null {
  return activeChannel() === 'linq' ? toLinqHandle(raw) : toE164(raw);
}

/**
 * Does this channel allow us to initiate contact with someone new?
 *
 * Linq's sandbox does not. Twilio does. Callers use this to decide between
 * sending and queueing, rather than discovering it from a 403.
 */
export function requiresInboundFirst(): boolean {
  if (activeChannel() !== 'linq') return false;
  // Escape hatch for a production Linq number without the sandbox restriction.
  return envOr('LINQ_ALLOW_COLD_OUTBOUND', 'false').trim().toLowerCase() !== 'true';
}

/**
 * Send one message through the configured channel.
 *
 * Copy safety is enforced inside each integration, before its capability check,
 * so banned language throws regardless of which channel is active and
 * regardless of whether credentials are present.
 */
export async function sendMessage(opts: SendOptions): Promise<DeliveryResult> {
  const channel = activeChannel();

  if (channel === 'twilio') {
    const result = await sendSms({ to: opts.to, body: opts.body });
    if (!result.ok) return result;
    return {
      ok: true,
      skipped: false,
      value: {
        channel,
        messageId: result.value.sid,
        status: result.value.status,
        to: result.value.to,
        bodyLength: result.value.bodyLength,
      },
    };
  }

  const result = await sendLinqMessage({
    to: opts.to,
    body: opts.body,
    ...(opts.linkPreviewUrl !== undefined ? { linkPreviewUrl: opts.linkPreviewUrl } : {}),
    ...(opts.idempotencyKey !== undefined ? { idempotencyKey: opts.idempotencyKey } : {}),
  });

  if (!result.ok) {
    return result.skipped
      ? result
      : {
          ok: false,
          skipped: false,
          reason: result.reason,
          ...(result.requiresInboundFirst === true ? { requiresInboundFirst: true } : {}),
          ...(result.optedOut === true ? { optedOut: true } : {}),
        };
  }

  return {
    ok: true,
    skipped: false,
    value: {
      channel,
      messageId: result.value.messageId,
      status: 'sent',
      to: opts.to,
      bodyLength: opts.body.length,
    },
  };
}

/** Human-readable channel description for the decision log and the UI. */
export function channelLabel(): string {
  return activeChannel() === 'linq' ? 'Linq (iMessage, RCS or SMS)' : 'Twilio SMS';
}
