/**
 * ScoreDrivers: the score, shown as the arithmetic that produced it.
 *
 * The scorer in `lib/calculations/scoring/lead-score.ts` returns every signed
 * contribution with the reason it was awarded, and the contributions sum to the
 * score. That property is the whole reason a judge can ask "why 87?" and get an
 * answer instead of an assurance, so this component renders the list as a ledger:
 * every delta, every reason, and the total at the bottom.
 *
 * Positive and negative contributions are visually distinct because they argue
 * opposite things. A zero contribution is rendered too, in a third quieter
 * treatment: "we looked at this and it earned nothing" is a real finding about a
 * project and hiding it would make the ledger stop adding up on screen.
 *
 * Nothing is computed here beyond a sum for display. The number on the page comes
 * from the stored score; the sum is shown beside it so the two can be compared by
 * eye. They agree within rounding, and if they ever did not, this is the screen
 * that would say so.
 */
import type { ScoreDriver } from '@/lib/domain/schemas/core';

/** Signed, fixed-precision rendering: +6.5, -2, 0. */
function formatDelta(delta: number): string {
  if (!Number.isFinite(delta)) return '0';
  const rounded = Math.round(delta * 100) / 100;
  if (rounded === 0) return '0';
  const body = Number.isInteger(rounded) ? String(Math.abs(rounded)) : Math.abs(rounded).toFixed(2);
  return `${rounded > 0 ? '+' : '-'}${body}`;
}

function toneClass(delta: number): string {
  if (!Number.isFinite(delta) || Math.round(delta * 100) === 0) return 'driver--zero';
  return delta > 0 ? 'driver--positive' : 'driver--negative';
}

export interface ScoreDriversProps {
  drivers: readonly ScoreDriver[];
  /** The stored score, shown beside the sum so the two can be compared. */
  score?: number;
}

export default function ScoreDrivers({ drivers, score }: ScoreDriversProps) {
  if (drivers.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">No contributions recorded</p>
        <p className="empty-body">
          This opportunity was stored without a driver list, so there is nothing to show. A score
          without its reasons is not evidence of anything, and no number is displayed in its place.
        </p>
      </div>
    );
  }

  const sum = drivers.reduce((running, driver) => running + driver.delta, 0);
  const rounded = Math.round(sum * 100) / 100;

  return (
    <div className="driver-list">
      {drivers.map((driver, index) => (
        <div className={`driver ${toneClass(driver.delta)}`} key={`${index}-${driver.reason}`}>
          <span className="driver-delta">{formatDelta(driver.delta)}</span>
          <span className="driver-reason">{driver.reason}</span>
        </div>
      ))}
      <div className="driver-total">
        <span className="driver-delta">{Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}</span>
        <span className="driver-reason">
          Sum of {drivers.length} contributions
          {score === undefined ? '' : `, stored score ${score}`}
        </span>
      </div>
    </div>
  );
}
