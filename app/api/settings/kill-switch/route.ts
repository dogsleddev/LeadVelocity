/**
 * Kill switch. `GET /api/settings/kill-switch`, `POST /api/settings/kill-switch`
 *
 * One boolean in the `settings` singleton that every worker reads at the top of
 * every tick (CLAUDE.md hard rule #7). Flipping it on halts the entire company:
 * no shortlisting, no enrichment, no scoring, no sends. Flipping it back off
 * resumes on the next tick. This route is what the pause control in the UI
 * calls, and it is a P0 demo beat in its own right.
 *
 * Two things make it more than a setter:
 *
 * - **It writes to the decision log.** A halt is a decision, and hard rule #6
 *   says decisions are logged with a timestamp, an author, and a summary a
 *   judge can read. It is attributed to the CEO Agent, which is the only one of
 *   the four with authority over whether the company operates at all. A no-op
 *   flip is logged too, because "somebody pressed pause and nothing changed"
 *   is exactly the kind of thing a log exists to answer.
 * - **It degrades honestly.** With Supabase unconfigured the switch cannot be
 *   read or moved, so the route answers 503 and reports the value the workers
 *   will actually use in that state, which is `KILL_SWITCH_DEFAULT`. An
 *   operator who shipped with the switch defaulted on gets a halted system, not
 *   a runaway one, and this endpoint says so out loud.
 *
 * POST body (all fields optional, `application/json`):
 *   `{ "on": true }`      set explicitly
 *   `{ "toggle": true }`  flip whatever it is now
 *   `{}` or empty body    flip whatever it is now
 *   `{ "reason": "..." }` free text recorded on the decision row
 */
import { NextResponse } from 'next/server';
import { z } from 'zod';

import { killSwitchDefault, missingKeys } from '@/lib/config/deployment-env';
import { type AppSettings, getSettings, isStoreReady, logEvent, setKillSwitch } from '@/lib/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function jsonResponse(body: Record<string, unknown>, status: number): NextResponse {
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

/** The same 503 from both verbs, naming keys and never values. */
function storeUnconfigured(): NextResponse {
  return jsonResponse(
    {
      error: 'store_unconfigured',
      message: 'Persistence is not configured, so the kill switch cannot be read or changed.',
      missing: missingKeys('supabase'),
      /* What every worker will fall back to while the store is unreachable. */
      fallbackKillSwitch: killSwitchDefault(),
    },
    503,
  );
}

function present(settings: AppSettings): Record<string, unknown> {
  return {
    killSwitch: settings.killSwitch,
    replayActive: settings.replayActive,
    replaySpeedMultiplier: settings.replaySpeedMultiplier,
    updatedAt: settings.updatedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Read                                                                       */
/* -------------------------------------------------------------------------- */

export async function GET(): Promise<NextResponse> {
  if (!isStoreReady()) return storeUnconfigured();

  try {
    const settings = await getSettings();
    return jsonResponse(present(settings), 200);
  } catch (error) {
    console.error('[settings/kill-switch] read failed:', error);
    return jsonResponse({ error: 'store_unavailable', message: 'Settings could not be read.' }, 503);
  }
}

/* -------------------------------------------------------------------------- */
/* Write                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `.strict()` so a typo like `{ "kill": true }` is a 400 instead of a silent
 * toggle in the opposite direction from what the operator meant.
 */
const postBodySchema = z
  .object({
    on: z.boolean().optional(),
    toggle: z.boolean().optional(),
    reason: z.string().trim().max(200).optional(),
  })
  .strict();

export async function POST(request: Request): Promise<NextResponse> {
  const rawBody = (await request.text()).trim();

  let candidate: unknown = {};
  if (rawBody.length > 0) {
    try {
      candidate = JSON.parse(rawBody);
    } catch {
      return jsonResponse({ error: 'invalid_json', message: 'Body must be JSON or empty.' }, 400);
    }
  }

  const parsed = postBodySchema.safeParse(candidate);
  if (!parsed.success) {
    return jsonResponse(
      {
        error: 'invalid_body',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      400,
    );
  }

  /* Two contradictory intents in one body is an operator error, not a default. */
  if (parsed.data.on !== undefined && parsed.data.toggle === true) {
    return jsonResponse(
      {
        error: 'conflicting_intent',
        message: 'Send either "on" to set the switch or "toggle" to flip it, not both.',
      },
      400,
    );
  }

  if (!isStoreReady()) return storeUnconfigured();

  try {
    const current = await getSettings();
    /* An explicit `on` always wins; anything else means "flip it". */
    const next = parsed.data.on ?? !current.killSwitch;
    const changed = next !== current.killSwitch;

    const settings = changed ? await setKillSwitch(next) : current;

    const decision = !changed
      ? 'killswitch.unchanged'
      : next
        ? 'killswitch.engaged'
        : 'killswitch.released';
    const summary = !changed
      ? `The kill switch was already ${next ? 'on' : 'off'}, so nothing changed.`
      : next
        ? 'Kill switch engaged. Every worker halts at the top of its next tick.'
        : 'Kill switch released. Workers resume on their next tick.';

    await logEvent({
      agent: 'ceo',
      decision,
      summary: parsed.data.reason === undefined ? summary : `${summary} Reason given: ${parsed.data.reason}`,
      refs: {
        setting: 'kill_switch',
        from: current.killSwitch ? 'on' : 'off',
        to: next ? 'on' : 'off',
      },
    });

    return jsonResponse({ ...present(settings), changed }, 200);
  } catch (error) {
    console.error('[settings/kill-switch] write failed:', error);
    return jsonResponse(
      { error: 'store_unavailable', message: 'The kill switch could not be changed.' },
      503,
    );
  }
}
