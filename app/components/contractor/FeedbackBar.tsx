'use client';

/**
 * The three buttons at the bottom of a lead, and the learning loop made visible.
 *
 * Good lead / Too small / Wrong scope is the entire vocabulary, matching
 * `feedbackSchema` and the CHECK constraint on the column. A richer set would be
 * inventing input the subscriber never gave, and this answer is the only real
 * signal the Customer Agent gets before it re-weights their profile.
 *
 * Interactive, so it is the one client component on the screen. Everything else
 * on the lead renders on the server.
 *
 * FOUR THINGS IT REFUSES TO DO
 * ----------------------------
 * - It does not claim a save it did not get. The confirmation appears on a 2xx
 *   from `/api/feedback` and nowhere else; a failure says so and leaves the
 *   buttons live so the press can be repeated.
 * - It does not hide an answer already on the row. A lead that was rated before
 *   opens showing that verdict, because the subscriber's own answer is a fact
 *   about this lead like any other.
 * - It does not lock the answer in. People press the wrong button and read the
 *   detail afterwards, and the route is built to accept a second verdict and log
 *   it as a change, so "Change this" is offered rather than pretending the first
 *   press was final.
 * - It does not talk about the machinery (rule #9). "This tunes what we send you"
 *   is the whole explanation, and it is true.
 */

import { type CSSProperties, useCallback, useState } from 'react';

import type { Feedback } from '@/lib/domain/schemas/core';

/* -------------------------------------------------------------------------- */
/* Options                                                                    */
/* -------------------------------------------------------------------------- */

interface Option {
  readonly value: Feedback;
  readonly label: string;
  /** True for the affirmative button, which is the one styled green. */
  readonly positive: boolean;
}

const OPTIONS: readonly Option[] = [
  { value: 'good', label: 'Good lead', positive: true },
  { value: 'too_small', label: 'Too small', positive: false },
  { value: 'wrong_scope', label: 'Wrong scope', positive: false },
];

/** How each verdict reads back in the confirmation. */
const SPOKEN: Readonly<Record<Feedback, string>> = {
  good: 'good lead',
  too_small: 'too small',
  wrong_scope: 'wrong scope',
};

/**
 * Reads the contractor surface's own tokens, with the prototype's literal values
 * as fallbacks. `--lv-fb-offset` is this component's own variable, set inline
 * from the `bottomOffset` prop, so the bar can park above a shell that already
 * has something sticky at the bottom of the viewport.
 */
const STYLES = `
.lv-fb {
  position: sticky;
  bottom: var(--lv-fb-offset, 0px);
  margin-top: auto;
  padding: 12px 16px;
  background: var(--lv-card, #ffffff);
  border-top: 1px solid var(--lv-line, #d9e3ec);
}
.lv-fb-row { display: flex; gap: 8px; }
.lv-fb-btn {
  flex: 1;
  min-height: 44px;
  padding: 0 8px;
  border-radius: 10px;
  font-family: inherit;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  transition: background .15s ease, border-color .15s ease;
}
.lv-fb-btn:disabled { cursor: default; opacity: .6; }
.lv-fb-btn--yes {
  border: 1px solid var(--lv-green-line, #bee3cf);
  background: var(--lv-green-soft, #e9f6ef);
  color: var(--lv-green, #24966a);
  font-weight: 700;
}
.lv-fb-btn--yes:hover:not(:disabled) { background: #dcf0e5; }
.lv-fb-btn--no {
  border: 1px solid var(--lv-line, #d9e3ec);
  background: var(--lv-card, #ffffff);
  color: var(--lv-muted, #66788a);
  font-weight: 600;
}
.lv-fb-btn--no:hover:not(:disabled) { background: var(--lv-page, #f4f8fc); }
.lv-fb-done {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px;
  min-height: 44px;
  padding: 8px 14px;
  border-radius: 10px;
  background: var(--lv-green-soft, #e9f6ef);
  color: var(--lv-green, #24966a);
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  text-align: center;
}
.lv-fb-change {
  padding: 0;
  border: none;
  background: none;
  font: inherit;
  font-weight: 600;
  color: var(--lv-green, #24966a);
  text-decoration: underline;
  cursor: pointer;
}
.lv-fb-error {
  margin: 8px 0 0;
  font-size: 12px;
  line-height: 1.4;
  color: #b4443a;
}
`;

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export interface FeedbackBarProps {
  /** The opportunity row this verdict lands on. */
  opportunityId: string;
  /** The verdict already stored against the row, when there is one. */
  initialFeedback: Feedback | null;
  /**
   * Pixels to hold the bar above the bottom of the viewport while it is stuck.
   *
   * The contractor shell keeps a tab bar sticky at the bottom, and a bar stuck at
   * zero would cover it. The caller knows what is underneath, so the caller says.
   * Defaults to flush.
   */
  bottomOffset?: number;
}

export default function FeedbackBar({
  opportunityId,
  initialFeedback,
  bottomOffset = 0,
}: FeedbackBarProps) {
  const [recorded, setRecorded] = useState<Feedback | null>(initialFeedback);
  const [pending, setPending] = useState<Feedback | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when the subscriber asks to change an answer already on the row. */
  const [reopened, setReopened] = useState(false);

  const submit = useCallback(
    async (feedback: Feedback) => {
      setPending(feedback);
      setError(null);
      try {
        const response = await fetch('/api/feedback', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ opportunityId, feedback }),
        });
        if (!response.ok) {
          /* Say that it did not save. Never swap to the confirmation on a
           * response the server did not agree to. */
          setError('That did not save. Check your connection and press it again.');
          return;
        }
        setRecorded(feedback);
        setReopened(false);
      } catch {
        setError('That did not save. Check your connection and press it again.');
      } finally {
        setPending(null);
      }
    },
    [opportunityId],
  );

  const showButtons = recorded === null || reopened;

  return (
    <div className="lv-fb" style={{ '--lv-fb-offset': `${bottomOffset}px` } as CSSProperties}>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      {showButtons ? (
        <div className="lv-fb-row" role="group" aria-label="How was this lead?">
          {OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`lv-fb-btn ${option.positive ? 'lv-fb-btn--yes' : 'lv-fb-btn--no'}`}
              disabled={pending !== null}
              aria-pressed={recorded === option.value}
              onClick={() => {
                void submit(option.value);
              }}
            >
              {pending === option.value ? 'Saving' : option.label}
            </button>
          ))}
        </div>
      ) : (
        <div className="lv-fb-done" role="status">
          <span>Noted: {SPOKEN[recorded]}. This tunes what we send you.</span>
          <button
            type="button"
            className="lv-fb-change"
            onClick={() => {
              setReopened(true);
            }}
          >
            Change this
          </button>
        </div>
      )}

      {error === null ? null : <p className="lv-fb-error">{error}</p>}
    </div>
  );
}
