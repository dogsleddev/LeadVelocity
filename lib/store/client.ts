/**
 * Supabase client and the shared plumbing every store module is built on.
 *
 * Origin: lazy-client and boundary-validation patterns adapted from SiteVelocity
 * (`lib/store/client.ts`, https://github.com/samshanmukh/SiteVelocity).
 *
 * `lib/store/*` is the ONLY place in this codebase that talks to Postgres.
 * Workers, routes, and agents call these functions; nobody else holds a client.
 *
 * Three rules this module exists to enforce:
 *
 * 1. **Nothing throws at import time.** A deploy missing `SUPABASE_URL` must
 *    still boot, still serve the health probe, and still report what is missing
 *    (deployment-env rule 1). The client is therefore constructed on first use
 *    and memoized, never at module load.
 * 2. **The database is a boundary.** Rows coming OUT of Postgres are validated
 *    with Zod exactly like records coming out of a public API. The generated
 *    `Database` types below are a compile-time convenience; they are not
 *    evidence about what is actually in the table. Column names here are
 *    transcribed from `supabase/migrations/0001_init.sql` and must stay in step
 *    with it.
 * 3. **snake_case stops here.** Database column names live in this file and in
 *    the row schemas of each store module. Everything above the store speaks the
 *    camelCase vocabulary of `lib/domain/schemas/core.ts`.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { hasCapability, requireEnv } from '@/lib/config/deployment-env';

/* -------------------------------------------------------------------------- */
/* JSON                                                                       */
/* -------------------------------------------------------------------------- */

/** Anything a `jsonb` column can hold. Mirrors the supabase-js `Json` type. */
export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** Runtime counterpart of {@link Json}, for validating `jsonb` columns on read. */
export const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonSchema),
    z.record(z.string(), jsonSchema),
  ]),
);

/** A `jsonb` object column, e.g. `permit_records.raw`. */
export const jsonObjectSchema = z.record(z.string(), jsonSchema);
export type JsonObject = z.infer<typeof jsonObjectSchema>;

/* -------------------------------------------------------------------------- */
/* Generated-style schema types                                               */
/* -------------------------------------------------------------------------- */

/** Timestamps arrive from PostgREST as ISO 8601 strings, not `Date`s. */
type Timestamptz = string;

/**
 * Table shapes, transcribed column-for-column from `0001_init.sql`.
 *
 * `Insert` marks every column with a database default as optional so a caller
 * can omit `created_at`, `first_seen_at`, and friends and let Postgres decide.
 * `Update` is `Partial<Insert>` except on `events`, where it is deliberately
 * uninhabited: the table is append-only and a trigger enforces it, so an attempt
 * to update should fail at compile time rather than at runtime.
 */
export interface Database {
  public: {
    Tables: {
      settings: {
        Row: {
          id: string;
          kill_switch: boolean;
          replay_speed_multiplier: number;
          replay_active: boolean;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: string;
          kill_switch?: boolean;
          replay_speed_multiplier?: number;
          replay_active?: boolean;
          updated_at?: Timestamptz;
        };
        Update: {
          id?: string;
          kill_switch?: boolean;
          replay_speed_multiplier?: number;
          replay_active?: boolean;
          updated_at?: Timestamptz;
        };
        Relationships: [];
      };
      customers: {
        Row: {
          id: string;
          business_name: string;
          trade: string;
          territory_zips: string[];
          territory_districts: string[];
          min_project_value: number;
          preferred_uses: string[];
          phone: string;
          status: string;
          effective_weights: Json;
          created_at: Timestamptz;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: string;
          business_name: string;
          trade?: string;
          territory_zips?: string[];
          territory_districts?: string[];
          min_project_value?: number;
          preferred_uses?: string[];
          phone: string;
          status?: string;
          effective_weights?: Json;
          created_at?: Timestamptz;
          updated_at?: Timestamptz;
        };
        Update: {
          business_name?: string;
          trade?: string;
          territory_zips?: string[];
          territory_districts?: string[];
          min_project_value?: number;
          preferred_uses?: string[];
          phone?: string;
          status?: string;
          effective_weights?: Json;
          updated_at?: Timestamptz;
        };
        Relationships: [];
      };
      prospects: {
        Row: {
          id: string;
          license_number: string | null;
          firm_name: string;
          city: string | null;
          state: string | null;
          zipcode: string | null;
          classification: string | null;
          license_status: string | null;
          segment: string;
          segment_evidence: string;
          qualified: boolean;
          qualify_reasons: Json;
          source_id: string;
          contacted_at: Timestamptz | null;
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          license_number?: string | null;
          firm_name: string;
          city?: string | null;
          state?: string | null;
          zipcode?: string | null;
          classification?: string | null;
          license_status?: string | null;
          segment?: string;
          segment_evidence?: string;
          qualified?: boolean;
          qualify_reasons?: Json;
          source_id: string;
          contacted_at?: Timestamptz | null;
          created_at?: Timestamptz;
        };
        Update: {
          license_number?: string | null;
          firm_name?: string;
          city?: string | null;
          state?: string | null;
          zipcode?: string | null;
          classification?: string | null;
          license_status?: string | null;
          segment?: string;
          segment_evidence?: string;
          qualified?: boolean;
          qualify_reasons?: Json;
          source_id?: string;
          contacted_at?: Timestamptz | null;
        };
        Relationships: [];
      };
      permit_records: {
        Row: {
          permit_number: string;
          record_id: string | null;
          raw: Json;
          normalized: Json;
          content_hash: string;
          provenance: Json;
          snapshot_status: string;
          data_as_of: Timestamptz | null;
          data_loaded_at: Timestamptz | null;
          first_seen_at: Timestamptz;
          last_seen_at: Timestamptz;
        };
        Insert: {
          permit_number: string;
          record_id?: string | null;
          raw: Json;
          normalized: Json;
          content_hash: string;
          provenance: Json;
          snapshot_status?: string;
          data_as_of?: Timestamptz | null;
          data_loaded_at?: Timestamptz | null;
          first_seen_at?: Timestamptz;
          last_seen_at?: Timestamptz;
        };
        Update: {
          record_id?: string | null;
          raw?: Json;
          normalized?: Json;
          content_hash?: string;
          provenance?: Json;
          snapshot_status?: string;
          data_as_of?: Timestamptz | null;
          data_loaded_at?: Timestamptz | null;
          last_seen_at?: Timestamptz;
        };
        Relationships: [];
      };
      replay_staging: {
        Row: {
          permit_number: string;
          raw: Json;
          original_ts: Timestamptz;
          released: boolean;
          released_at: Timestamptz | null;
        };
        Insert: {
          permit_number: string;
          raw: Json;
          original_ts: Timestamptz;
          released?: boolean;
          released_at?: Timestamptz | null;
        };
        Update: {
          raw?: Json;
          original_ts?: Timestamptz;
          released?: boolean;
          released_at?: Timestamptz | null;
        };
        Relationships: [];
      };
      candidates: {
        Row: {
          id: string;
          permit_number: string;
          customer_id: string;
          stage: string;
          shortlist_reason: string | null;
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          permit_number: string;
          customer_id: string;
          stage?: string;
          shortlist_reason?: string | null;
          created_at?: Timestamptz;
        };
        Update: {
          stage?: string;
          shortlist_reason?: string | null;
        };
        Relationships: [];
      };
      findings: {
        Row: {
          id: string;
          candidate_id: string;
          key: string;
          label: string;
          value: Json | null;
          evidence: string;
          source_id: string | null;
          note: string;
          observed_at: Timestamptz;
        };
        Insert: {
          id?: string;
          candidate_id: string;
          key: string;
          label: string;
          value?: Json | null;
          evidence: string;
          source_id?: string | null;
          note?: string;
          observed_at?: Timestamptz;
        };
        Update: {
          label?: string;
          value?: Json | null;
          evidence?: string;
          source_id?: string | null;
          note?: string;
          observed_at?: Timestamptz;
        };
        Relationships: [];
      };
      opportunities: {
        Row: {
          id: string;
          candidate_id: string;
          customer_id: string;
          score: number;
          drivers: Json;
          warnings: Json;
          fatal_flags: Json;
          status: string;
          summary: string | null;
          best_path_in: string | null;
          recommended_action: string | null;
          delivered_at: Timestamptz | null;
          feedback: string | null;
          feedback_at: Timestamptz | null;
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          candidate_id: string;
          customer_id: string;
          score: number;
          drivers?: Json;
          warnings?: Json;
          fatal_flags?: Json;
          status?: string;
          summary?: string | null;
          best_path_in?: string | null;
          recommended_action?: string | null;
          delivered_at?: Timestamptz | null;
          feedback?: string | null;
          feedback_at?: Timestamptz | null;
          created_at?: Timestamptz;
        };
        Update: {
          score?: number;
          drivers?: Json;
          warnings?: Json;
          fatal_flags?: Json;
          status?: string;
          summary?: string | null;
          best_path_in?: string | null;
          recommended_action?: string | null;
          delivered_at?: Timestamptz | null;
          feedback?: string | null;
          feedback_at?: Timestamptz | null;
        };
        Relationships: [];
      };
      subscriptions: {
        Row: {
          id: string;
          customer_id: string;
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          stripe_checkout_session_id: string | null;
          status: string;
          mode: string;
          current_period_end: Timestamptz | null;
          updated_at: Timestamptz;
        };
        Insert: {
          id?: string;
          customer_id: string;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          stripe_checkout_session_id?: string | null;
          status?: string;
          mode?: string;
          current_period_end?: Timestamptz | null;
          updated_at?: Timestamptz;
        };
        Update: {
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          stripe_checkout_session_id?: string | null;
          status?: string;
          mode?: string;
          current_period_end?: Timestamptz | null;
          updated_at?: Timestamptz;
        };
        Relationships: [];
      };
      stripe_events: {
        Row: { id: string; type: string; received_at: Timestamptz };
        Insert: { id: string; type: string; received_at?: Timestamptz };
        Update: { type?: string };
        Relationships: [];
      };
      events: {
        Row: {
          id: number;
          ts: Timestamptz;
          agent: string;
          decision: string;
          summary: string;
          refs: Json;
        };
        Insert: {
          ts?: Timestamptz;
          agent: string;
          decision: string;
          summary: string;
          refs?: Json;
        };
        /** Append-only (trigger `events_no_update`). Nothing is updatable. */
        Update: Record<string, never>;
        Relationships: [];
      };
      message_studies: {
        Row: {
          id: string;
          study_ref: string | null;
          variants: Json;
          results: Json | null;
          winner_variant_id: string | null;
          winner_text: string | null;
          status: string;
          launched_at: Timestamptz | null;
          completed_at: Timestamptz | null;
          created_at: Timestamptz;
        };
        Insert: {
          id?: string;
          study_ref?: string | null;
          variants: Json;
          results?: Json | null;
          winner_variant_id?: string | null;
          winner_text?: string | null;
          status?: string;
          launched_at?: Timestamptz | null;
          completed_at?: Timestamptz | null;
          created_at?: Timestamptz;
        };
        Update: {
          study_ref?: string | null;
          variants?: Json;
          results?: Json | null;
          winner_variant_id?: string | null;
          winner_text?: string | null;
          status?: string;
          launched_at?: Timestamptz | null;
          completed_at?: Timestamptz | null;
        };
        Relationships: [];
      };

      /* --- 0002_linq_channel.sql ------------------------------------------
       * Handles that have messaged the company, and messages composed but not
       * yet permitted to send. Linq's sandbox refuses outbound to anyone who
       * has not made contact first, so reachability is stored state, not a
       * caught 403. See lib/store/inbound.ts.
       */
      inbound_contacts: {
        Row: {
          handle: string;
          channel: string;
          chat_id: string | null;
          first_seen_at: Timestamptz;
          last_seen_at: Timestamptz;
          message_count: number;
          opted_out: boolean;
          opted_out_at: Timestamptz | null;
        };
        Insert: {
          handle: string;
          channel?: string;
          chat_id?: string | null;
          first_seen_at?: Timestamptz;
          last_seen_at?: Timestamptz;
          message_count?: number;
          opted_out?: boolean;
          opted_out_at?: Timestamptz | null;
        };
        Update: {
          channel?: string;
          chat_id?: string | null;
          last_seen_at?: Timestamptz;
          message_count?: number;
          opted_out?: boolean;
          opted_out_at?: Timestamptz | null;
        };
        Relationships: [];
      };

      outbound_queue: {
        Row: {
          id: string;
          handle: string;
          body: string;
          link_url: string | null;
          purpose: string;
          opportunity_id: string | null;
          status: string;
          created_at: Timestamptz;
          sent_at: Timestamptz | null;
          message_id: string | null;
        };
        Insert: {
          id?: string;
          handle: string;
          body: string;
          link_url?: string | null;
          purpose?: string;
          opportunity_id?: string | null;
          status?: string;
          created_at?: Timestamptz;
          sent_at?: Timestamptz | null;
          message_id?: string | null;
        };
        Update: {
          status?: string;
          sent_at?: Timestamptz | null;
          message_id?: string | null;
        };
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}

/** The one client type the rest of the store passes around. */
export type StoreClient = SupabaseClient<Database>;

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Every failure that leaves the store layer. Callers can catch one type instead
 * of discriminating PostgREST errors from Zod errors from missing-config errors.
 */
export class StoreError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreError';
  }
}

/**
 * Structural stand-in for `PostgrestError`. Declared locally rather than
 * imported so the store does not depend on which supabase-js minor version
 * re-exports the error class.
 */
export interface DbError {
  message: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
}

/** The `{ data, error }` envelope every PostgREST call resolves to. */
export interface DbResponse<T> {
  data: T | null;
  error: DbError | null;
}

/** Postgres `unique_violation`. The signal behind every "already there" path. */
export const UNIQUE_VIOLATION = '23505';

/** Postgres/PostgREST "no rows returned by `.single()`". */
export const NO_ROWS_RETURNED = 'PGRST116';

export function isUniqueViolation(error: DbError | null): boolean {
  return error !== null && error.code === UNIQUE_VIOLATION;
}

/* -------------------------------------------------------------------------- */
/* Client                                                                     */
/* -------------------------------------------------------------------------- */

let memoizedClient: StoreClient | null = null;

/** True when both Supabase keys are present. Never touches the network. */
export function isStoreReady(): boolean {
  return hasCapability('supabase');
}

/**
 * The service-role client, constructed on first call and memoized thereafter.
 *
 * Throws only when actually called without configuration, which is the point:
 * importing the store must never be able to take the process down.
 */
export function getClient(): StoreClient {
  if (memoizedClient !== null) return memoizedClient;

  const url = requireEnv('SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  memoizedClient = createClient<Database>(url, serviceRoleKey, {
    auth: {
      // Server-side service-role usage: there is no user session to persist and
      // nothing to refresh. Turning these off keeps workers from spawning
      // background timers that outlive a tick.
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: { headers: { 'x-client-info': 'leadvelocity-store' } },
  });

  return memoizedClient;
}

/**
 * Client for an operation that cannot degrade. Fails with a `StoreError` naming
 * the operation instead of a bare "Missing required environment variable".
 */
export function requireClient(operation: string): StoreClient {
  if (!isStoreReady()) {
    throw new StoreError(
      `${operation} requires Supabase, which is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY).`,
    );
  }
  return getClient();
}

/* -------------------------------------------------------------------------- */
/* Response handling                                                          */
/* -------------------------------------------------------------------------- */

/** Unwrap a response that must have produced a value. */
export function unwrap<T>(response: DbResponse<T>, operation: string): T {
  if (response.error !== null) {
    throw new StoreError(`${operation} failed: ${response.error.message}`, {
      cause: response.error,
    });
  }
  if (response.data === null || response.data === undefined) {
    throw new StoreError(`${operation} returned no data`);
  }
  return response.data;
}

/** Unwrap a response where "no row" is a legitimate answer. */
export function unwrapMaybe<T>(response: DbResponse<T>, operation: string): T | null {
  if (response.error !== null) {
    if (response.error.code === NO_ROWS_RETURNED) return null;
    throw new StoreError(`${operation} failed: ${response.error.message}`, {
      cause: response.error,
    });
  }
  return response.data ?? null;
}

/** Raise on error for a write whose returned rows we do not need. */
export function assertOk(response: { error: DbError | null }, operation: string): void {
  if (response.error !== null) {
    throw new StoreError(`${operation} failed: ${response.error.message}`, {
      cause: response.error,
    });
  }
}

/** Unwrap a `{ count }` response from a `head: true` query. */
export function unwrapCount(
  response: { count: number | null; error: DbError | null },
  operation: string,
): number {
  assertOk(response, operation);
  return response.count ?? 0;
}

/* -------------------------------------------------------------------------- */
/* Boundary validation                                                        */
/* -------------------------------------------------------------------------- */

/** Validate one row leaving the database. */
export function parseRow<S extends z.ZodTypeAny>(
  schema: S,
  row: unknown,
  context: string,
): z.infer<S> {
  const result = schema.safeParse(row);
  if (!result.success) {
    throw new StoreError(`${context}: row failed validation (${result.error.message})`, {
      cause: result.error,
    });
  }
  return result.data as z.infer<S>;
}

/** Validate a set of rows leaving the database. */
export function parseRows<S extends z.ZodTypeAny>(
  schema: S,
  rows: readonly unknown[],
  context: string,
): Array<z.infer<S>> {
  return rows.map((row, index) => parseRow(schema, row, `${context}[${index}]`));
}

/**
 * Timestamp column normalizer.
 *
 * PostgREST renders `timestamptz` as `2026-08-15T09:00:00.123456+00:00`, which
 * `z.string().datetime({ offset: true })` accepts but downstream code should not
 * have to special-case. Every timestamp is re-emitted in canonical `Z` form so
 * the whole application compares and sorts timestamps as plain strings.
 */
export const dbTimestamp = z
  .string()
  .min(1)
  .refine((value) => !Number.isNaN(Date.parse(value)), {
    message: 'not a parseable timestamp',
  })
  .transform((value) => new Date(value).toISOString());

/** Nullable timestamp column. `null` stays `null`; it is never invented. */
export const dbTimestampNullable = dbTimestamp.nullable();

/* -------------------------------------------------------------------------- */
/* Small shared utilities                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The store is the side-effect layer, so reading the clock here is allowed.
 * Pure modules (scoring, normalizers) take `now` as a parameter instead.
 */
export function nowIso(): string {
  return new Date().toISOString();
}

/** Rows per request when reading or writing a whole table. */
export const PAGE_SIZE = 1000;

/** Split a list into fixed-size batches so a write never sends one huge body. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new StoreError(`chunk size must be >= 1, received ${size}`);
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

/**
 * Read every row of a query, page by page.
 *
 * PostgREST caps a single response, and `permit_records` holds five figures of
 * rows, so any "give me the whole table" read has to paginate or it silently
 * truncates. Silent truncation in the snapshot-diff path would look exactly like
 * "these permits are new", which is the one lie this system must not tell.
 */
export async function fetchAllPaged<T>(
  operation: string,
  runPage: (from: number, to: number) => PromiseLike<DbResponse<T[]>>,
  pageSize: number = PAGE_SIZE,
): Promise<T[]> {
  const all: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const page = unwrap(await runPage(from, from + pageSize - 1), `${operation} (offset ${from})`);
    all.push(...page);
    if (page.length < pageSize) return all;
  }
}
