/**
 * `npm run db:migrate` - apply `supabase/migrations/*.sql` to the Supabase database.
 *
 * Also the Render `preDeployCommand`, which sets the bar for this file: it runs
 * unattended before a deploy is allowed to go live, so it must be idempotent, it
 * must say out loud what it did, and it must exit non-zero rather than let a
 * half-migrated schema through.
 *
 * What it does, in order:
 *
 * 1. Refuse to start without Supabase configuration, naming the exact missing
 *    keys. A migration runner that "degrades gracefully" would be a runner that
 *    lets a deploy proceed against an unmigrated database, so this is the one
 *    place in the codebase where a missing credential is fatal by design.
 * 2. Open a transport to the database (see below).
 * 3. Create `schema_migrations` if it is absent.
 * 4. Read every `*.sql` file in `supabase/migrations`, sorted lexically, which is
 *    what makes the `0001_`, `0002_` prefix convention meaningful.
 * 5. Apply the ones that are not recorded yet, each as a single statement batch
 *    so it lands in one transaction, and record it. Print applied or skipped for
 *    every file.
 *
 * ==========================================================================
 * WHY TWO TRANSPORTS
 * ==========================================================================
 * PostgREST, which is what `@supabase/supabase-js` speaks, cannot run DDL. A
 * migration runner therefore needs either a Postgres wire connection or a
 * database-side function that will execute SQL on its behalf. This project has
 * no Postgres driver in its dependency list, so both routes are supported and
 * tried in order:
 *
 *   1. `postgres`  - a direct connection, used when `SUPABASE_DB_URL` (or
 *                    `DATABASE_URL`) is set AND a `pg` driver can be resolved at
 *                    runtime. Preferred: no database-side setup, real
 *                    transactions, ordinary error messages.
 *   2. `rest-rpc`  - `supabase-js` calling two SECURITY DEFINER helper functions
 *                    that the operator installs once from the Supabase SQL
 *                    editor. Needs nothing but the two keys already documented
 *                    in `.env.example`.
 *
 * When neither is available the script prints the exact bootstrap SQL to paste,
 * and exits non-zero. It never reports success it did not achieve.
 *
 * The helper functions execute arbitrary SQL as their definer, so the bootstrap
 * revokes them from `public`, `anon` and `authenticated` and grants execute to
 * `service_role` only. Do not loosen that.
 *
 * ==========================================================================
 * THE STORE RULE, AND WHY THIS FILE IS OUTSIDE IT
 * ==========================================================================
 * `lib/store/*` is normally the only module that talks to Postgres. The migrator
 * is the documented exception: it runs BEFORE the schema those typed helpers
 * describe exists, and `schema_migrations` is deliberately absent from the
 * store's `Database` type because nothing above this file should ever read it.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';

import { hasCapability, missingKeys, optionalEnv, requireEnv } from '@/lib/config/deployment-env';

/* -------------------------------------------------------------------------- */
/* Locations and constants                                                    */
/* -------------------------------------------------------------------------- */

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase', 'migrations');

/** Database-side helpers the REST transport calls. Installed by the bootstrap. */
const EXEC_FUNCTION = 'leadvelocity_exec';
const QUERY_FUNCTION = 'leadvelocity_query';

/** Connection-string env keys, in the order they are consulted. */
const DB_URL_KEYS = ['SUPABASE_DB_URL', 'DATABASE_URL'] as const;

/**
 * The ledger. `version` is the file name without its extension, `checksum` is a
 * SHA-256 of the file bytes so a migration that was edited after being applied
 * can be reported instead of silently diverging from the live schema.
 */
const SCHEMA_MIGRATIONS_DDL = `
create table if not exists public.schema_migrations (
  version     text primary key,
  checksum    text not null,
  applied_at  timestamptz not null default now()
);
`;

/** One-time setup for the REST transport. Printed verbatim when it is missing. */
const BOOTSTRAP_SQL = `
-- LeadVelocity migration bootstrap. Run once, in the Supabase SQL editor.
-- These two functions let 'npm run db:migrate' apply DDL through PostgREST.

create or replace function public.${EXEC_FUNCTION}(statement text)
returns void
language plpgsql
security definer
set search_path = public
as $fn$
begin
  execute statement;
end;
$fn$;

create or replace function public.${QUERY_FUNCTION}(statement text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  payload jsonb;
begin
  execute 'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (' || statement || ') t'
    into payload;
  return payload;
end;
$fn$;

-- Both functions run arbitrary SQL as their definer. Only the service role may
-- call them; the anon and authenticated roles must not.
revoke all on function public.${EXEC_FUNCTION}(text) from public, anon, authenticated;
revoke all on function public.${QUERY_FUNCTION}(text) from public, anon, authenticated;
grant execute on function public.${EXEC_FUNCTION}(text) to service_role;
grant execute on function public.${QUERY_FUNCTION}(text) to service_role;
`;

const USAGE = `
Usage: npm run db:migrate

Applies supabase/migrations/*.sql in lexical order, once each, recording what it
applied in the schema_migrations table.

Environment:
  SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   required
  SUPABASE_DB_URL or DATABASE_URL           optional; a direct Postgres
                                            connection string (append
                                            ?sslmode=require). Used when a 'pg'
                                            driver is installed.
`;

/* -------------------------------------------------------------------------- */
/* Local environment                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Load `.env.local` when it exists.
 *
 * `tsx` does not read dotenv files and this project has no dotenv dependency, so
 * without this the flow documented in docs/BLOCKERS.md (fill in `.env.local`,
 * then `npm run db:migrate`) would report every Supabase key as missing while
 * sitting next to a perfectly good file. Node's own loader is used, and it does
 * NOT overwrite variables that are already set, so a real deployment environment
 * always wins over a stray local file.
 */
function loadLocalEnv(): void {
  if (typeof process.loadEnvFile !== 'function') return;
  const envFile = path.join(REPO_ROOT, '.env.local');
  if (!existsSync(envFile)) return;
  try {
    process.loadEnvFile(envFile);
  } catch (cause) {
    console.warn(`[migrate] Ignoring unreadable .env.local: ${describeCause(cause)}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

class MigrationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MigrationError';
  }
}

/** Raised when the REST transport's database-side helpers are not installed. */
class BootstrapRequiredError extends MigrationError {
  constructor(detail: string) {
    super(detail);
    this.name = 'BootstrapRequiredError';
  }
}

/* -------------------------------------------------------------------------- */
/* Migration files                                                            */
/* -------------------------------------------------------------------------- */

interface MigrationFile {
  /** File name without the `.sql` extension, e.g. `0001_init`. */
  readonly version: string;
  readonly fileName: string;
  readonly sql: string;
  readonly checksum: string;
}

/**
 * Every `*.sql` file in `supabase/migrations`, sorted lexically.
 *
 * Plain code-unit ordering, not a locale collation: `0001_init` must sort before
 * `0010_x` on every machine that runs this, and a locale-aware comparator is
 * exactly the kind of thing that silently reorders on someone else's laptop.
 */
async function loadMigrations(): Promise<MigrationFile[]> {
  let entries: string[];
  try {
    entries = await readdir(MIGRATIONS_DIR);
  } catch (cause) {
    throw new MigrationError(`Cannot read migrations directory ${MIGRATIONS_DIR}`, { cause });
  }

  const fileNames = entries.filter((name) => name.toLowerCase().endsWith('.sql')).sort();

  const migrations: MigrationFile[] = [];
  for (const fileName of fileNames) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, fileName), 'utf8');
    migrations.push({
      version: fileName.replace(/\.sql$/i, ''),
      fileName,
      sql,
      checksum: createHash('sha256').update(sql, 'utf8').digest('hex'),
    });
  }
  return migrations;
}

/** Single-quoted SQL literal. Versions and checksums are ours, but never trust. */
function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * A migration and its ledger entry as one statement batch.
 *
 * Concatenation rather than a separate call is deliberate: both transports run a
 * batch inside a single transaction, so the schema change and the record of it
 * either both land or neither does. There is no window in which the schema moved
 * but the ledger did not.
 */
function applyBatch(migration: MigrationFile): string {
  return [
    migration.sql,
    ';',
    `insert into public.schema_migrations (version, checksum) values (`,
    `${sqlLiteral(migration.version)}, ${sqlLiteral(migration.checksum)}`,
    `) on conflict (version) do nothing;`,
  ].join('\n');
}

/* -------------------------------------------------------------------------- */
/* Transports                                                                 */
/* -------------------------------------------------------------------------- */

interface Transport {
  /** Human-readable name for the log line. Never contains a credential. */
  readonly name: string;
  /** Run a statement batch. Must be atomic. */
  exec(sql: string): Promise<void>;
  /** Run a single `select` and return its rows. */
  query(sql: string): Promise<unknown[]>;
  close(): Promise<void>;
}

/* --- 1. direct Postgres --------------------------------------------------- */

/**
 * The slice of `pg` this file uses. Declared structurally because `pg` is not a
 * dependency of this project: it is used when it happens to be resolvable, and
 * its absence is a normal, handled outcome rather than a build error.
 */
interface PgQueryResult {
  readonly rows: unknown[];
}
interface PgClientLike {
  connect(): Promise<void>;
  query(text: string): Promise<PgQueryResult>;
  end(): Promise<void>;
}
type PgClientConstructor = new (config: { connectionString: string }) => PgClientLike;

/** Narrow an untyped module namespace to the one export we need. */
function readPgConstructor(value: unknown): PgClientConstructor | null {
  if (typeof value !== 'object' || value === null) return null;
  const namespace = value as { Client?: unknown; default?: { Client?: unknown } };
  const candidate = namespace.Client ?? namespace.default?.Client;
  return typeof candidate === 'function' ? (candidate as PgClientConstructor) : null;
}

/**
 * Open a direct connection, or return `null` with the reason.
 *
 * The specifier is held in a variable on purpose: a literal `import('pg')` would
 * be a compile-time module resolution error in a project that does not depend on
 * `pg`, and this path must stay optional.
 */
async function openPostgresTransport(): Promise<
  { transport: Transport } | { transport: null; reason: string }
> {
  const key = DB_URL_KEYS.find((candidate) => optionalEnv(candidate) !== null);
  if (key === undefined) {
    return { transport: null, reason: `no ${DB_URL_KEYS.join(' or ')} set` };
  }
  const connectionString = requireEnv(key);

  const specifier = 'pg';
  let namespace: unknown;
  try {
    namespace = (await import(specifier)) as unknown;
  } catch {
    return { transport: null, reason: `${key} is set but the 'pg' driver is not installed` };
  }

  const PgClient = readPgConstructor(namespace);
  if (PgClient === null) {
    return { transport: null, reason: `'pg' resolved but exports no Client constructor` };
  }

  // The connection string carries its own TLS policy (append ?sslmode=require
  // for Supabase). Nothing is overridden here: silently downgrading certificate
  // verification on a connection that carries the database password would be a
  // worse default than a loud TLS error.
  const client = new PgClient({ connectionString });
  try {
    await client.connect();
  } catch (cause) {
    throw new MigrationError(
      `Could not connect using ${key}. Check the connection string and that it ends with ?sslmode=require.`,
      { cause },
    );
  }

  return {
    transport: {
      name: `postgres (via ${key})`,
      async exec(sql: string): Promise<void> {
        await client.query(`begin;\n${sql}\n;commit;`).catch(async (cause: unknown) => {
          await client.query('rollback;').catch(() => undefined);
          throw new MigrationError(describeCause(cause), { cause });
        });
      },
      async query(sql: string): Promise<unknown[]> {
        const result = await client.query(sql);
        return result.rows;
      },
      async close(): Promise<void> {
        await client.end().catch(() => undefined);
      },
    },
  };
}

/* --- 2. PostgREST RPC ----------------------------------------------------- */

/** PostgREST's "no such function in the schema cache" codes. */
const FUNCTION_MISSING_CODES = new Set(['PGRST202', 'PGRST203', '42883']);

function isFunctionMissing(error: { code?: string; message?: string }): boolean {
  if (error.code !== undefined && FUNCTION_MISSING_CODES.has(error.code)) return true;
  const message = error.message ?? '';
  return message.includes('schema cache') || message.includes('does not exist');
}

/**
 * The `supabase-js` transport.
 *
 * Each `.rpc()` call is one HTTP request and PostgREST wraps one request in one
 * transaction, so a statement batch sent through `exec` is as atomic as the
 * `begin/commit` the direct transport issues.
 */
function openRestTransport(): Transport {
  const url = requireEnv('SUPABASE_URL');
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');

  const client = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-client-info': 'leadvelocity-migrate' } },
  });

  const rowsSchema = z.array(z.unknown());

  return {
    // Host only. The service role key never reaches a log line.
    name: `rest-rpc (${new URL(url).host})`,
    async exec(sql: string): Promise<void> {
      const { error } = await client.rpc(EXEC_FUNCTION, { statement: sql });
      if (error === null) return;
      if (isFunctionMissing(error)) {
        throw new BootstrapRequiredError(
          `public.${EXEC_FUNCTION}(text) is not installed in this project.`,
        );
      }
      throw new MigrationError(error.message, { cause: error });
    },
    async query(sql: string): Promise<unknown[]> {
      const { data, error } = await client.rpc(QUERY_FUNCTION, { statement: sql });
      if (error !== null) {
        if (isFunctionMissing(error)) {
          throw new BootstrapRequiredError(
            `public.${QUERY_FUNCTION}(text) is not installed in this project.`,
          );
        }
        throw new MigrationError(error.message, { cause: error });
      }
      const parsed = rowsSchema.safeParse(data);
      if (!parsed.success) {
        throw new MigrationError(
          `public.${QUERY_FUNCTION} returned something other than a JSON array.`,
        );
      }
      return parsed.data;
    },
    async close(): Promise<void> {
      // Nothing to release: supabase-js holds no pooled connection here.
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Ledger                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The two transports disagree on how a `timestamptz` comes back, so this has to
 * accept both. PostgREST returns an ISO string; the `pg` driver parses it into a
 * JavaScript `Date`. Normalizing here rather than at the call site keeps
 * `LedgerEntry.appliedAt` a plain string whichever route ran.
 */
const ledgerTimestamp = z
  .union([z.string(), z.date()])
  .nullable()
  .optional()
  .transform((value) => (value instanceof Date ? value.toISOString() : (value ?? null)));

const ledgerRowSchema = z.object({
  version: z.string().min(1),
  checksum: z.string().min(1),
  applied_at: ledgerTimestamp,
});

interface LedgerEntry {
  readonly checksum: string;
  readonly appliedAt: string | null;
}

/** Everything already applied, keyed by version. */
async function readLedger(transport: Transport): Promise<Map<string, LedgerEntry>> {
  const rows = await transport.query(
    'select version, checksum, applied_at from public.schema_migrations',
  );
  const ledger = new Map<string, LedgerEntry>();
  for (const row of rows) {
    const parsed = ledgerRowSchema.safeParse(row);
    if (!parsed.success) {
      throw new MigrationError(`schema_migrations row failed validation: ${parsed.error.message}`);
    }
    ledger.set(parsed.data.version, {
      checksum: parsed.data.checksum,
      appliedAt: parsed.data.applied_at ?? null,
    });
  }
  return ledger;
}

/* -------------------------------------------------------------------------- */
/* Output                                                                     */
/* -------------------------------------------------------------------------- */

function log(message: string): void {
  console.log(`[migrate] ${message}`);
}

function warn(message: string): void {
  console.warn(`[migrate] ${message}`);
}

function fail(message: string): void {
  console.error(`[migrate] ${message}`);
}

function describeCause(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

async function main(): Promise<number> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE.trim());
    return 0;
  }

  loadLocalEnv();

  if (!hasCapability('supabase')) {
    fail('Supabase is not configured, so there is nothing to migrate against.');
    fail(`Missing: ${missingKeys('supabase').join(', ')}`);
    fail('Set them in .env.local (see .env.example) or in the Render environment.');
    fail('See docs/BLOCKERS.md section 1.');
    return 1;
  }

  const migrations = await loadMigrations();
  if (migrations.length === 0) {
    log(`No .sql files in ${MIGRATIONS_DIR}. Nothing to do.`);
    return 0;
  }

  const direct = await openPostgresTransport();
  const transport = direct.transport ?? openRestTransport();
  if (direct.transport === null) {
    log(`Direct connection not used: ${direct.reason}.`);
  }
  log(`Transport: ${transport.name}`);
  log(`${migrations.length} migration file(s) in supabase/migrations`);

  let applied = 0;
  let skipped = 0;

  try {
    await transport.exec(SCHEMA_MIGRATIONS_DDL);
    const ledger = await readLedger(transport);

    for (const migration of migrations) {
      const previous = ledger.get(migration.version);

      if (previous !== undefined) {
        skipped += 1;
        const when = previous.appliedAt === null ? 'previously' : `at ${previous.appliedAt}`;
        log(`${migration.version} ... skipped (already applied ${when})`);
        if (previous.checksum !== migration.checksum) {
          // Not fatal: the schema is whatever was applied, and refusing to deploy
          // over an edited file would strand the service. It is still a real
          // divergence and must not pass unremarked.
          warn(
            `${migration.fileName} has changed since it was applied. The live schema reflects ` +
              `the ORIGINAL file. Add a new migration rather than editing an applied one.`,
          );
        }
        continue;
      }

      const startedAt = Date.now();
      await transport.exec(applyBatch(migration));
      applied += 1;
      log(`${migration.version} ... applied (${Date.now() - startedAt} ms)`);
    }
  } finally {
    await transport.close();
  }

  log(`Done: ${applied} applied, ${skipped} skipped.`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof BootstrapRequiredError) {
      fail(error.message);
      fail('');
      fail('This project has no Postgres driver, so migrations go through two');
      fail('database-side helper functions. Install them once, then re-run:');
      fail('');
      fail('  1. Open the Supabase dashboard -> SQL Editor -> New query');
      fail('  2. Paste the block below and run it');
      fail('  3. npm run db:migrate');
      fail('');
      console.error(BOOTSTRAP_SQL.trim());
      fail('');
      fail('Alternative: install a Postgres driver (npm i pg) and set');
      fail('SUPABASE_DB_URL to the connection string with ?sslmode=require.');
    } else {
      fail(`Migration failed: ${describeCause(error)}`);
    }
    process.exitCode = 1;
  });
