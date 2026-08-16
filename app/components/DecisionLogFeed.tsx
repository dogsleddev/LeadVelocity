/**
 * DecisionLogFeed: the append-only decision log, rendered.
 *
 * Hard rule #6 says every decision writes a row with ts, agent, decision,
 * summary, and refs. This component shows all five, newest first, because the
 * log is the demo: it is the only artifact that proves the company is running
 * itself rather than being driven from off-screen.
 *
 * Colour is carried by a left border keyed to the four agents (hard rule #4:
 * there are four, and this component cannot render a fifth because the type will
 * not permit one). Colour is the fastest way for someone watching a projector to
 * see that four independent processes are interleaving.
 *
 * Timestamps are rendered in San Francisco time with an explicit `timeZone`
 * rather than the host default, so the wall clock on the screen matches the wall
 * clock in the room no matter where the server is.
 *
 * Refs are rendered as chips, and a ref pointing at an opportunity becomes a
 * link. That single detail is what turns the feed from a narration into a
 * navigable audit trail: read a decision, click through to the record it touched.
 */
import type { AgentEvent, AgentName } from '@/lib/domain/schemas/core';

/** Display name for each of the four agents. Order is the org chart, not alphabetical. */
const AGENT_ORDER: readonly AgentName[] = ['ceo', 'sales', 'lead', 'customer'];

const AGENT_SWATCH: Readonly<Record<AgentName, string>> = {
  ceo: 'var(--agent-ceo)',
  sales: 'var(--agent-sales)',
  lead: 'var(--agent-lead)',
  customer: 'var(--agent-customer)',
};

/**
 * San Francisco wall time, e.g. `Aug 15 09:42:03`. Built once at module load;
 * `Intl.DateTimeFormat` is expensive to construct and its output depends only on
 * its inputs.
 */
const CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** Timestamp as SF wall time, or the raw string when it cannot be parsed. */
function formatTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return CLOCK.format(new Date(ms)).replace(',', '');
}

/** Ref keys that address a page in this application. */
const REF_LINKS: Readonly<Record<string, (value: string) => string>> = {
  opportunity: (value) => `/opportunities/${encodeURIComponent(value)}`,
};

export interface DecisionLogFeedProps {
  events: readonly AgentEvent[];
  /** Show the refs chips under each summary. On by default. */
  showRefs?: boolean;
  /** Copy for the empty state, so each screen can say what "empty" means there. */
  emptyTitle?: string;
  emptyBody?: string;
}

export default function DecisionLogFeed({
  events,
  showRefs = true,
  emptyTitle = 'No decisions recorded yet',
  emptyBody = 'The log fills as the workers tick. Nothing is written here in advance, so an empty log means the loop has not run yet, not that the screen failed to load.',
}: DecisionLogFeedProps) {
  if (events.length === 0) {
    return (
      <div className="empty">
        <p className="empty-title">{emptyTitle}</p>
        <p className="empty-body">{emptyBody}</p>
      </div>
    );
  }

  return (
    <ol className="feed">
      {events.map((event, index) => {
        const refs = Object.entries(event.refs);
        return (
          <li
            className={`feed-item feed-item--${event.agent}`}
            key={event.id ?? `${event.ts}-${index}`}
          >
            <time className="feed-time" dateTime={event.ts}>
              {formatTimestamp(event.ts)}
            </time>
            <span className="feed-actor">{event.agent}</span>
            <div>
              <span className="feed-decision">{event.decision}</span>
              <p className="feed-summary">{event.summary}</p>
              {showRefs && refs.length > 0 ? (
                <div className="feed-refs">
                  {refs.map(([key, value]) => {
                    const href = REF_LINKS[key]?.(value);
                    return (
                      <span className="ref-chip" key={key}>
                        {key}:{' '}
                        {href === undefined ? value : <a href={href}>{value}</a>}
                      </span>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

/** The four agents and their colours, for a legend beneath the feed. */
export function AgentLegend() {
  return (
    <div className="legend">
      {AGENT_ORDER.map((agent) => (
        <span className="legend-item" key={agent}>
          <span
            className="legend-swatch"
            style={{ background: AGENT_SWATCH[agent] }}
            aria-hidden="true"
          />
          <span>{agent}</span>
        </span>
      ))}
    </div>
  );
}
