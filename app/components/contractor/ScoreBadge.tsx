/**
 * The score pill: "92 / 100 - High Priority".
 *
 * WHAT THIS IS
 * ------------
 * The one place in the contractor app that decides what a number means. Three
 * tiers, each with a word and a colour, defined once in {@link SCORE_TIERS} and
 * read by every screen that shows a score. The inbox, the opportunity detail and
 * the public sample must never disagree about whether an 88 is "Qualified", so
 * none of them are allowed to spell that word themselves.
 *
 * WHY THE THRESHOLD IS IMPORTED RATHER THAN RESTATED
 * --------------------------------------------------
 * `LEAD_SCORE_THRESHOLD` is the number the business turns on: at or above it a
 * project is worth a subscriber's time, below it the project is archived. That
 * value lives with the arithmetic in `lib/calculations/scoring/lead-score.ts`,
 * and the boundary between "Qualified" and "Below the bar" IS that value. Typing
 * `80` here would let the copy and the engine drift apart on the day someone
 * changes the company's appetite.
 *
 * `HIGH_PRIORITY_MINIMUM` is a presentation decision rather than a scoring one:
 * it splits the leads that cleared the bar into "worth a call today" and "worth a
 * call". It is the prototype's 90 and it does not affect what gets delivered.
 *
 * A NOTE ON THE THIRD TIER
 * ------------------------
 * The prototype only ever shows the two cleared tiers, because its mock inbox
 * only contains leads that cleared. Real rows can be scored and still sit under
 * the bar, and the honest thing is to say so rather than to dress a 62 up in the
 * same blue as an 88. "Below the bar" is the same language the empty inbox uses,
 * so the two states read as one idea.
 */
import { LEAD_SCORE_THRESHOLD } from '@/lib/calculations/scoring/lead-score';

/* -------------------------------------------------------------------------- */
/* Tiers                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Where a cleared lead becomes an urgent one. Presentation only: it changes the
 * colour and the word, never whether the lead is delivered.
 */
export const HIGH_PRIORITY_MINIMUM = 90;

/** The three colour treatments, matching the prototype's palette. */
export type ScoreTone = 'green' | 'blue' | 'muted';

export interface ScoreTier {
  /** Stable identifier, for callers that need to branch without matching prose. */
  readonly key: 'high' | 'qualified' | 'under';
  /** Lowest score that lands in this tier. */
  readonly minimum: number;
  /** The word the subscriber reads. Defined here and nowhere else. */
  readonly word: string;
  readonly tone: ScoreTone;
}

/**
 * The tiers, highest first. {@link scoreTier} walks this in order and takes the
 * first match, so the final entry is the catch-all and must stay last.
 */
export const SCORE_TIERS: readonly ScoreTier[] = Object.freeze([
  { key: 'high', minimum: HIGH_PRIORITY_MINIMUM, word: 'High Priority', tone: 'green' },
  { key: 'qualified', minimum: LEAD_SCORE_THRESHOLD, word: 'Qualified', tone: 'blue' },
  { key: 'under', minimum: Number.NEGATIVE_INFINITY, word: 'Below the bar', tone: 'muted' },
]);

/** The catch-all tier, used for a score that is missing or not a number. */
const UNDER_TIER: ScoreTier = SCORE_TIERS[SCORE_TIERS.length - 1] ?? {
  key: 'under',
  minimum: Number.NEGATIVE_INFINITY,
  word: 'Below the bar',
  tone: 'muted',
};

/** Which tier a score falls in. Non-finite input lands in the catch-all. */
export function scoreTier(score: number): ScoreTier {
  if (!Number.isFinite(score)) return UNDER_TIER;
  for (const tier of SCORE_TIERS) {
    if (score >= tier.minimum) return tier;
  }
  return UNDER_TIER;
}

/**
 * The pill's text: "92 / 100 - High Priority".
 *
 * The separator is a middle dot, not an em dash. Em dashes are banned in
 * customer-facing copy by CLAUDE.md convention and this string is as
 * customer-facing as strings get.
 */
export function formatScoreBadge(score: number): string {
  const rounded = Number.isFinite(score) ? Math.round(score) : null;
  const tier = scoreTier(score);
  return rounded === null
    ? `Score not recorded · ${tier.word}`
    : `${rounded} / 100 · ${tier.word}`;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export interface ScoreBadgeProps {
  score: number;
  /** Drop the "/ 100" and show only the tier word, for tight rows. */
  wordOnly?: boolean;
  className?: string;
}

/**
 * The pill. A plain span: nothing here is interactive, so nothing here is a
 * client component.
 */
export default function ScoreBadge({ score, wordOnly = false, className }: ScoreBadgeProps) {
  const tier = scoreTier(score);
  const text = wordOnly ? tier.word : formatScoreBadge(score);

  return (
    <span
      className={className === undefined ? 'lv-score' : `lv-score ${className}`}
      data-tone={tier.tone}
    >
      {text}
    </span>
  );
}
