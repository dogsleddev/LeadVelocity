/**
 * The full decision log.
 *
 * Hard rule #6 makes every decision write a row; this screen is where the whole
 * history can be read rather than the last twenty five lines on the operating
 * view. It exists so that a judge who wants to check a claim can go and check it:
 * pick one of the four workers, read what it decided, follow the refs to the
 * records it touched.
 *
 * Filtering is done with links and a query string rather than client state. Three
 * reasons, in order of how much they matter: a filtered view is a URL somebody can
 * be handed mid-demo, the page keeps working with no client JavaScript at all, and
 * the filter value is validated by the same Zod enum the database CHECK
 * constraint mirrors, so an invented agent name in the URL falls back to "all"
 * instead of rendering an empty screen that looks like a bug.
 */
import DecisionLogFeed, { AgentLegend } from '@/app/components/DecisionLogFeed';
import { missingKeys } from '@/lib/config/deployment-env';
import { type AgentEvent, type AgentName, agentNameSchema } from '@/lib/domain/schemas/core';
import { isStoreReady, listEvents } from '@/lib/store';

export const dynamic = 'force-dynamic';

/** How much history one page shows. The log is append-only and grows fast. */
const PAGE_LIMIT = 200;

/** Filter chips, in org-chart order with "everything" first. */
const FILTERS: readonly { key: AgentName | 'all'; label: string }[] = [
  { key: 'all', label: 'All decisions' },
  { key: 'ceo', label: 'CEO' },
  { key: 'sales', label: 'Sales' },
  { key: 'lead', label: 'Lead' },
  { key: 'customer', label: 'Customer' },
];

type SearchParams = Record<string, string | string[] | undefined>;

/** Narrow an untrusted query value to one of the four names, or nothing. */
function readAgentFilter(params: SearchParams): AgentName | null {
  const raw = params['agent'];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (candidate === undefined) return null;
  const parsed = agentNameSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

type LoadResult =
  | { state: 'unconfigured'; missing: string[] }
  | { state: 'failed'; message: string }
  | { state: 'ok'; events: AgentEvent[] };

async function load(agent: AgentName | null): Promise<LoadResult> {
  if (!isStoreReady()) return { state: 'unconfigured', missing: missingKeys('supabase') };
  try {
    const events =
      agent === null
        ? await listEvents({ limit: PAGE_LIMIT })
        : await listEvents({ limit: PAGE_LIMIT, agent });
    return { state: 'ok', events };
  } catch (error) {
    return { state: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
}

export default async function LogPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const agent = readAgentFilter(params);
  const result = await load(agent);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Decision log</h1>
          <p className="page-sub">
            Append-only. Every decision the four workers make writes one line here, newest first,
            with the records it touched. Nothing in this log is written by hand.
          </p>
        </div>
      </div>

      <nav className="filters" aria-label="Filter by worker">
        {FILTERS.map((filter) => {
          const active = filter.key === 'all' ? agent === null : agent === filter.key;
          const href = filter.key === 'all' ? '/log' : `/log?agent=${filter.key}`;
          return (
            <a
              key={filter.key}
              href={href}
              className={active ? 'filter filter--active' : 'filter'}
              aria-current={active ? 'page' : undefined}
            >
              {filter.label}
            </a>
          );
        })}
      </nav>

      {result.state === 'unconfigured' ? (
        <div className="empty">
          <p className="empty-title">Persistence is not configured</p>
          <p className="empty-body">
            The log lives in Supabase, which this deployment cannot reach, so there is nothing to
            show.
          </p>
          <p className="empty-keys">Missing keys: {result.missing.join(', ')}</p>
        </div>
      ) : result.state === 'failed' ? (
        <div className="empty empty--fatal">
          <p className="empty-title">The log could not be read</p>
          <p className="empty-body">{result.message}</p>
        </div>
      ) : (
        <>
          <DecisionLogFeed
            events={result.events}
            emptyTitle={
              agent === null
                ? 'No decisions recorded yet'
                : `Nothing from ${agent} yet`
            }
            emptyBody={
              agent === null
                ? 'The log fills as the workers tick. An empty log means the loop has not run, not that the screen failed to load.'
                : 'This worker has not made a decision in the stored history. Other workers may have.'
            }
          />
          <AgentLegend />
          <p className="section-note">
            Showing the {result.events.length === PAGE_LIMIT ? `most recent ${PAGE_LIMIT}` : result.events.length}{' '}
            {result.events.length === 1 ? 'entry' : 'entries'}
            {agent === null ? '' : ` from ${agent}`}.
          </p>
        </>
      )}
    </>
  );
}
