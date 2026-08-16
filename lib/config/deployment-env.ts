/**
 * Deployment environment access.
 *
 * Origin: approach adapted from SiteVelocity's `lib/config/deployment-env.ts`.
 *
 * Two rules carried over from upstream:
 *
 * 1. Reading env NEVER throws at import time. A missing key degrades one
 *    capability, it does not take the process down. The health probe reports
 *    what is missing so a half-configured deploy is visible instead of silent.
 * 2. Secrets are presence-only in config. Values are never logged, never
 *    serialized into responses, and never written to the decision log.
 */

export type CapabilityName =
  | 'supabase'
  | 'stripe'
  | 'linq'
  | 'twilio'
  | 'anthropic'
  | 'terac'
  | 'soda';

/** Keys that must be present for a capability to be usable. */
const CAPABILITY_KEYS: Readonly<Record<CapabilityName, readonly string[]>> = Object.freeze({
  supabase: ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY'],
  stripe: ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'],
  // Linq is the delivery channel. Only the API key is required to send; the
  // webhook secret is checked separately because inbound can be wired later
  // than outbound without making the channel unusable.
  linq: ['LINQ_API_V3_API_KEY'],
  twilio: ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER'],
  anthropic: ['ANTHROPIC_API_KEY'],
  terac: ['TERAC_API_KEY'],
  soda: ['SODA_APP_TOKEN'],
});

function read(key: string): string | null {
  const raw = process.env[key];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Value or `null`. Never throws. */
export function optionalEnv(key: string): string | null {
  return read(key);
}

/**
 * Value or throw. Use only at the point of an actual outbound call, never at
 * module load, so an unconfigured capability fails one operation rather than
 * the whole process.
 */
export function requireEnv(key: string): string {
  const value = read(key);
  if (value === null) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

/** Value or the supplied fallback. */
export function envOr(key: string, fallback: string): string {
  return read(key) ?? fallback;
}

/** Integer-valued env with a fallback; non-numeric values fall back too. */
export function envInt(key: string, fallback: number): number {
  const raw = read(key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** True when every key backing `capability` is present. */
export function hasCapability(capability: CapabilityName): boolean {
  return CAPABILITY_KEYS[capability].every((key) => read(key) !== null);
}

/** Keys missing for `capability`, for the health probe and startup log. */
export function missingKeys(capability: CapabilityName): string[] {
  return CAPABILITY_KEYS[capability].filter((key) => read(key) === null);
}

/** Presence-only capability map. Safe to serialize into a health response. */
export function capabilityReport(): Record<CapabilityName, { ready: boolean; missing: string[] }> {
  const names = Object.keys(CAPABILITY_KEYS) as CapabilityName[];
  const out = {} as Record<CapabilityName, { ready: boolean; missing: string[] }>;
  for (const name of names) {
    out[name] = { ready: hasCapability(name), missing: missingKeys(name) };
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Typed accessors for the settings the app reads constantly                   */
/* -------------------------------------------------------------------------- */

export const appBaseUrl = (): string => envOr('APP_BASE_URL', 'http://localhost:3000');
export const anthropicModel = (): string => envOr('ANTHROPIC_MODEL', 'claude-sonnet-5');
export const replaySpeedMultiplier = (): number => envInt('REPLAY_SPEED_MULTIPLIER', 60);
export const demoPhoneNumber = (): string | null => optionalEnv('DEMO_PHONE_NUMBER');

/**
 * The published subscription price, in whole US dollars per month.
 *
 * THE ONE PLACE THIS NUMBER IS WRITTEN. It reaches a prospect in the Sales
 * message, a subscriber on the profile screen and the public sample, and the
 * owner as revenue on the operations console and the company dashboard. Those are
 * four surfaces quoting one commercial fact, and a build in which they can
 * disagree is a build that can bill a contractor one number while telling them
 * another.
 *
 * It was previously declared five times: three copies of this same
 * `envInt('SUBSCRIPTION_PRICE_USD', 149)` expression, and two bare
 * `const MONTHLY_PRICE_USD = 149` in the owner screens. The bare pair were not
 * merely duplicates, they were a different behaviour: setting the environment
 * variable moved the price in every message the company sent while both revenue
 * screens carried on reporting 149.
 *
 * A function rather than a `const`, for the same reason as its neighbours here: a
 * module-level constant would freeze whatever was set at build time, and this
 * value is read on a server that is configured at deploy.
 *
 * The 149 default is the kickoff persona's number (section 8, "149 a month
 * instead of a business development hire"). If Stripe ever becomes the source of
 * truth for the amount, this is the single function that changes.
 */
export const monthlyPriceUsd = (): number => envInt('SUBSCRIPTION_PRICE_USD', 149);

/** Kill switch default when the settings row has not been read yet. */
export const killSwitchDefault = (): boolean =>
  envOr('KILL_SWITCH_DEFAULT', 'off').toLowerCase() === 'on';

/** Worker tick cadences, seconds. */
export const tickSeconds = () => ({
  lead: envInt('LEAD_TICK_SECONDS', 45),
  sales: envInt('SALES_TICK_SECONDS', 120),
  customer: envInt('CUSTOMER_TICK_SECONDS', 30),
  ceo: envInt('CEO_TICK_SECONDS', 300),
});

/**
 * Stripe mode currently configured, derived from the key prefix rather than a
 * separate flag so the reported mode can never disagree with the key in use.
 * The event-day demo checkout must report `live` (kickoff section 10.3).
 */
export function stripeMode(): 'test' | 'live' | 'unset' {
  const key = read('STRIPE_SECRET_KEY');
  if (key === null) return 'unset';
  if (key.startsWith('sk_live_') || key.startsWith('rk_live_')) return 'live';
  return 'test';
}
