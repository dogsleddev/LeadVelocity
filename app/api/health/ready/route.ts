/**
 * Readiness probe. `GET /api/health/ready`
 *
 * Origin: capability-report probe adapted from SiteVelocity's deployment
 * pattern (https://github.com/samshanmukh/SiteVelocity).
 *
 * Liveness answers "is the process up". This answers the harder and more useful
 * question: "can this deploy actually do its job right now, and if not, exactly
 * what is missing?" A half-configured deploy is the failure mode that hurts
 * during a demo, because every individual page still renders while nothing
 * works, so this endpoint is deliberately loud about gaps.
 *
 * Four things are reported:
 *
 * 1. `capabilityReport()` from deployment-env. Presence only. The report names
 *    the environment KEYS that are absent and never carries a value, so this
 *    response is safe to paste into a chat window while debugging a deploy.
 * 2. A real store round trip. Key presence proves configuration, not
 *    reachability, and those fail separately: a rotated service-role key is
 *    present and useless. The probe therefore issues one small read.
 * 3. `stripeMode()`, derived from the key prefix rather than a flag, so the
 *    reported mode can never disagree with the key actually in use. The event
 *    rule requires the demo checkout to run live and this is where that is
 *    checked from the outside.
 * 4. The delivery channel: which one `DELIVERY_CHANNEL` selected, whether it
 *    has its credentials, whether the inbound webhook that releases held
 *    messages is wired, and the state of the other channel behind the seam. An
 *    operator at the venue needs to answer "can we send, and over what" without
 *    reading the environment, and a channel swap is a one-variable flip whose
 *    effect has to be visible from outside the process.
 *
 * 200 when the core capabilities are ready and the store answers, 503
 * otherwise. Unlike `/api/health/live` this endpoint is allowed to fail; it is
 * not the Render health check, so a 503 here reports a problem instead of
 * causing one.
 */
import { NextResponse } from 'next/server';

import {
  type CapabilityName,
  capabilityReport,
  missingKeys,
  optionalEnv,
  stripeMode,
} from '@/lib/config/deployment-env';
import {
  type ChannelName,
  activeChannel,
  channelLabel,
  channelReady,
  requiresInboundFirst,
} from '@/lib/delivery/channel';
import { isStoreReady, listEvents } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/* -------------------------------------------------------------------------- */
/* What "ready" means                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Capabilities the P0 fulfilment loop cannot run without: persistence, billing
 * state, and the reasoning the shortlist and drafting steps depend on. Any of
 * these missing means the company is not open for business, so their absence is
 * a 503.
 *
 * The delivery channel is core too, but WHICH one is core depends on
 * `DELIVERY_CHANNEL`, so it is appended by {@link coreCapabilities} rather than
 * named here. Hard-coding one channel would make a correctly configured Linq
 * deploy report itself broken for missing Twilio keys it will never use.
 */
const CORE_BASE: readonly CapabilityName[] = ['supabase', 'stripe', 'anthropic'];

/**
 * Reported but not fatal. Terac backs the GenPop message study, which is an
 * event deliverable rather than a runtime dependency of the loop, and the SODA
 * app token only raises DataSF rate limits. Marking either one fatal would make
 * a working system report itself broken, which is the fastest way to teach an
 * operator to ignore this endpoint.
 */
const ADVISORY_BASE: readonly CapabilityName[] = ['terac', 'soda'];

/** The channel that is not currently selected. */
function fallbackChannel(): ChannelName {
  return activeChannel() === 'linq' ? 'twilio' : 'linq';
}

/** Core capabilities for this deploy: the fixed three plus the live channel. */
function coreCapabilities(): CapabilityName[] {
  return [...CORE_BASE, activeChannel()];
}

/**
 * Advisory capabilities plus the channel currently on the bench.
 *
 * The fallback being unconfigured is worth seeing, because it means the config
 * flip that `lib/delivery/channel.ts` exists to make possible would not
 * actually work. It is not fatal: the company can sell and deliver on one
 * channel.
 */
function advisoryCapabilities(): CapabilityName[] {
  return [...ADVISORY_BASE, fallbackChannel()];
}

/* -------------------------------------------------------------------------- */
/* Delivery channel                                                           */
/* -------------------------------------------------------------------------- */

interface ChannelProbe {
  /** Which channel `DELIVERY_CHANNEL` selected. */
  active: ChannelName;
  /** Human-readable, the same string the decision log and the UI show. */
  label: string;
  /** The active channel has the keys it needs to SEND. */
  ready: boolean;
  /** Send-side keys absent, by name. Never a value. */
  missing: string[];
  /**
   * The inbound webhook, which on Linq is what releases messages held for a
   * handle that had not texted us yet. Null on Twilio, whose inbound route
   * needs no key of its own.
   */
  inbound: { ready: boolean; missing: string[] } | null;
  /** True when the channel refuses to initiate contact with a new handle. */
  requiresInboundFirst: boolean;
  /** The other channel behind the seam, so an operator knows if a flip is safe. */
  fallback: { name: ChannelName; ready: boolean; missing: string[] };
}

/**
 * Channel state, presence only.
 *
 * `LINQ_WEBHOOK_SECRET` is reported separately rather than folded into `ready`
 * because deployment-env deliberately keeps it out of the `linq` capability:
 * outbound can be wired before inbound without making the channel unusable. It
 * is not fatal here for the same reason, but it is shown, because on Linq a
 * deploy that cannot verify inbound can never release a held message and that
 * is a failure an operator should see before the demo rather than during it.
 */
function probeChannel(
  capabilities: Record<CapabilityName, { ready: boolean; missing: string[] }>,
): ChannelProbe {
  const active = activeChannel();
  const fallback = fallbackChannel();
  const fallbackState = capabilities[fallback];

  const webhookSecretMissing = optionalEnv('LINQ_WEBHOOK_SECRET') === null;

  return {
    active,
    label: channelLabel(),
    ready: channelReady(),
    missing: missingKeys(active),
    inbound:
      active === 'linq'
        ? {
            ready: !webhookSecretMissing,
            missing: webhookSecretMissing ? ['LINQ_WEBHOOK_SECRET'] : [],
          }
        : null,
    requiresInboundFirst: requiresInboundFirst(),
    fallback: { name: fallback, ready: fallbackState.ready, missing: fallbackState.missing },
  };
}

/* -------------------------------------------------------------------------- */
/* Store probe                                                                */
/* -------------------------------------------------------------------------- */

interface StoreProbe {
  /** Both Supabase keys are present. */
  configured: boolean;
  /** The database actually answered. */
  reachable: boolean;
  /** Round trip time of the probe query, when one was attempted. */
  latencyMs: number | null;
  /** Environment keys absent, by name. Never a value. */
  missing: string[];
  /** Redacted failure detail, or null when the probe succeeded. */
  detail: string | null;
}

/**
 * Anything in an error message that could carry a credential or an internal
 * host: URLs, JWT-shaped strings, Stripe-style keys, long hex blobs.
 *
 * A store error is usually a plain PostgREST message, but "usually" is not a
 * guarantee worth making about a public endpoint, so the message is scrubbed
 * before it leaves the process and the untouched original goes to the server
 * log where an operator can read it.
 */
const SECRET_SHAPED =
  /(?:https?:\/\/\S+|eyJ[\w-]{8,}\.[\w-]+\.[\w-]+|(?:sk|rk|pk|whsec)_[A-Za-z0-9_]{8,}|\b[A-Fa-f0-9]{32,}\b)/g;

function redact(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(SECRET_SHAPED, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * One small read against the decision log.
 *
 * `events` is chosen over `settings` on purpose: `getSettings()` self-heals a
 * missing singleton by writing one, and a readiness probe that mutates state is
 * a probe that changes what it measures. An empty log is a perfectly good
 * answer; what is being tested is that PostgREST accepted the credential and
 * returned rows.
 */
async function probeStore(): Promise<StoreProbe> {
  if (!isStoreReady()) {
    return {
      configured: false,
      reachable: false,
      latencyMs: null,
      missing: missingKeys('supabase'),
      detail: 'supabase keys absent, persistence disabled',
    };
  }

  const startedAt = Date.now();
  try {
    await listEvents({ limit: 1 });
    return {
      configured: true,
      reachable: true,
      latencyMs: Date.now() - startedAt,
      missing: [],
      detail: null,
    };
  } catch (error) {
    console.error('[health/ready] store probe failed:', error);
    return {
      configured: true,
      reachable: false,
      latencyMs: Date.now() - startedAt,
      missing: [],
      detail: redact(error),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Handler                                                                    */
/* -------------------------------------------------------------------------- */

export async function GET(): Promise<NextResponse> {
  const capabilities = capabilityReport();
  const store = await probeStore();
  const core = coreCapabilities();
  const channel = probeChannel(capabilities);

  const notReady = core.filter((name) => !capabilities[name].ready);
  const missing = core.flatMap((name) => capabilities[name].missing);
  const ready = store.reachable && notReady.length === 0;

  return NextResponse.json(
    {
      status: ready ? 'ready' : 'not_ready',
      service: 'leadvelocity',
      ts: new Date().toISOString(),
      store,
      /* Which channel is live, whether it can send, and whether inbound (the
       * only thing that releases a held message) is wired. Presence only. */
      channel,
      /* 'unset' is distinct from 'test': no key at all is not a test deploy. */
      stripeMode: stripeMode(),
      core,
      advisory: advisoryCapabilities(),
      /* Presence only, key names never values. Safe to share while debugging. */
      capabilities,
      notReady,
      missingKeys: missing,
    },
    { status: ready ? 200 : 503, headers: { 'cache-control': 'no-store' } },
  );
}
