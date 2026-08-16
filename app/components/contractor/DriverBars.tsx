/**
 * The five component bars: where the score actually came from.
 *
 * One row per scoring component, in the order the calculation runs them, each
 * showing the label, a bar filled to `subtotal / max`, and the pair of numbers
 * that produced the bar. A contractor who does not trust the headline number can
 * read this in three seconds and see which part of the job carried it.
 *
 * THE UNAVAILABLE CASE IS A FIRST-CLASS STATE
 * -------------------------------------------
 * `component_subtotals` arrived in migration 0003 and is nullable. A row scored
 * before that column existed has no breakdown, and the store deliberately reports
 * that as `null` rather than defaulting it. Rendering five zero-width bars there
 * would say "this lead scored nothing on every component", which is a different
 * and false claim. So a null breakdown renders as five empty tracks marked
 * unavailable, with one line saying why. That is hard rule #3 applied to a bar
 * chart: an absent measurement is shown as absent, never as a zero.
 *
 * WIDTHS ARE CLAMPED, ON PURPOSE
 * ------------------------------
 * `LeadScoreComponents` documents that a subscriber weight above 1 can push a
 * component's weighted contribution above its unweighted ceiling. The stored
 * figure is the weighted one, because that is the number that actually moved the
 * score, so the ratio can exceed 1 and the bar clamps rather than overflowing its
 * track. The numerals beside it still report the real figure.
 *
 * Pure presentation. Server component.
 */
import {
  LEAD_SCORE_COMPONENT_MAX,
  type LeadScoreComponent,
} from '@/lib/calculations/scoring/lead-score';
import type { ComponentSubtotals } from '@/lib/store/opportunities';

/* -------------------------------------------------------------------------- */
/* Rows                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Component order and wording.
 *
 * The order matches the scorer's own `order` array so the bars read in the same
 * sequence as the arithmetic. The words are the contractor's: "Fit" and "Timing"
 * mean something to someone buying leads, and each carries a one-line gloss for
 * the reader who has never seen this screen before.
 */
const ROWS: readonly { key: LeadScoreComponent; label: string; gloss: string }[] = [
  { key: 'fit', label: 'Fit', gloss: 'Whether this job is your kind of work' },
  { key: 'demand', label: 'Demand', gloss: 'How much work the job actually carries' },
  { key: 'timing', label: 'Timing', gloss: 'How recently the permit moved' },
  { key: 'value', label: 'Value', gloss: 'Size against your stated minimum' },
  { key: 'evidence', label: 'Evidence', gloss: 'How well backed everything above is' },
];

/**
 * Reads the contractor surface's own tokens, with the prototype's literal values
 * as fallbacks so the component still draws correctly if it is ever rendered
 * outside `.lv-app`. It defines no token of its own and overrides none.
 */
const STYLES = `
.lv-bars { display: flex; flex-direction: column; gap: 7px; }
.lv-bars-row {
  display: grid;
  grid-template-columns: 72px 1fr 62px;
  gap: 8px;
  align-items: center;
  font-size: 12px;
}
.lv-bars-label { color: var(--lv-muted, #66788a); font-weight: 600; }
.lv-bars-track {
  height: 6px;
  background: var(--lv-hair, #edf3f9);
  border-radius: 999px;
  overflow: hidden;
}
.lv-bars-fill {
  height: 100%;
  border-radius: 999px;
  transform-origin: left;
  animation: lv-bars-grow .9s cubic-bezier(.2,.8,.2,1);
}
.lv-bars-figure {
  color: var(--lv-ink-2, #3a4c61);
  font-weight: 600;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.lv-bars-figure--absent { color: var(--lv-faint, #7d8a97); font-weight: 500; }
.lv-bars-note {
  margin: 8px 0 0;
  font-size: 11.5px;
  line-height: 1.45;
  color: var(--lv-faint, #7d8a97);
  text-wrap: pretty;
}
@keyframes lv-bars-grow { from { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) { .lv-bars-fill { animation: none; } }
`;

/** Whole numbers stay whole; a fractional subtotal keeps one decimal. */
function formatSubtotal(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export interface DriverBarsProps {
  /** The stored breakdown, or `null` when this row was scored without one. */
  subtotals: ComponentSubtotals | null;
  /** Ring colour for this lead, so the bars agree with the dial. */
  accent: string;
}

export default function DriverBars({ subtotals, accent }: DriverBarsProps) {
  return (
    <div className="lv-bars">
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />

      {ROWS.map((row) => {
        const max = LEAD_SCORE_COMPONENT_MAX[row.key];

        if (subtotals === null) {
          return (
            <div className="lv-bars-row" key={row.key}>
              <div className="lv-bars-label">{row.label}</div>
              <div className="lv-bars-track" />
              <div className="lv-bars-figure lv-bars-figure--absent">{`? / ${max}`}</div>
            </div>
          );
        }

        const subtotal = subtotals[row.key];
        const ratio = max > 0 ? subtotal / max : 0;
        const width = `${Math.round((ratio < 0 ? 0 : ratio > 1 ? 1 : ratio) * 100)}%`;

        return (
          <div className="lv-bars-row" key={row.key} title={row.gloss}>
            <div className="lv-bars-label">{row.label}</div>
            <div className="lv-bars-track">
              <div className="lv-bars-fill" style={{ width, background: accent }} />
            </div>
            <div className="lv-bars-figure">{`${formatSubtotal(subtotal)} / ${max}`}</div>
          </div>
        );
      })}

      <p className="lv-bars-note">
        {subtotals === null
          ? 'The point split for this lead was not recorded when it was scored, so the five parts are shown as unavailable rather than as five zeroes. The score itself is the one the arithmetic produced.'
          : 'Five parts, fixed ceilings: fit 30, demand 25, timing 20, value 15, evidence 10. The same permit and the same profile always produce the same number.'}
      </p>
    </div>
  );
}
