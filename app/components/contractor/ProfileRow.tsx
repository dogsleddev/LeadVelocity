/**
 * One question-and-answer row on the subscriber's profile, plus the single price
 * the contractor-facing surface is allowed to quote.
 *
 * WHY A ROW AND NOT AN INPUT
 * --------------------------
 * The prototype draws this list as text inputs with a "Save changes" button. There
 * is no write path for the buying profile in this build and no sign-in behind it,
 * so an editable field and a save button would both be theatre: the field would
 * accept a change and the button would drop it on the floor. The row therefore
 * renders the answer as a value, styled to the prototype's field, and the screen
 * says in words how the profile actually moves (by replying to a lead). Nothing on
 * screen offers an affordance the system cannot honour.
 *
 * WHY THE PRICE IS RE-EXPORTED HERE
 * ---------------------------------
 * `app/app/profile/page.tsx` quotes it as the subscription price and
 * `app/sample/page.tsx` quotes it as the offer, and those two must never disagree.
 *
 * The number itself is no longer written here. It is `monthlyPriceUsd()` in
 * `lib/config/deployment-env.ts`, the one place in the build that knows it, and
 * this module passes it through so the two contractor screens keep importing
 * their price and their money formatter from the same place. The duplication this
 * comment used to warn about (five declarations, two of them a bare `const` that
 * ignored the environment) is gone.
 *
 * SERVER ONLY. `monthlyPriceUsd()` reads `process.env` through the deployment-env
 * helper, so this module must not be pulled into a `'use client'` tree.
 *
 * STYLING. Colours come from the `--lv-` tokens declared on `.lv-app` in
 * `app/app/contractor.css`. Nothing here declares a token, so the shared
 * stylesheet always wins; the literals are fallbacks for the case where a row is
 * rendered outside that shell.
 */
import type { ReactNode } from 'react';

import { monthlyPriceUsd } from '@/lib/config/deployment-env';

/* -------------------------------------------------------------------------- */
/* Price                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The published subscription price, re-exported so the contractor screens have
 * one import for the price and the formatter that renders it. Declared in
 * `lib/config/deployment-env.ts`.
 */
export { monthlyPriceUsd };

/**
 * Whole dollars, grouped by hand.
 *
 * Same approach as the operations console: `Intl.NumberFormat` would let the
 * rendered figure drift with the host locale, and this string is a price.
 */
export function formatUsd(amount: number): string {
  const digits = Math.round(Math.abs(amount)).toString();
  let grouped = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) grouped += ',';
    grouped += digits.charAt(index);
  }
  return `${amount < 0 ? '-' : ''}$${grouped}`;
}

/* -------------------------------------------------------------------------- */
/* Row                                                                        */
/* -------------------------------------------------------------------------- */

export interface ProfileRowProps {
  /** The question, in the words a contractor would be asked it. */
  question: string;
  /** The stored answer, already turned into readable words by the caller. */
  answer: ReactNode;
  /**
   * Where the answer came from, or what it is matched against. One short line,
   * rendered muted under the value. Omit when the question already says it.
   */
  note?: string;
  /**
   * True when there is no answer on file. The value renders in the muted
   * treatment rather than as a confident statement, matching how the rest of the
   * product shows a thing it does not know.
   */
  unanswered?: boolean;
}

export default function ProfileRow({ question, answer, note, unanswered = false }: ProfileRowProps) {
  return (
    <div className="lv-prow">
      <span className="lv-prow-q">{question}</span>
      <div className={unanswered ? 'lv-prow-a lv-prow-a--unanswered' : 'lv-prow-a'}>{answer}</div>
      {note === undefined || note.length === 0 ? null : (
        <span className="lv-prow-note">{note}</span>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                     */
/* -------------------------------------------------------------------------- */

const ROW_CSS = `
.lv-prow { display: flex; flex-direction: column; gap: 6px; }
.lv-prow-q {
  font-size: 13px;
  font-weight: 700;
  color: var(--lv-ink-2, #3a4c61);
}
.lv-prow-a {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 12px;
  border: 1px solid var(--lv-line, #d9e3ec);
  border-radius: 10px;
  background: var(--lv-card, #ffffff);
  font-size: 14px;
  line-height: 1.4;
  color: var(--lv-ink, #132238);
  text-wrap: pretty;
}
.lv-prow-a--unanswered { color: var(--lv-muted, #66788a); font-style: italic; }
.lv-prow-note { font-size: 11.5px; line-height: 1.45; color: var(--lv-faint, #7d8a97); }
`;

/**
 * The row stylesheet. Render once per screen that uses {@link ProfileRow}, not
 * once per row.
 */
export function ProfileRowStyles() {
  return <style dangerouslySetInnerHTML={{ __html: ROW_CSS }} />;
}
