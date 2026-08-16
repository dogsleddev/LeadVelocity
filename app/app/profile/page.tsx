/**
 * S4, the subscriber's profile: the four answers that decide what gets sent.
 *
 * This screen is the plain-language view of one `customers` row. It is a
 * question-and-answer list rather than a settings form because that is what the
 * profile actually is: four things the contractor told us, which the scorer reads
 * on every permit. Reading it back in their own words is the point. A contractor
 * who cannot recognise their own answers cannot trust the leads that came out of
 * them.
 *
 * WHAT IS REAL HERE
 * -----------------
 * Every value on this page is a column on the primary customer row, rendered:
 *
 *   trade                                 ->  "What do you do?"
 *   territory_zips + territory_districts  ->  "Where do you work?"
 *   preferred_uses                        ->  "What projects do you want?"
 *   min_project_value                     ->  "Minimum job size?"
 *   effective_weights                     ->  whether replies have tuned it
 *   subscriptions row                     ->  the billing state and the price
 *
 * Two of those need translating rather than printing. `trade` is stored as an
 * engine key (`electrical`) and is shown the way a contractor says it
 * ("Commercial electrical"). `preferred_uses` holds the literal DataSF
 * controlled-vocabulary strings, truncations and all ("food/beverage hndlng",
 * "warehouse,no frnitur"), which are the right thing to store and the wrong thing
 * to show. The expansion comes from `useLabel` in `LeadCard`, which is the same
 * map the inbox and the detail screen use, so a use is worded identically
 * wherever the subscriber meets it. An unmapped code falls back to its own text
 * capitalised, so a vocabulary the city adds later renders as the city's word
 * rather than as a guess.
 *
 * TWO EMPTINESSES THAT ARE NOT THE SAME
 * -------------------------------------
 * Empty territory arrays are not a missing answer. The shortlist filter treats an
 * empty allowlist as "no territory restriction", so the honest rendering is "All
 * of San Francisco", not a blank list. Empty `preferred_uses` is the same kind of
 * fact and reads as "any commercial work". Neither is shown as unknown, because
 * neither is unknown.
 *
 * THE LEARNING LOOP IS SHOWN, OR ITS ABSENCE IS
 * ---------------------------------------------
 * `effective_weights` is the only part of the profile the feedback loop moves. All
 * five at 1 means no reply has changed anything yet, and the screen says exactly
 * that rather than dressing a neutral profile up as a tuned one. Any weight off 1
 * is listed with its direction, because that shift is the visible result of the
 * subscriber's own replies and it belongs to them.
 *
 * COPY RULES (hard rule #9): this is a customer-facing screen. No AI, agent,
 * autonomous, automated or LLM language, and no em dashes.
 *
 * STYLING: the shell, the palette and the shared classes come from
 * `app/app/contractor.css` by way of `app/app/layout.tsx`. The block at the foot
 * of this file adds only what that stylesheet does not already have, consumes its
 * `--lv-` tokens, and declares none of them.
 */
/*
 * Aliased on import: `useLabel` is a plain pure function, but its name matches
 * the React hook convention and calling it from a helper that is not a component
 * would read as a hook call to both a linter and a human.
 */
import { useLabel as buildingUseLabel } from '@/app/components/contractor/LeadCard';
import ProfileRow, {
  ProfileRowStyles,
  formatUsd,
  monthlyPriceUsd,
} from '@/app/components/contractor/ProfileRow';
import { missingKeys } from '@/lib/config/deployment-env';
import { tradeProfile } from '@/lib/domain/trades';
import {
  type CustomerRecord,
  type EffectiveWeights,
  type SubscriptionRecord,
  getPrimaryCustomer,
  getSubscriptionByCustomer,
  isStoreReady,
} from '@/lib/store';

/** The profile moves when feedback moves it; nothing here may be cached. */
export const dynamic = 'force-dynamic';

/* -------------------------------------------------------------------------- */
/* Vocabulary                                                                 */
/* -------------------------------------------------------------------------- */

/** The five score components, named the way a contractor would describe them. */
const WEIGHT_LABELS: Readonly<Record<keyof EffectiveWeights, string>> = Object.freeze({
  fit: 'How well the work matches',
  demand: 'How much work is in the job',
  timing: 'How fresh the permit is',
  value: 'What the job is worth',
  evidence: 'How well the facts check out',
});

/** Stable render order, so the list does not reshuffle between requests. */
const WEIGHT_ORDER: readonly (keyof EffectiveWeights)[] = [
  'fit',
  'demand',
  'timing',
  'value',
  'evidence',
];

const SUBSCRIPTION_STATUS_WORDS: Readonly<Record<SubscriptionRecord['status'], string>> =
  Object.freeze({
    active: 'Active',
    past_due: 'Payment past due',
    cancelled: 'Cancelled',
    inactive: 'Not started',
  });

const ACCOUNT_STATUS_WORDS: Readonly<Record<CustomerRecord['status'], string>> = Object.freeze({
  active: 'Active',
  paused: 'Paused',
  prospect: 'Not started',
  cancelled: 'Cancelled',
});

/* -------------------------------------------------------------------------- */
/* Formatting                                                                 */
/* -------------------------------------------------------------------------- */

const DAY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

function formatDay(iso: string | null): string | null {
  if (iso === null) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? DAY.format(new Date(ms)) : null;
}

/** "a", "a and b", "a, b and c". */
function sentenceList(items: readonly string[]): string {
  if (items.length === 0) return '';
  if (items.length === 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

function capitalize(text: string): string {
  return text.length === 0 ? text : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** "1.2" rather than "1.20", so a tuned weight reads as a number and not a price. */
function formatMultiplier(value: number): string {
  return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

/* -------------------------------------------------------------------------- */
/* Answers                                                                    */
/* -------------------------------------------------------------------------- */

/** "Commercial electrical". The trade label is the one in `lib/domain/trades.ts`. */
function tradeAnswer(customer: CustomerRecord): string {
  return capitalize(`Commercial ${tradeProfile(customer.trade).label}`);
}

/**
 * Territory in words.
 *
 * Both arrays empty is the common case and is a real answer, not a gap: the
 * shortlist filter reads an empty allowlist as no restriction at all.
 */
function territoryAnswer(customer: CustomerRecord): string {
  const districts = customer.territoryDistricts.filter((value) => value.trim().length > 0);
  const zips = customer.territoryZips.filter((value) => value.trim().length > 0);

  if (districts.length === 0 && zips.length === 0) return 'All of San Francisco';

  const parts: string[] = [];
  if (districts.length > 0) {
    parts.push(
      `Supervisor ${districts.length === 1 ? 'district' : 'districts'} ${sentenceList(districts)}`,
    );
  }
  if (zips.length > 0) {
    parts.push(`${zips.length === 1 ? 'Zip' : 'Zips'} ${sentenceList(zips)}`);
  }
  return `${parts.join('. ')}, San Francisco`;
}

/**
 * Preferred uses as phrases, expanded by the same map the lead screens use.
 *
 * `useLabel` reads `proposedUse` first and falls back to `existingUse`, so each
 * code is handed to it as a proposed use. That is the shape it wants, not a claim
 * about the permit.
 */
function usesAnswer(customer: CustomerRecord): string {
  const uses = customer.preferredUses.filter((value) => value.trim().length > 0);
  if (uses.length === 0) return 'Any commercial work';
  return sentenceList(
    uses.map((use) => buildingUseLabel({ proposedUse: use, existingUse: null }) ?? capitalize(use)),
  );
}

/* -------------------------------------------------------------------------- */
/* Tuning                                                                     */
/* -------------------------------------------------------------------------- */

interface WeightMove {
  key: keyof EffectiveWeights;
  label: string;
  weight: number;
  direction: 'up' | 'down';
}

/** Components the feedback loop has moved off the neutral 1. */
function weightMoves(weights: EffectiveWeights): WeightMove[] {
  const moves: WeightMove[] = [];
  for (const key of WEIGHT_ORDER) {
    const weight = weights[key];
    if (!Number.isFinite(weight) || weight === 1) continue;
    moves.push({ key, label: WEIGHT_LABELS[key], weight, direction: weight > 1 ? 'up' : 'down' });
  }
  return moves;
}

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

interface ProfileView {
  customer: CustomerRecord;
  subscription: SubscriptionRecord | null;
}

type LoadResult =
  | { state: 'unconfigured'; missing: string[] }
  | { state: 'failed'; message: string }
  | { state: 'empty' }
  | { state: 'ok'; view: ProfileView };

async function load(): Promise<LoadResult> {
  if (!isStoreReady()) return { state: 'unconfigured', missing: missingKeys('supabase') };

  try {
    const customer = await getPrimaryCustomer();
    if (customer === null) return { state: 'empty' };
    const subscription = await getSubscriptionByCustomer(customer.id);
    return { state: 'ok', view: { customer, subscription } };
  } catch (error) {
    return { state: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

/* -------------------------------------------------------------------------- */
/* Page                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A degraded state, in the shell's own notice treatment.
 *
 * `data-lv-screen` still says profile, so the tab the subscriber pressed stays
 * lit while they read why the screen has nothing on it.
 */
function Notice({ title, body, keys }: { title: string; body: string; keys?: string }) {
  return (
    <section className="lv-screen-fill" data-lv-screen="profile">
      <ProfileStyles />
      <div className="lv-screen-head">
        <h1 className="lv-screen-title">Profile</h1>
      </div>
      <div className="lv-notice">
        <p className="lv-notice-title">{title}</p>
        <p className="lv-notice-body">{body}</p>
        {keys === undefined ? null : <p className="lv-notice-keys">{keys}</p>}
      </div>
    </section>
  );
}

export default async function ContractorProfilePage() {
  const result = await load();

  if (result.state === 'unconfigured') {
    return (
      <Notice
        title="Your profile is not reachable right now"
        body="This account is held in a database this deployment cannot reach, so nothing is shown rather than something approximate."
        keys={`Missing: ${result.missing.join(', ')}`}
      />
    );
  }

  if (result.state === 'failed') {
    return (
      <Notice
        title="Your profile could not be loaded"
        body="The account is there; reading it failed on this request."
        keys={result.message}
      />
    );
  }

  if (result.state === 'empty') {
    return (
      <Notice
        title="No profile is set up yet"
        body="Once an account is opened, the four answers that decide which jobs get sent to you will show here."
      />
    );
  }

  const { customer, subscription } = result.view;
  const moves = weightMoves(customer.effectiveWeights);
  const price = formatUsd(monthlyPriceUsd());
  const updated = formatDay(customer.updatedAt);
  const renewal = subscription === null ? null : formatDay(subscription.currentPeriodEnd);
  const unrestricted =
    customer.territoryZips.length === 0 && customer.territoryDistricts.length === 0;

  const billingWord =
    subscription === null
      ? ACCOUNT_STATUS_WORDS[customer.status]
      : SUBSCRIPTION_STATUS_WORDS[subscription.status];

  return (
    <section className="lv-screen-fill" data-lv-screen="profile">
      <ProfileStyles />
      <ProfileRowStyles />

      <div className="lv-screen-head">
        <h1 className="lv-screen-title">Profile</h1>
        <p className="lv-screen-sub">
          {customer.businessName}. Your answers decide what we send you.
        </p>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* The four answers                                                    */}
      {/* ------------------------------------------------------------------ */}
      <div className="lvp-rows">
        <ProfileRow question="What do you do?" answer={tradeAnswer(customer)} />
        <ProfileRow
          question="Where do you work?"
          answer={territoryAnswer(customer)}
          note={
            unrestricted
              ? 'No area is ruled out, so every commercial permit in the city is read for you.'
              : undefined
          }
        />
        <ProfileRow
          question="What projects do you want?"
          answer={usesAnswer(customer)}
          note="Matched against the building use the city records on the permit."
        />
        <ProfileRow
          question="Minimum job size?"
          answer={formatUsd(customer.minProjectValue)}
          note="Judged on the valuation declared on the permit."
        />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* What replies have changed                                           */}
      {/* ------------------------------------------------------------------ */}
      <div className="lvp-section">
        <h2 className="lvp-section-title">What your replies have changed</h2>

        {moves.length === 0 ? (
          <div className="lvp-panel">
            <p className="lvp-panel-body">
              Nothing has moved yet. Every time you mark a lead good, too small, or the wrong scope,
              the weighting behind your next lead shifts, and the change shows up here.
            </p>
          </div>
        ) : (
          <>
            <div className="lvp-chips">
              {moves.map((move) => (
                <span
                  key={move.key}
                  className={
                    move.direction === 'up' ? 'lvp-chip lvp-chip--up' : 'lvp-chip lvp-chip--down'
                  }
                >
                  {move.label} {move.direction === 'up' ? '↑' : '↓'}{' '}
                  <span className="lvp-chip-num">x{formatMultiplier(move.weight)}</span>
                </span>
              ))}
            </div>
            <p className="lvp-note">
              Tuned from how you rated the leads you were sent. The four answers above are still
              exactly what you told us. Only the weighting behind them has moved.
            </p>
          </>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Subscription                                                        */}
      {/* ------------------------------------------------------------------ */}
      <div className="lvp-section">
        <h2 className="lvp-section-title">Subscription</h2>
        <div className="lvp-panel">
          <div className="lvp-billing">
            <span
              className={
                billingWord === 'Active' ? 'lvp-chip lvp-chip--up' : 'lvp-chip lvp-chip--flat'
              }
            >
              {billingWord}
            </span>
            <span className="lvp-price">
              {price} <span className="lvp-price-unit">per month</span>
            </span>
          </div>

          <p className="lvp-panel-body">
            {renewal === null ? 'Cancel anytime.' : `Next renewal ${renewal}. Cancel anytime.`}
          </p>

          {subscription === null ? (
            <p className="lvp-note">
              No billing record is attached to this account yet, so the state above is the account
              state rather than a payment state.
            </p>
          ) : subscription.stripeSubscriptionId === null ? (
            <p className="lvp-note">
              This account was opened directly for the demonstration, so there is no card on file.
            </p>
          ) : null}
        </div>
      </div>

      <p className="lv-foot-note">
        These four answers were set when the account opened. To change one, reply to any lead and
        say so.
        {updated === null ? '' : ` Profile last changed on ${updated}.`}
      </p>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

/*
 * Only what `contractor.css` does not already provide: the row column, the two
 * labelled sections, the tuning chips and the price line. Every colour, radius
 * and font is a `--lv-` token declared on `.lv-app` in that stylesheet, so this
 * screen cannot hold a second opinion about the palette. The literals are
 * fallbacks for a render outside the shell, not a copy of it.
 */
const PROFILE_CSS = `
.lvp-rows {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 4px 20px 16px;
}
.lvp-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 20px 16px;
}
.lvp-section-title {
  margin: 0;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: .06em;
  text-transform: uppercase;
  color: var(--lv-muted, #66788a);
}
.lvp-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 14px;
  border: 1px solid var(--lv-line, #d9e3ec);
  border-radius: var(--lv-radius-sm, 12px);
  background: var(--lv-card, #ffffff);
}
.lvp-panel-body {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--lv-ink-2, #3a4c61);
  text-wrap: pretty;
}
.lvp-note {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--lv-faint, #7d8a97);
  text-wrap: pretty;
}
.lvp-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 12px 14px;
  border: 1px solid var(--lv-line, #d9e3ec);
  border-radius: var(--lv-radius-sm, 12px);
  background: var(--lv-card, #ffffff);
}
.lvp-chip {
  padding: 4px 10px;
  border: 1px solid transparent;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}
.lvp-chip--up {
  background: var(--lv-green-soft, #e9f6ef);
  color: var(--lv-green, #24966a);
  border-color: var(--lv-green-line, #bee3cf);
}
.lvp-chip--down {
  background: var(--lv-hair, #edf3f9);
  color: var(--lv-muted, #66788a);
  border-color: var(--lv-line, #d9e3ec);
}
.lvp-chip--flat {
  background: transparent;
  color: var(--lv-faint, #7d8a97);
  border-color: var(--lv-line, #d9e3ec);
}
.lvp-chip-num { font-weight: 700; }
.lvp-billing {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
}
.lvp-price {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: -0.01em;
  color: var(--lv-ink, #132238);
}
.lvp-price-unit {
  font-size: 13px;
  font-weight: 600;
  color: var(--lv-muted, #66788a);
}
`;

function ProfileStyles() {
  return <style dangerouslySetInnerHTML={{ __html: PROFILE_CSS }} />;
}
