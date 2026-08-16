/**
 * EvidenceBadge: the one place evidence-label styling is defined.
 *
 * Hard rule #3 says every stored fact carries an evidence label and unknowns stay
 * visible. That rule only means something on screen if the four labels are
 * instantly distinguishable and always rendered the same way, so this component
 * owns the entire visual treatment: the class name, the wording, and the tooltip
 * that explains what the label claims.
 *
 * No other component may style an evidence label. If a screen needs one, it
 * renders this. The colors themselves live on `:root` in globals.css as
 * `--evidence-*`, referenced by the `.badge--*` rules and nowhere else.
 *
 * `unknown` is deliberately the loudest of the four in structure rather than in
 * color: it is the only one with a dashed border. A fact we could not establish
 * should read as an open question on the page, not as a quiet gray footnote and
 * certainly not as an absence.
 */
import type { EvidenceLabel } from '@/lib/domain/schemas/core';

/**
 * Wording for each label: the badge text, the short gloss used in a legend, and
 * the full claim shown on hover.
 */
const PRESENTATION: Readonly<
  Record<EvidenceLabel, { text: string; gloss: string; title: string }>
> = {
  verified: {
    text: 'verified',
    gloss: 'the source itself says so',
    title: 'Confirmed against a first-party authoritative source, such as the permit record itself.',
  },
  corroborated: {
    text: 'corroborated',
    gloss: 'two sources agree',
    title: 'Two or more independent sources agree, none of them authoritative on its own.',
  },
  inferred: {
    text: 'inferred',
    gloss: 'reasoned from other facts',
    title: 'Derived by reasoning over other facts. Defensible, but not directly observed.',
  },
  unknown: {
    text: 'unknown',
    gloss: 'we looked and could not establish it',
    title: 'We looked and could not establish it. It stays on the page rather than being filled in.',
  },
};

/** Every evidence label, strongest first. Used to render legends. */
export const EVIDENCE_ORDER: readonly EvidenceLabel[] = [
  'verified',
  'corroborated',
  'inferred',
  'unknown',
];

export interface EvidenceBadgeProps {
  evidence: EvidenceLabel;
}

export default function EvidenceBadge({ evidence }: EvidenceBadgeProps) {
  const presentation = PRESENTATION[evidence];
  return (
    <span className={`badge badge--${evidence}`} title={presentation.title}>
      <span className="badge-dot" aria-hidden="true" />
      {presentation.text}
    </span>
  );
}

/**
 * The four labels in a row, with what each one claims.
 *
 * Rendered under a Findings table so a reader who has never seen this vocabulary
 * knows within one glance that the labels are a scale, not decoration.
 */
export function EvidenceLegend() {
  return (
    <div className="legend">
      {EVIDENCE_ORDER.map((label) => (
        <span className="legend-item" key={label}>
          <EvidenceBadge evidence={label} />
          <span>{PRESENTATION[label].gloss}</span>
        </span>
      ))}
    </div>
  );
}
