/**
 * The score dial on the subscriber's lead detail screen.
 *
 * A 56px ring filled to `score * 3.6` degrees with a 44px white disc punched out
 * of the middle and the numeral centred in it. Those measurements are the v4
 * prototype's and they are not decoration: the ring is the first thing a
 * contractor looks at, and it has to read at arm's length on a phone held on a
 * job site.
 *
 * THE SWITCH IS CONSISTENT, WHICH THE PROTOTYPE'S WAS NOT
 * -------------------------------------------------------
 * Green at the high priority line, blue below it. The prototype hardcoded green
 * on its mobile screen and switched on its desktop one, which is a defect rather
 * than two decisions, so it switches here and it switches everywhere.
 *
 * WHERE THE LINE IS, IT DOES NOT DECIDE
 * -------------------------------------
 * `ScoreBadge` is the one place in this app that decides what a number means, and
 * this file reads its answer rather than restating it. The dial cannot disagree
 * with the pill beside it about whether a 91 is high priority, because both ask
 * the same function. Only the paint is chosen here: the pill has three tones and
 * the ring has two, so a score that has not cleared the delivery bar gets the
 * app's neutral accent while the pill next to it says "Below the bar" in words.
 *
 * Pure presentation. No data access, no clock, so it renders on the server.
 */
import { scoreTier } from '@/app/components/contractor/ScoreBadge';

/* -------------------------------------------------------------------------- */
/* Palette                                                                    */
/* -------------------------------------------------------------------------- */

/** Prototype green and blue. The contractor tokens carry the same two values. */
export const GAUGE_GREEN = '#24966A';
export const GAUGE_BLUE = '#2878F0';

/** The unfilled remainder of the ring. */
const TRACK = '#EDF3F9';

/**
 * Ring colour for a score.
 *
 * Exported because the component bars under the dial are drawn in the same
 * colour, and two places computing it independently is how they end up
 * disagreeing.
 */
export function gaugeAccent(score: number): string {
  return scoreTier(score).tone === 'green' ? GAUGE_GREEN : GAUGE_BLUE;
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export interface ScoreGaugeProps {
  /** 0-100 as the deterministic scorer produced it. */
  score: number;
  /** Outer diameter in px. The inner disc and the numeral scale with it. */
  size?: number;
}

export default function ScoreGauge({ score, size = 56 }: ScoreGaugeProps) {
  /* The scorer already clamps to 0-100. Clamping again costs nothing and stops a
   * corrupt row from drawing a 340 degree sweep with total confidence. */
  const rounded = Number.isFinite(score) ? Math.round(score) : 0;
  const value = rounded < 0 ? 0 : rounded > 100 ? 100 : rounded;
  const accent = gaugeAccent(value);

  const inner = Math.round(size * (44 / 56));
  const numeral = Math.round(size * (16 / 56));

  return (
    <div
      className="lv-gauge"
      role="img"
      aria-label={`Score ${value} out of 100`}
      style={{
        width: size,
        height: size,
        borderRadius: 999,
        background: `conic-gradient(${accent} ${value * 3.6}deg, ${TRACK} 0deg)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          width: inner,
          height: inner,
          borderRadius: 999,
          background: '#ffffff',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: numeral,
          fontWeight: 800,
          lineHeight: 1,
          color: accent,
        }}
      >
        {value}
      </div>
    </div>
  );
}
