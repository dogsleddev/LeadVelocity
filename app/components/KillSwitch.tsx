'use client';

/**
 * KillSwitch: the one control on these screens that changes what the company does.
 *
 * Hard rule #7 says every worker checks the kill switch at the top of its tick.
 * This is the human end of that rule: one button, one row in `settings`, and a
 * state readout that is never inferred from the click. The initial state is read
 * on the server by the page and passed in, so the button always opens showing
 * what the database actually holds rather than what the last visitor did.
 *
 * ROUTE CONTRACT (owned by the API layer, not by this component)
 * -------------------------------------------------------------
 * Request:  POST /api/settings/kill-switch  with JSON body `{ "on": boolean }`.
 * Response: JSON carrying the state as it now stands. Three shapes are accepted,
 *           `{ killSwitch }`, `{ on }`, and `{ settings: { killSwitch } }`,
 *           because the route is another agent's file and this component must not
 *           break the demo over a key name. Whatever comes back is what gets
 *           displayed; the optimistic value is never trusted on its own.
 *
 * On any failure the previous state is restored and the reason is shown in place.
 * A control that silently pretends to have halted the company would be worse than
 * no control at all.
 *
 * After a successful flip the route is asked for a refresh of the server-rendered
 * page, so the decision log below picks up the halt entry the workers write.
 */

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { z } from 'zod';

/** Every response shape this component will accept. Extra keys are ignored. */
const responseSchema = z.object({
  killSwitch: z.boolean().optional(),
  on: z.boolean().optional(),
  settings: z.object({ killSwitch: z.boolean() }).optional(),
  /** Machine code on a rejected request, e.g. `invalid_json`. */
  error: z.string().optional(),
  /** Human explanation, preferred over `error` when the route sends both. */
  message: z.string().optional(),
});

/** Pull the authoritative state out of whichever shape the route returned. */
function readState(payload: unknown): boolean | null {
  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) return null;
  const { killSwitch, on, settings } = parsed.data;
  if (typeof killSwitch === 'boolean') return killSwitch;
  if (typeof on === 'boolean') return on;
  if (settings !== undefined) return settings.killSwitch;
  return null;
}

export interface KillSwitchProps {
  /** State read from the `settings` row when the page rendered. */
  initialOn: boolean;
  /** False when the store is unconfigured; the control disables and says why. */
  available: boolean;
}

export default function KillSwitch({ initialOn, available }: KillSwitchProps) {
  const [on, setOn] = useState<boolean>(initialOn);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  async function flip(): Promise<void> {
    const next = !on;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/settings/kill-switch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ on: next }),
        cache: 'no-store',
      });

      const payload: unknown = await response.json().catch(() => null);

      if (!response.ok) {
        const parsed = responseSchema.safeParse(payload);
        const detail = parsed.success
          ? (parsed.data.message ?? parsed.data.error ?? null)
          : null;
        setError(detail ?? `request failed with status ${response.status}`);
        return;
      }

      // Trust the server's answer over the optimistic one. If the route replies
      // with a shape this component does not recognise, fall back to what was
      // requested rather than leaving the readout blank.
      setOn(readState(payload) ?? next);
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'the request did not complete');
    } finally {
      setBusy(false);
    }
  }

  if (!available) {
    return (
      <div className="kill">
        <p className="stat-label">Kill switch</p>
        <p className="kill-state">unavailable</p>
        <p className="stat-note">
          The settings row lives in Supabase, which is not configured in this deployment. The
          control is disabled rather than showing a state it cannot read.
        </p>
      </div>
    );
  }

  const working = busy || pending;

  return (
    <div className={on ? 'kill kill--on' : 'kill'}>
      <p className="stat-label">Kill switch</p>
      <p className="kill-state">{on ? 'halted' : 'running'}</p>
      <p className="stat-note">
        {on
          ? 'Every worker stops at the top of its next tick. Nothing is scored, sent, or charged while this is set.'
          : 'Workers check this flag before doing anything. Flip it and the next tick stops.'}
      </p>
      <button
        type="button"
        className={`kill-button ${on ? 'kill-button--resume' : 'kill-button--halt'}`}
        onClick={() => {
          void flip();
        }}
        disabled={working}
      >
        {working ? 'Working...' : on ? 'Resume the company' : 'Halt the company'}
      </button>
      {error === null ? null : <p className="kill-error">Could not change the switch: {error}</p>}
    </div>
  );
}
