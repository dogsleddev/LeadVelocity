/**
 * Socrata (SODA 2.1) client.
 *
 * Origin: adapter shape adapted from SiteVelocity's source adapters
 * (https://github.com/samshanmukh/SiteVelocity).
 *
 * Built on `httpGetJson`, so timeouts, bounded retries, and typed failures come
 * for free and are not reimplemented here. What this module adds is the four
 * things that are specific to SODA:
 *
 * 1. `$where / $select / $order / $limit / $offset` query construction.
 * 2. Paging that is actually stable. SODA does not guarantee row order without
 *    an explicit `$order`, so paging without one silently duplicates and drops
 *    rows. Every request therefore carries an order, defaulting to the system
 *    column `:id`.
 * 3. An optional `X-App-Token`. Without one, DataSF throttles by IP and starts
 *    returning 429; with one the app gets its own bucket. It is optional by
 *    design: a missing token degrades throughput, it never fails the tick
 *    (`hasCapability('soda')` reports the difference to the health probe).
 * 4. Incremental fetching keyed on `data_as_of` / `data_loaded_at`, which are the
 *    only currency columns these datasets expose. The returned cursor is the
 *    highest raw value observed, so the next call resumes exactly where this one
 *    stopped.
 *
 * Rows come back as `RawSourceRecord`s with provenance filled from the registry
 * entry. Nothing here interprets a column; that is the normalizer's job.
 */
import { optionalEnv } from '@/lib/config/deployment-env';
import type { SourceDescriptor } from '@/lib/domain/schemas/core';
import {
  SF_TIME_ZONE,
  normalizeAgencyTimestamp,
  toFloatingTimestamp,
} from '@/lib/domain/permit-normalizer';

import { httpGetJson, type FetchLike, type QueryParams, type SleepLike } from './http-json';
import { getSourceEntry, type SourceId } from './registry';
import {
  buildProvenance,
  buildRawSourceRecord,
  rawPayloadSchema,
  readKeyField,
  type RawPayload,
  type RawSourceRecord,
} from './source-record';
import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

/** SODA's hard ceiling on `$limit` for a single page is 50,000. */
export const SOCRATA_MAX_PAGE_SIZE = 50_000;
export const DEFAULT_PAGE_SIZE = 1_000;
/** Safety bound so a bad `$where` cannot page forever. 1,000 pages at 1k rows. */
export const DEFAULT_MAX_PAGES = 1_000;
/** SODA system column, always present and always orderable. */
export const SOCRATA_ROW_ID_COLUMN = ':id';

/** Columns these datasets expose as a currency cursor. */
export type SocrataCursorField = 'data_as_of' | 'data_loaded_at';

/* -------------------------------------------------------------------------- */
/* Query                                                                      */
/* -------------------------------------------------------------------------- */

export interface SocrataQuery {
  /** SoQL predicate, e.g. `filed_date > '2026-02-15T00:00:00'`. */
  readonly where?: string;
  /** Comma-separated projection. Omit for all columns. */
  readonly select?: string;
  /** Ordering. Defaults to `:id`, which is what makes paging stable. */
  readonly order?: string;
  readonly limit?: number;
  readonly offset?: number;
  /** SODA full-text `$q`. */
  readonly q?: string;
}

/** Turn a query into SODA parameters, dropping anything unset. */
export function buildSocrataParams(query: SocrataQuery): QueryParams {
  const params: Record<string, string | number> = {};
  if (query.select !== undefined) params.$select = query.select;
  if (query.where !== undefined) params.$where = query.where;
  params.$order = query.order ?? SOCRATA_ROW_ID_COLUMN;
  if (query.limit !== undefined) params.$limit = query.limit;
  if (query.offset !== undefined) params.$offset = query.offset;
  if (query.q !== undefined) params.$q = query.q;
  return params;
}

/** AND two optional SoQL predicates without producing a dangling operator. */
export function andPredicates(...parts: readonly (string | null | undefined)[]): string | undefined {
  const usable = parts
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0);
  if (usable.length === 0) return undefined;
  if (usable.length === 1) return usable[0];
  return usable.map((part) => `(${part})`).join(' AND ');
}

/**
 * SoQL string literal. Socrata takes single quotes and escapes them by doubling.
 * Used for the cursor predicate so a caller-supplied timestamp can never break
 * out of the literal.
 */
export function soqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/* -------------------------------------------------------------------------- */
/* Config and results                                                         */
/* -------------------------------------------------------------------------- */

export interface SocrataClientConfig {
  /** Registry descriptor. Determines the endpoint and stamps provenance. */
  readonly descriptor: SourceDescriptor;
  /** Natural key column for this dataset (`permit_number`, `id`). */
  readonly keyField: string;
  /** Currency column used by `fetchIncremental`. */
  readonly cursorField?: SocrataCursorField;
  /**
   * App token. Defaults to `SODA_APP_TOKEN` from the environment; pass `null` to
   * force an anonymous client. The value is only ever sent as a header, never
   * logged and never returned.
   */
  readonly appToken?: string | null;
  /** Zone the dataset's floating timestamps are written in. */
  readonly timeZone?: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly fetchImpl?: FetchLike;
  readonly sleepImpl?: SleepLike;
  /** Clock. Injected so provenance is deterministic in tests. */
  readonly now?: () => Date;
  /** Stamps `provenance.replayed`. Only the replay harness sets this true. */
  readonly replayed?: boolean;
}

export interface SocrataFetchResult {
  readonly records: readonly RawSourceRecord[];
  /** Pages actually requested. */
  readonly pages: number;
  /** True when `maxPages` stopped the walk before the dataset was exhausted. */
  readonly truncated: boolean;
  /**
   * Highest raw cursor value observed, in the dataset's own floating format.
   * Feed it straight back as `since` on the next incremental call. `null` when
   * no row carried a cursor value.
   */
  readonly cursor: string | null;
  /** Rows the source returned that had no usable key and were skipped. */
  readonly skippedKeyless: number;
  /** Whether an app token was attached, for the health probe. Never the token. */
  readonly tokenUsed: boolean;
}

export interface IncrementalOptions {
  /**
   * Resume point. Accepts either the dataset's floating format
   * (`2026-04-12T01:05:02.000`) or an absolute ISO timestamp, which is converted
   * into the dataset's wall-clock zone before comparison. `null` means full pull.
   */
  readonly since?: string | null;
  /** Overrides the configured cursor column for this call. */
  readonly cursorField?: SocrataCursorField;
  /** Extra predicate ANDed with the cursor predicate. */
  readonly where?: string;
  readonly select?: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

export interface SocrataClient {
  readonly descriptor: SourceDescriptor;
  readonly cursorField: SocrataCursorField;
  /** True when an app token is configured. Presence only. */
  readonly hasAppToken: boolean;
  /** One page, exactly as asked. */
  fetchPage(query?: SocrataQuery): Promise<SocrataFetchResult>;
  /** Walk `$offset` until the dataset is exhausted or `maxPages` is hit. */
  fetchAll(query?: SocrataQuery): Promise<SocrataFetchResult>;
  /** Walk everything whose cursor column moved past `since`. */
  fetchIncremental(options?: IncrementalOptions): Promise<SocrataFetchResult>;
}

/** SODA returns a bare JSON array of flat objects. */
const socrataPageSchema = z.array(rawPayloadSchema);

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Compare two raw floating timestamps. String comparison is correct here because
 * the format is fixed-width and zero-padded; parsing would only add failure
 * modes to a max() operation.
 */
function laterCursor(current: string | null, candidate: string | null): string | null {
  if (candidate === null) return current;
  if (current === null) return candidate;
  return candidate > current ? candidate : current;
}

export function createSocrataClient(config: SocrataClientConfig): SocrataClient {
  const {
    descriptor,
    keyField,
    timeZone = SF_TIME_ZONE,
    pageSize: configuredPageSize = DEFAULT_PAGE_SIZE,
    maxPages: configuredMaxPages = DEFAULT_MAX_PAGES,
    timeoutMs,
    maxAttempts,
    fetchImpl,
    sleepImpl,
    now = () => new Date(),
    replayed = false,
  } = config;

  const cursorField: SocrataCursorField = config.cursorField ?? 'data_as_of';
  // `undefined` means "read the environment"; explicit `null` means "anonymous".
  const appToken =
    config.appToken === undefined ? optionalEnv('SODA_APP_TOKEN') : config.appToken;
  const headers: Record<string, string> =
    appToken === null ? {} : { 'x-app-token': appToken };

  const clampPageSize = (value: number | undefined): number => {
    const requested = value ?? configuredPageSize;
    return Math.max(1, Math.min(Math.trunc(requested), SOCRATA_MAX_PAGE_SIZE));
  };

  /** One HTTP round trip, wrapped into envelopes. */
  async function requestPage(query: SocrataQuery): Promise<{
    records: RawSourceRecord[];
    rowCount: number;
    cursor: string | null;
    skippedKeyless: number;
  }> {
    const response = await httpGetJson(
      {
        url: descriptor.endpoint,
        query: buildSocrataParams(query),
        headers,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(maxAttempts === undefined ? {} : { maxAttempts }),
        ...(fetchImpl === undefined ? {} : { fetchImpl }),
        ...(sleepImpl === undefined ? {} : { sleepImpl }),
      },
      (value) => socrataPageSchema.parse(value),
    );

    const retrievedAt = now().toISOString();
    const records: RawSourceRecord[] = [];
    let cursor: string | null = null;
    let skippedKeyless = 0;

    for (const raw of response.data) {
      const payload: RawPayload = raw;
      const key = readKeyField(payload, keyField);
      const rawCursor = readRawText(payload, cursorField);
      cursor = laterCursor(cursor, rawCursor);

      if (key === null) {
        // A row we cannot name cannot be deduped. Count it, never invent a key.
        skippedKeyless += 1;
        continue;
      }

      records.push(
        buildRawSourceRecord({
          descriptor,
          key,
          raw: payload,
          provenance: buildProvenance({
            descriptor,
            retrievedAt,
            dataAsOf: normalizeAgencyTimestamp(payload.data_as_of, timeZone),
            dataLoadedAt: normalizeAgencyTimestamp(payload.data_loaded_at, timeZone),
            replayed,
          }),
        }),
      );
    }

    return { records, rowCount: response.data.length, cursor, skippedKeyless };
  }

  async function fetchPage(query: SocrataQuery = {}): Promise<SocrataFetchResult> {
    const limit = clampPageSize(query.limit);
    const page = await requestPage({ ...query, limit });
    return {
      records: page.records,
      pages: 1,
      truncated: page.rowCount === limit,
      cursor: page.cursor,
      skippedKeyless: page.skippedKeyless,
      tokenUsed: appToken !== null,
    };
  }

  async function walk(
    query: SocrataQuery,
    pageSizeOverride: number | undefined,
    maxPagesOverride: number | undefined,
  ): Promise<SocrataFetchResult> {
    const limit = clampPageSize(pageSizeOverride ?? query.limit);
    const maxPages = Math.max(1, Math.trunc(maxPagesOverride ?? configuredMaxPages));

    const records: RawSourceRecord[] = [];
    let cursor: string | null = null;
    let skippedKeyless = 0;
    let pages = 0;
    let offset = query.offset ?? 0;
    let truncated = false;

    for (;;) {
      const page = await requestPage({ ...query, limit, offset });
      pages += 1;
      records.push(...page.records);
      skippedKeyless += page.skippedKeyless;
      cursor = laterCursor(cursor, page.cursor);

      if (page.rowCount < limit) break;
      if (pages >= maxPages) {
        truncated = true;
        break;
      }
      offset += limit;
    }

    return {
      records,
      pages,
      truncated,
      cursor,
      skippedKeyless,
      tokenUsed: appToken !== null,
    };
  }

  async function fetchAll(query: SocrataQuery = {}): Promise<SocrataFetchResult> {
    return walk(query, undefined, undefined);
  }

  async function fetchIncremental(options: IncrementalOptions = {}): Promise<SocrataFetchResult> {
    const field = options.cursorField ?? cursorField;
    const since = options.since ?? null;

    let cursorPredicate: string | undefined;
    if (since !== null && since.trim().length > 0) {
      const floating = toFloatingTimestamp(since, timeZone);
      if (floating === null) {
        throw new Error(
          `Unparseable incremental cursor "${since}" for ${descriptor.id}. Pass the value ` +
            `returned as SocrataFetchResult.cursor, or an ISO-8601 timestamp.`,
        );
      }
      cursorPredicate = `${field} > ${soqlLiteral(floating)}`;
    }

    const where = andPredicates(cursorPredicate, options.where);

    return walk(
      {
        ...(where === undefined ? {} : { where }),
        ...(options.select === undefined ? {} : { select: options.select }),
      },
      options.pageSize,
      options.maxPages,
    );
  }

  return {
    descriptor,
    cursorField,
    hasAppToken: appToken !== null,
    fetchPage,
    fetchAll,
    fetchIncremental,
  };
}

/** Raw (uncoerced, un-normalized) text of a column, for cursor bookkeeping. */
function readRawText(raw: RawPayload, column: string): string | null {
  const value = raw[column];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/* -------------------------------------------------------------------------- */
/* Registry-backed construction                                               */
/* -------------------------------------------------------------------------- */

/**
 * Build a client straight from a registry id.
 *
 * Refuses ids that are not Socrata datasets, and refuses ids whose key column
 * has not been live-inspected yet, so an uninspected source cannot quietly start
 * producing keyless records.
 */
export function createSocrataClientFor(
  id: SourceId,
  overrides: Omit<SocrataClientConfig, 'descriptor' | 'keyField'> & {
    readonly keyField?: string;
  } = {},
): SocrataClient {
  const entry = getSourceEntry(id);
  if (entry.descriptor.kind !== 'socrata') {
    throw new Error(`Source "${id}" is kind "${entry.descriptor.kind}", not a Socrata dataset.`);
  }
  const keyField = overrides.keyField ?? entry.keyField;
  if (keyField === null) {
    throw new Error(
      `Source "${id}" has no declared keyField. Inspect the dataset and record the column in ` +
        `the registry before fetching from it (CLAUDE.md hard rule #8).`,
    );
  }
  const registryCursor =
    entry.cursorField === 'data_as_of' || entry.cursorField === 'data_loaded_at'
      ? entry.cursorField
      : undefined;
  const cursorField = overrides.cursorField ?? registryCursor;

  return createSocrataClient({
    ...overrides,
    descriptor: entry.descriptor,
    keyField,
    ...(cursorField === undefined ? {} : { cursorField }),
  });
}
