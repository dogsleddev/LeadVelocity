/**
 * Twilio SMS adapter, and the last gate before words reach a human.
 *
 * SMS is the delivery channel for the whole product: the opportunity alert to an
 * active subscriber and the sample plus checkout invite to a prospect. Twilio
 * stays wired for the entire build (kickoff section: Linq is additive, never a
 * swap), so this module is the single send path.
 *
 * Two responsibilities:
 *
 * 1. Send. Capability gated on `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` /
 *    `TWILIO_FROM_NUMBER`. Unconfigured returns `{ ok: false, skipped: true }`
 *    and the caller logs a skipped decision. It never pretends a message went
 *    out, because a fabricated send would put a fabricated fact in the event log.
 *
 * 2. Enforce the copy policy. Every body is run through `assertCustomerSafe`
 *    from `lib/copy/templates.ts` BEFORE the capability check, so a rule #9
 *    violation fails on a developer machine with no credentials, not in front of
 *    a subscriber. This one is a throw, not a soft result: banned language is a
 *    build failure by CLAUDE.md, not a degraded capability.
 *
 * The check runs here rather than only at the template, because the template is
 * not the only thing that can produce a body. Anything drafted by a model and
 * routed to a phone hits this guard on the way out.
 */
import twilio from 'twilio';

import { hasCapability, missingKeys, optionalEnv, requireEnv } from '@/lib/config/deployment-env';
import { BANNED_LANGUAGE_PATTERN, EM_DASH_PATTERN, assertCustomerSafe, SMS_CHARACTER_LIMIT } from '@/lib/copy/templates';

/* Re-exported so a caller can pre-check without importing the copy module. */
export { BANNED_LANGUAGE_PATTERN, EM_DASH_PATTERN, assertCustomerSafe, SMS_CHARACTER_LIMIT };

/** See `AnthropicResult` for why "skipped" and "failed" stay distinguishable. */
export type SmsResult =
  | { ok: true; skipped: false; value: SentMessage }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; reason: string };

/** What Twilio confirmed, and nothing we did not observe. */
export interface SentMessage {
  /** Twilio message SID, the reference written into the decision log. */
  sid: string;
  /** Twilio-reported status at accept time, e.g. `queued`. Not a delivery receipt. */
  status: string;
  to: string;
  from: string;
  /** Length of the body actually sent, for the segment accounting on the dashboard. */
  bodyLength: number;
}

export interface SendSmsOptions {
  /** Destination in E.164, e.g. `+14155550123`. */
  to: string;
  /** The message. Must pass the customer-facing copy policy. */
  body: string;
}

/** E.164: a plus, a non-zero country digit, then 6 to 14 more digits. */
const E164 = /^\+[1-9]\d{6,14}$/;

type TwilioClient = ReturnType<typeof twilio>;

let cached: { accountSid: string; authToken: string; client: TwilioClient } | null = null;

function getClient(): TwilioClient {
  const accountSid = requireEnv('TWILIO_ACCOUNT_SID');
  const authToken = requireEnv('TWILIO_AUTH_TOKEN');
  if (cached !== null && cached.accountSid === accountSid && cached.authToken === authToken) {
    return cached.client;
  }
  const client = twilio(accountSid, authToken);
  cached = { accountSid, authToken, client };
  return client;
}

/** True when a send would actually go out. */
export function twilioReady(): boolean {
  return hasCapability('twilio');
}

/**
 * Send one SMS.
 *
 * Throws only for a copy policy violation or a malformed destination, both of
 * which are programmer errors that must not be swallowed. Everything else
 * (unconfigured capability, Twilio rejection, network failure) comes back as a
 * typed result.
 */
export async function sendSms(opts: SendSmsOptions): Promise<SmsResult> {
  const body = opts.body.trim();

  /* Copy policy first, so a violation surfaces with or without credentials. */
  assertCustomerSafe(body, 'sendSms body');

  if (body.length === 0) {
    throw new Error('sendSms: body is empty. Refusing to send a blank message.');
  }
  if (body.length > SMS_CHARACTER_LIMIT) {
    throw new Error(
      `sendSms: body is ${body.length} characters, over the ${SMS_CHARACTER_LIMIT} character limit. ` +
        'Shorten the template rather than paying for extra segments.',
    );
  }
  if (!E164.test(opts.to)) {
    throw new Error(`sendSms: destination "${opts.to}" is not E.164 (expected a leading + and 7 to 15 digits).`);
  }

  if (!twilioReady()) {
    return {
      ok: false,
      skipped: true,
      reason: `twilio capability unconfigured (missing: ${missingKeys('twilio').join(', ')})`,
    };
  }

  const from = requireEnv('TWILIO_FROM_NUMBER');
  const messagingServiceSid = optionalEnv('TWILIO_MESSAGING_SERVICE_SID');

  try {
    const message = await getClient().messages.create(
      messagingServiceSid !== null
        ? { to: opts.to, body, messagingServiceSid }
        : { to: opts.to, body, from },
    );
    return {
      ok: true,
      skipped: false,
      value: {
        sid: message.sid,
        status: String(message.status),
        to: opts.to,
        from,
        bodyLength: body.length,
      },
    };
  } catch (error) {
    return { ok: false, skipped: false, reason: `twilio send failed: ${describeError(error)}` };
  }
}

/**
 * Normalize a US ten digit number to E.164 so a profile row typed by a human does
 * not fail the E.164 check. Returns null when the input cannot be normalized
 * confidently, which the caller should treat as an unknown rather than a guess.
 */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  if (E164.test(trimmed)) return trimmed;

  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    /* Twilio errors carry a numeric `code` that is the useful part of the report. */
    const code = (error as { code?: unknown }).code;
    return typeof code === 'number' ? `${error.message} (twilio code ${code})` : error.message;
  }
  return 'unknown error';
}
