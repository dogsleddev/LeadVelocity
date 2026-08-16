/**
 * The `settings` singleton: kill switch and replay clock state.
 *
 * This is the smallest table in the schema and the most load-bearing. Hard rule
 * #7 says every worker checks the kill switch at tick start, which means this
 * read happens more often than any other in the system and must never be the
 * reason a tick crashes.
 *
 * Fail-safe posture: if Supabase is not configured, `isKillSwitchOn()` reports
 * the value of `KILL_SWITCH_DEFAULT` rather than guessing "off". An operator who
 * ships with the switch defaulted on gets a halted system, not a runaway one.
 */
import { z } from 'zod';

import { killSwitchDefault } from '@/lib/config/deployment-env';

import {
  dbTimestamp,
  isStoreReady,
  nowIso,
  parseRow,
  requireClient,
  unwrap,
  unwrapMaybe,
} from './client';

/** Primary key of the one and only settings row (`settings_singleton` check). */
export const SETTINGS_ID = 'singleton';

/* -------------------------------------------------------------------------- */
/* Shape                                                                      */
/* -------------------------------------------------------------------------- */

const settingsRowSchema = z.object({
  id: z.string().min(1),
  kill_switch: z.boolean(),
  replay_speed_multiplier: z.coerce.number().int(),
  replay_active: z.boolean(),
  updated_at: dbTimestamp,
});

/** Camel-cased settings as the rest of the application sees them. */
export interface AppSettings {
  id: string;
  /** When true every worker must stop at the top of its tick. */
  killSwitch: boolean;
  /** How many times faster than wall-clock the replay harness releases records. */
  replaySpeedMultiplier: number;
  /** True while the demo is fed from the committed extract, not a live pull. */
  replayActive: boolean;
  updatedAt: string;
}

function toSettings(row: unknown, context: string): AppSettings {
  const parsed = parseRow(settingsRowSchema, row, context);
  return {
    id: parsed.id,
    killSwitch: parsed.kill_switch,
    replaySpeedMultiplier: parsed.replay_speed_multiplier,
    replayActive: parsed.replay_active,
    updatedAt: parsed.updated_at,
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Read the singleton, creating it if the migration's seed insert is missing.
 *
 * Self-healing is deliberate: a fresh database restored without the seed row
 * would otherwise leave every worker unable to check the kill switch.
 */
export async function getSettings(): Promise<AppSettings> {
  const client = requireClient('getSettings');

  const existing = unwrapMaybe(
    await client.from('settings').select('*').eq('id', SETTINGS_ID).maybeSingle(),
    'getSettings',
  );
  if (existing !== null) return toSettings(existing, 'settings');

  const created = unwrap(
    await client
      .from('settings')
      .upsert({ id: SETTINGS_ID }, { onConflict: 'id' })
      .select('*')
      .single(),
    'getSettings (seed singleton)',
  );
  return toSettings(created, 'settings');
}

/**
 * Kill-switch check for the top of a worker tick.
 *
 * Never throws. A database that cannot be reached is not permission to keep
 * running: the configured default answers instead.
 */
export async function isKillSwitchOn(): Promise<boolean> {
  if (!isStoreReady()) return killSwitchDefault();
  try {
    const settings = await getSettings();
    return settings.killSwitch;
  } catch {
    return killSwitchDefault();
  }
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

/** Flip the kill switch. Returns the settings row as it now stands. */
export async function setKillSwitch(on: boolean): Promise<AppSettings> {
  const client = requireClient('setKillSwitch');
  const row = unwrap(
    await client
      .from('settings')
      .upsert(
        { id: SETTINGS_ID, kill_switch: on, updated_at: nowIso() },
        { onConflict: 'id' },
      )
      .select('*')
      .single(),
    'setKillSwitch',
  );
  return toSettings(row, 'settings');
}

/**
 * Set replay mode and, optionally, its speed.
 *
 * The multiplier is left untouched when omitted so turning replay off and on
 * again does not quietly reset the demo pacing.
 */
export async function setReplayState(
  active: boolean,
  multiplier?: number,
): Promise<AppSettings> {
  const client = requireClient('setReplayState');

  const patch: {
    id: string;
    replay_active: boolean;
    updated_at: string;
    replay_speed_multiplier?: number;
  } = { id: SETTINGS_ID, replay_active: active, updated_at: nowIso() };

  if (multiplier !== undefined) {
    if (!Number.isFinite(multiplier) || multiplier < 1) {
      throw new Error(`setReplayState: multiplier must be >= 1, received ${multiplier}`);
    }
    patch.replay_speed_multiplier = Math.trunc(multiplier);
  }

  const row = unwrap(
    await client.from('settings').upsert(patch, { onConflict: 'id' }).select('*').single(),
    'setReplayState',
  );
  return toSettings(row, 'settings');
}
