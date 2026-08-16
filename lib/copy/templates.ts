/**
 * Customer-facing copy, and the policy that keeps it honest.
 *
 * Every string this company sends to a human lives in this file. That is
 * deliberate: CLAUDE.md hard rule #9 says the technology is the engine and never
 * the pitch, and a rule spread across twelve files is a rule nobody can audit.
 * One file means one place to read, one place to test, one place to fix.
 *
 * Two things live here:
 *
 * 1. The policy. `BANNED_LANGUAGE_PATTERN` and `EM_DASH_PATTERN` encode rule #9
 *    and the no-em-dash convention. `assertCustomerSafe` is the hard guard that
 *    the Twilio adapter calls before anything leaves the building, so a violation
 *    fails loudly at the send site rather than landing on a subscriber's phone.
 *
 * 2. The copy itself. `sampleOutreachVariants`, `opportunitySms` and
 *    `checkoutInviteSms` build messages from a typed context. They sell the
 *    contractor's problem and outcome: what the job is, why it fits, who to call,
 *    why now.
 *
 * This module is PURE (CLAUDE.md conventions): no network, no clock, no fs, no
 * random. Anything time-derived (how many days ago a permit issued) arrives as an
 * explicit field on the context so the same input always renders the same string.
 *
 * Nothing here invents a fact. Every optional field is `null`-able and the copy
 * simply omits the clause when the value is absent, matching the evidence model:
 * an unknown is left out, never guessed at.
 */

/* -------------------------------------------------------------------------- */
/* Policy: the words that must never reach a customer                          */
/* -------------------------------------------------------------------------- */

/**
 * Language that gives away the machinery instead of selling the job.
 *
 * The base list is fixed by CLAUDE.md hard rule #9 (AI, agent, autonomous,
 * automated, LLM). The rest are the obvious near misses that would violate the
 * same rule while slipping past a literal reading: vendor names, "artificial
 * intelligence" spelled out, and the other inflections of "automate".
 *
 * Written as a single exported constant so the guard, the templates and the test
 * all check the exact same thing.
 */
export const BANNED_LANGUAGE_PATTERN: RegExp =
  /\b(?:A\.?I\.?|artificial intelligence|machine learning|agent|agents|agentic|autonomous|autonomously|automat(?:e|es|ed|ing|ion|ic|ically)|LLM|LLMs|GPT|chatbot|robot|neural|Anthropic|Claude)\b/i;

/**
 * Em dash (U+2014) and horizontal bar (U+2015).
 *
 * Banned in customer-facing and judge-facing copy by convention. En dashes are
 * left alone because they are legitimate in numeric ranges.
 */
export const EM_DASH_PATTERN: RegExp = /[—―]/;

/** Every SMS this company sends stays inside two message segments of GSM-7. */
export const SMS_CHARACTER_LIMIT = 320;

/** One reason a string is not fit to send. */
export interface CopyViolation {
  /** Which policy tripped. */
  rule: 'banned-language' | 'em-dash';
  /** The offending substring, so the error message can point at it. */
  match: string;
  /** Zero-based index of the match in the checked string. */
  index: number;
}

/**
 * All policy violations in `text`, in the order they appear.
 *
 * Returns an empty array for compliant copy. Pure and side-effect free, so it is
 * safe to call on every render as well as in tests.
 */
export function findCopyViolations(text: string): CopyViolation[] {
  const violations: CopyViolation[] = [];

  const banned = new RegExp(BANNED_LANGUAGE_PATTERN.source, 'gi');
  for (const hit of text.matchAll(banned)) {
    violations.push({ rule: 'banned-language', match: hit[0], index: hit.index ?? 0 });
  }

  const dashes = new RegExp(EM_DASH_PATTERN.source, 'g');
  for (const hit of text.matchAll(dashes)) {
    violations.push({ rule: 'em-dash', match: hit[0], index: hit.index ?? 0 });
  }

  return violations.sort((a, b) => a.index - b.index);
}

/** True when `text` is safe to put in front of a customer. */
export function isCustomerSafe(text: string): boolean {
  return findCopyViolations(text).length === 0;
}

/**
 * Hard guard. Throws when `text` violates rule #9 or the em dash convention.
 *
 * Called by the Twilio adapter immediately before send, which is the last point
 * where a violation is still cheap. Throwing is correct here: a message that
 * breaks rule #9 is a build failure, not a degraded capability, so it must never
 * be swallowed into a soft "skipped" result.
 */
export function assertCustomerSafe(text: string, label: string): void {
  const violations = findCopyViolations(text);
  if (violations.length === 0) return;

  const detail = violations
    .map((v) => `${v.rule} "${v.match}" at index ${v.index}`)
    .join('; ');
  throw new Error(
    `Customer-facing copy check failed for ${label}: ${detail}. ` +
      'Customer-facing copy sells the job and the outcome, never the technology ' +
      '(CLAUDE.md hard rule 9), and never uses em dashes.',
  );
}

/* -------------------------------------------------------------------------- */
/* Context types                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Everything the copy is allowed to say about one opportunity.
 *
 * Nullable fields are facts we may not have. The templates drop the clause rather
 * than filling a gap, which is the copy-layer expression of the evidence model.
 */
export interface OpportunityCopyContext {
  /** Subscriber's first name, e.g. "Mike". Null renders an impersonal opener. */
  contactFirstName: string | null;
  /** Street address of the project, e.g. "555 California St". */
  projectAddress: string;
  /** Neighbourhood as the city publishes it, e.g. "Financial District/South Beach". */
  neighborhood: string | null;
  /** Project valuation in whole US dollars, or null when the permit omits it. */
  valuationUsd: number | null;
  /** Plain description of the work, in the subscriber's language. */
  scopeSummary: string;
  /** General contractor firm name, when a contact row names one. */
  generalContractor: string | null;
  /** Named individual to ask for, when one is on the permit. */
  contactName: string | null;
  /** The gap that makes this worth a call, e.g. "no electrical contractor is on the permit yet". */
  openingReason: string | null;
  /** Whole days between permit issue and now, supplied by the caller so this stays pure. */
  daysSinceIssued: number | null;
  /** Absolute URL of the opportunity detail page. */
  detailUrl: string;
}

/**
 * Context for prospect-facing copy: the sample message and the checkout invite.
 *
 * Carries one real opportunity (prospects are shown a real job, never a mock, per
 * hard rule #5) plus the terms of the offer.
 */
export interface OutreachCopyContext {
  /** Prospect's first name, e.g. "Mike". */
  contactFirstName: string | null;
  /** Territory in the words a contractor would use, e.g. "San Francisco". */
  territoryLabel: string;
  /** The sample opportunity being shown off. */
  opportunity: OpportunityCopyContext;
  /** Subscription price in whole US dollars per month. */
  priceMonthlyUsd: number;
  /** Floor on project value the subscriber cares about, in whole US dollars. */
  minProjectValueUsd: number;
  /** Absolute URL the prospect should open (sample page or checkout link). */
  actionUrl: string;
}

/** One candidate message in the ranking study. */
export interface CopyVariant {
  /** Stable id used as the study variant key and the winner reference. */
  id: 'a' | 'b' | 'c';
  /** Short internal name for the angle, never shown to a customer. */
  angle: string;
  /** The message as it would be sent. */
  text: string;
}

/* -------------------------------------------------------------------------- */
/* Formatting helpers (pure)                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Money the way a contractor says it out loud: "$8.3M", "$450k", "$900".
 *
 * Hand rolled rather than `Intl.NumberFormat` so the output cannot drift with the
 * host locale. Non-finite and negative inputs return null so the clause is
 * dropped instead of rendering nonsense.
 */
export function formatProjectValue(valueUsd: number | null): string | null {
  if (valueUsd === null || !Number.isFinite(valueUsd) || valueUsd <= 0) return null;

  if (valueUsd >= 1_000_000) {
    const millions = valueUsd / 1_000_000;
    const rendered = millions >= 100 ? Math.round(millions).toString() : trimZero(millions.toFixed(1));
    return `$${rendered}M`;
  }
  if (valueUsd >= 1_000) {
    return `$${Math.round(valueUsd / 1_000)}k`;
  }
  return `$${Math.round(valueUsd)}`;
}

function trimZero(fixed: string): string {
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

/**
 * How recent the permit is, phrased for a person.
 *
 * `daysSinceIssued` is supplied by the caller (this module never reads a clock).
 * Negative values mean the caller handed us a future date, which we decline to
 * narrate rather than guess at.
 */
export function formatIssuedRecency(daysSinceIssued: number | null): string | null {
  if (daysSinceIssued === null || !Number.isFinite(daysSinceIssued) || daysSinceIssued < 0) {
    return null;
  }
  const days = Math.floor(daysSinceIssued);
  if (days === 0) return 'issued today';
  if (days === 1) return 'issued yesterday';
  if (days <= 45) return `issued ${days} days ago`;
  return null;
}

/** Greeting that degrades to nothing when we do not know the name. */
function opener(firstName: string | null): string | null {
  const trimmed = firstName?.trim() ?? '';
  return trimmed.length > 0 ? `${trimmed},` : null;
}

/** Collapse whitespace so assembled segments never render double spaces. */
function tidy(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Clamp at a word boundary with an ASCII ellipsis. Never splits a word. */
function clamp(text: string, maxChars: number): string {
  const tidied = tidy(text);
  if (tidied.length <= maxChars) return tidied;
  const cut = tidied.slice(0, Math.max(0, maxChars - 3));
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > 20 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[.,;:]$/, '')}...`;
}

/**
 * One clause of a message, plus how it gives way when the message runs long.
 *
 * A clause can be reduced in two ways: shortened to `fallback`, or cut entirely.
 * `shortenAt` and `cutAt` are positions on ONE shared ordinal scale, so a template
 * can say "shorten the address before you cut the timing line, but cut the
 * greeting before you shorten the contractor name". Two separate passes could not
 * express that, and the ordering is exactly where the editorial judgement lives.
 *
 * Both are optional. A clause with neither is load bearing and survives intact.
 */
interface Segment {
  text: string | null;
  /** Shorter wording used once the reduction at `shortenAt` fires. */
  fallback?: string;
  shortenAt?: number;
  cutAt?: number;
}

/**
 * Assemble clauses plus a trailing call to action inside the SMS limit.
 *
 * The call to action carries the link, so its length is reserved up front and it
 * is never touched. Reductions are then applied in ordinal order until the body
 * fits. If the load-bearing clauses alone still overflow, the body is clamped at
 * a word boundary, which cannot eat the link because the link is not in the body.
 *
 * Deterministic: the same context always yields the same string.
 */
function composeSms(segments: readonly Segment[], callToAction: string, limit: number): string {
  const cta = tidy(callToAction);
  const budget = limit - cta.length - 1;
  if (budget <= 0) return cta.slice(0, limit);

  const shortened = new Set<number>();
  const cut = new Set<number>();

  const reductions: { at: number; kind: 'shorten' | 'cut'; index: number }[] = [];
  segments.forEach((segment, index) => {
    if (segment.shortenAt !== undefined && segment.fallback !== undefined) {
      reductions.push({ at: segment.shortenAt, kind: 'shorten', index });
    }
    if (segment.cutAt !== undefined) {
      reductions.push({ at: segment.cutAt, kind: 'cut', index });
    }
  });
  reductions.sort((a, b) => a.at - b.at);

  const render = (): string =>
    tidy(
      segments
        .map((segment, index) => {
          if (cut.has(index)) return null;
          const text = shortened.has(index) ? (segment.fallback ?? segment.text) : segment.text;
          return text !== null && text !== undefined && text.trim().length > 0 ? text.trim() : null;
        })
        .filter((text): text is string => text !== null)
        .join(' '),
    );

  let body = render();
  for (const reduction of reductions) {
    if (body.length <= budget) break;
    if (reduction.kind === 'shorten') shortened.add(reduction.index);
    else cut.add(reduction.index);
    body = render();
  }

  if (body.length > budget) body = clamp(body, budget);

  /*
   * Clauses are authored to follow the greeting, so they start lowercase. Cutting
   * the greeting would otherwise leave a sentence starting mid-thought, so the
   * first character is capitalized here rather than in six places above. Every
   * template orders its reductions so the greeting goes before the clause behind
   * it, which keeps this a one character fix and not a grammar engine.
   */
  return body.length > 0 ? `${capitalize(body)} ${cta}` : cta;
}

/* -------------------------------------------------------------------------- */
/* Templates                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The opportunity alert sent to an active subscriber.
 *
 * Order is the order a contractor cares about: where the job is, what the work
 * is, what it is worth, who is running it, what the opening is, and the link with
 * the contact detail. Everything after "where and what" is droppable so a permit
 * with a long address still fits in two segments.
 */
export function opportunitySms(ctx: OpportunityCopyContext): string {
  const value = formatProjectValue(ctx.valuationUsd);
  const recency = formatIssuedRecency(ctx.daysSinceIssued);
  const scope = clamp(ctx.scopeSummary, 110);

  const hasNeighborhood = ctx.neighborhood !== null && ctx.neighborhood.trim().length > 0;
  const addressOnly = `new permit at ${ctx.projectAddress}:`;

  const gc = ctx.generalContractor;
  const gcShort = gc !== null ? `${gc} is running it.` : null;
  const gcFull = gc !== null && ctx.contactName !== null ? `${gc} is running it, ask for ${ctx.contactName}.` : gcShort;

  /*
   * Reduction order, most expendable first: the neighbourhood (the street
   * address already places the job), then the timing line, then the greeting,
   * then the contact name, then the value, and only last the contractor. The
   * contractor is the answer to "who do I call", which is the entire reason a
   * subscriber pays, so it is the last thing to go.
   */
  const segments: Segment[] = [
    { text: opener(ctx.contactFirstName), cutAt: 3 },
    {
      text: hasNeighborhood ? `new permit at ${ctx.projectAddress} (${ctx.neighborhood}):` : addressOnly,
      fallback: addressOnly,
      shortenAt: 1,
    },
    { text: `${scope}.` },
    { text: value !== null ? `${value} job.` : null, cutAt: 5 },
    { text: gcFull, fallback: gcShort ?? undefined, shortenAt: 4, cutAt: 6 },
    { text: ctx.openingReason !== null ? `${capitalize(ctx.openingReason)}.` : null },
    { text: recency !== null ? `Permit ${recency}, trades are being lined up now.` : null, cutAt: 2 },
  ];

  const text = composeSms(segments, `Detail and contact: ${ctx.detailUrl}`, SMS_CHARACTER_LIMIT);
  assertCustomerSafe(text, 'opportunitySms');
  return text;
}

/**
 * The checkout invite: sent after a prospect has already been shown a real job.
 *
 * Says what they get, how often, what it costs, and how to start. Carries the
 * opt-out because it is a commercial message to a number that did not ask for it.
 */
export function checkoutInviteSms(ctx: OutreachCopyContext): string {
  const floor = formatProjectValue(ctx.minProjectValueUsd);

  /*
   * The opt-out is never cut. This is a commercial message to a number that did
   * not ask for it, so "Reply STOP" is not a nicety that yields to a character
   * budget. The greeting goes before the clause that follows it, so cutting never
   * strands a sentence mid-thought.
   */
  const segments: Segment[] = [
    { text: opener(ctx.contactFirstName), cutAt: 1 },
    { text: `that came off a ${ctx.territoryLabel} permit filed this week.`, cutAt: 2 },
    {
      text: 'You get every one that fits your shop the day the permit lands: the work, the value, and who to call.',
    },
    { text: floor !== null ? `Nothing under ${floor}, nothing residential.` : null, cutAt: 3 },
    { text: `$${ctx.priceMonthlyUsd} a month, cancel any time.` },
    { text: 'Reply STOP to opt out.' },
  ];

  const text = composeSms(segments, `Start: ${ctx.actionUrl}`, SMS_CHARACTER_LIMIT);
  assertCustomerSafe(text, 'checkoutInviteSms');
  return text;
}

/**
 * Three genuinely different pitches for the same offer, for the GenPop study.
 *
 * They differ in argument, not in wording: (a) leads with the evidence, (b) leads
 * with the cost of finding out late, (c) leads with the plain mechanics of the
 * deal. Ranking three paraphrases of one angle would tell us nothing, so the test
 * enforces that they stay lexically distinct.
 *
 * The winner is chosen deterministically from the panel numbers in
 * `lib/integrations/terac.ts`. No model picks it and no human picks it.
 */
export function sampleOutreachVariants(ctx: OutreachCopyContext): CopyVariant[] {
  const opp = ctx.opportunity;
  const value = formatProjectValue(opp.valuationUsd);
  const floor = formatProjectValue(ctx.minProjectValueUsd);
  const scope = clamp(opp.scopeSummary, 90);
  const cta = `${ctx.actionUrl}`;

  /*
   * WHAT THE CALL TO ACTION MAY CLAIM ABOUT THE LINK.
   *
   * `ctx.actionUrl` is the public sample screen, and that screen shows the
   * highest scoring job on the board, not the job these three texts name and
   * quote. See the note in `buildOutreachContext` in `lib/agents/sales-agent.ts`
   * for why. So the label offers the linked page as an example of what arrives,
   * which is true, and never as this job's own record, which would not be.
   *
   * This is the difference between "here is the record" and "here is a live one",
   * and under hard rule #3 it is not a stylistic difference. If a per-permit
   * sample screen is ever built, these labels can go back to naming the record.
   */

  /* (a) Evidence first. The specific job, the specific gap. */
  const evidenceLed = composeSms(
    [
      { text: opener(ctx.contactFirstName), cutAt: 3 },
      { text: `a permit just issued at ${opp.projectAddress}:` },
      { text: `${scope}.` },
      { text: value !== null ? `Worth ${value}.` : null, cutAt: 1 },
      { text: opp.generalContractor !== null ? `${opp.generalContractor} holds the job.` : null, cutAt: 2 },
      { text: opp.openingReason !== null ? `${capitalize(opp.openingReason)}.` : null },
    ],
    `Here is a live one: ${cta}`,
    SMS_CHARACTER_LIMIT,
  );

  /* (b) Loss first. What it costs to hear about this job late. */
  const lossLed = composeSms(
    [
      { text: opener(ctx.contactFirstName), cutAt: 3 },
      {
        text: `by the time a job like ${opp.projectAddress} reaches a bid list, the electrical is usually spoken for.`,
      },
      {
        text: `We read every ${ctx.territoryLabel} permit the week it issues, while the builder is still filling out the trades.`,
      },
      { text: value !== null ? `This one is ${value}.` : null, cutAt: 1 },
      { text: 'You would have had a two week head start.', cutAt: 2 },
    ],
    `See what we send: ${cta}`,
    SMS_CHARACTER_LIMIT,
  );

  /* (c) Deal first. No story, just the terms. */
  const dealLed = composeSms(
    [
      { text: opener(ctx.contactFirstName), cutAt: 3 },
      { text: `one text per qualified ${ctx.territoryLabel} job: what the work is, what it is worth, and who to call.` },
      { text: floor !== null ? `Nothing under ${floor}, nothing residential.` : null, cutAt: 2 },
      { text: `$${ctx.priceMonthlyUsd} a month, cancel any time.` },
      { text: 'Every sample we send is a live job, never a demo.', cutAt: 1 },
    ],
    `See it: ${cta}`,
    SMS_CHARACTER_LIMIT,
  );

  const variants: CopyVariant[] = [
    { id: 'a', angle: 'evidence-led', text: evidenceLed },
    { id: 'b', angle: 'loss-led', text: lossLed },
    { id: 'c', angle: 'deal-led', text: dealLed },
  ];

  for (const variant of variants) {
    assertCustomerSafe(variant.text, `sampleOutreachVariants[${variant.id}]`);
  }
  return variants;
}

function capitalize(text: string): string {
  const tidied = tidy(text);
  if (tidied.length === 0) return tidied;
  return `${tidied.charAt(0).toUpperCase()}${tidied.slice(1)}`;
}
