-- LeadVelocity: one-shot schema bootstrap for the Supabase SQL Editor.
--
-- Paste this whole file into the Supabase SQL Editor and run it once.
--
-- It does exactly what `npm run db:migrate` would do, and records the same
-- ledger rows with the same sha256 checksums, so a later `npm run db:migrate`
-- reports "skipped (already applied)" instead of re-running or complaining that
-- a migration changed.
--
-- Every statement is guarded (create table if not exists / create or replace /
-- drop trigger if exists), so running this twice is safe.
--
-- GENERATED from supabase/migrations/. If you edit a migration, regenerate.

create table if not exists public.schema_migrations (
  version     text primary key,
  checksum    text not null,
  applied_at  timestamptz not null default now()
);

-- ===================================================================
-- 0001_init.sql
-- ===================================================================
-- LeadVelocity initial schema.
--
-- Origin: store/migration patterns adapted from SiteVelocity, simplified to a
-- single workspace (tenant-aware complexity dropped per kickoff section 5).
--
-- Table list is kickoff section 6: prospects, customers, permit_records,
-- candidates, findings, opportunities, subscriptions, events, settings, plus
-- the replay staging table and the Terac study store the P0 scope requires.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- settings: one row. The kill switch every worker checks at tick start.
-- ---------------------------------------------------------------------------
create table if not exists settings (
  id                      text primary key default 'singleton',
  kill_switch             boolean not null default false,
  replay_speed_multiplier integer not null default 60,
  replay_active           boolean not null default false,
  updated_at              timestamptz not null default now(),
  constraint settings_singleton check (id = 'singleton')
);

insert into settings (id) values ('singleton') on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- customers: the subscriber profile driving fit scoring.
-- ---------------------------------------------------------------------------
create table if not exists customers (
  id                   uuid primary key default gen_random_uuid(),
  business_name        text not null,
  trade                text not null default 'electrical',
  territory_zips       text[] not null default '{}',
  territory_districts  text[] not null default '{}',
  min_project_value    numeric not null default 25000,
  preferred_uses       text[] not null default '{}',
  phone                text not null,
  status               text not null default 'prospect'
                       check (status in ('prospect','active','paused','cancelled')),
  -- Mutated by the Customer Agent on feedback; base profile stays human intent.
  effective_weights    jsonb not null default
                       '{"fit":1,"demand":1,"timing":1,"value":1,"evidence":1}'::jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- prospects: the Sales Agent's acquisition universe.
-- ---------------------------------------------------------------------------
create table if not exists prospects (
  id                uuid primary key default gen_random_uuid(),
  license_number    text,
  firm_name         text not null,
  city              text,
  state             text,
  zipcode           text,
  classification    text,
  license_status    text,
  -- 'commercial' | 'residential' | 'unknown', set by the AI classification step.
  segment           text not null default 'unknown'
                    check (segment in ('commercial','residential','unknown')),
  segment_evidence  text not null default 'unknown'
                    check (segment_evidence in ('verified','corroborated','inferred','unknown')),
  qualified         boolean not null default false,
  qualify_reasons   jsonb not null default '[]'::jsonb,
  source_id         text not null,
  contacted_at      timestamptz,
  created_at        timestamptz not null default now()
);

create unique index if not exists prospects_identity_idx
  on prospects (coalesce(license_number, ''), lower(firm_name));

-- ---------------------------------------------------------------------------
-- permit_records: the trigger layer. Raw + normalized + provenance + hash.
-- ---------------------------------------------------------------------------
create table if not exists permit_records (
  permit_number    text primary key,
  record_id        text,
  raw              jsonb not null,
  normalized       jsonb not null,
  content_hash     text not null,
  provenance       jsonb not null,
  snapshot_status  text not null default 'added'
                   check (snapshot_status in ('added','changed','not_observed')),
  data_as_of       timestamptz,
  data_loaded_at   timestamptz,
  first_seen_at    timestamptz not null default now(),
  last_seen_at     timestamptz not null default now()
);

create index if not exists permit_records_status_idx  on permit_records (snapshot_status);
create index if not exists permit_records_seen_idx    on permit_records (last_seen_at desc);

-- ---------------------------------------------------------------------------
-- replay_staging: real records held at original timestamps, released on the
-- accelerated clock. UI badge reads "real SF records, replayed".
-- ---------------------------------------------------------------------------
create table if not exists replay_staging (
  permit_number  text primary key,
  raw            jsonb not null,
  original_ts    timestamptz not null,
  released       boolean not null default false,
  released_at    timestamptz
);

create index if not exists replay_staging_pending_idx
  on replay_staging (released, original_ts);

-- ---------------------------------------------------------------------------
-- candidates: a permit paired with a customer, moving through the pipeline.
-- ---------------------------------------------------------------------------
create table if not exists candidates (
  id                uuid primary key default gen_random_uuid(),
  permit_number     text not null references permit_records(permit_number) on delete cascade,
  customer_id       uuid not null references customers(id) on delete cascade,
  stage             text not null default 'shortlisted'
                    check (stage in ('shortlisted','enriched','scored','delivered','archived')),
  shortlist_reason  text,
  created_at        timestamptz not null default now(),
  unique (permit_number, customer_id)
);

-- ---------------------------------------------------------------------------
-- findings: evidence-labeled facts. The only way a fact enters the system.
-- ---------------------------------------------------------------------------
create table if not exists findings (
  id            uuid primary key default gen_random_uuid(),
  candidate_id  uuid not null references candidates(id) on delete cascade,
  key           text not null,
  label         text not null,
  value         jsonb,
  evidence      text not null
                check (evidence in ('verified','corroborated','inferred','unknown')),
  source_id     text,
  note          text not null default '',
  observed_at   timestamptz not null default now(),
  unique (candidate_id, key)
);

create index if not exists findings_candidate_idx on findings (candidate_id);

-- ---------------------------------------------------------------------------
-- opportunities: a scored candidate, delivered or archived.
-- ---------------------------------------------------------------------------
create table if not exists opportunities (
  id                  uuid primary key default gen_random_uuid(),
  candidate_id        uuid not null references candidates(id) on delete cascade,
  customer_id         uuid not null references customers(id) on delete cascade,
  score               numeric not null,
  drivers             jsonb not null default '[]'::jsonb,
  warnings            jsonb not null default '[]'::jsonb,
  fatal_flags         jsonb not null default '[]'::jsonb,
  status              text not null default 'pending'
                      check (status in ('pending','delivered','archived')),
  summary             text,
  best_path_in        text,
  recommended_action  text,
  delivered_at        timestamptz,
  feedback            text check (feedback in ('good','too_small','wrong_scope')),
  feedback_at         timestamptz,
  created_at          timestamptz not null default now(),
  unique (candidate_id)
);

create index if not exists opportunities_status_idx on opportunities (status, created_at desc);

-- ---------------------------------------------------------------------------
-- subscriptions: Stripe state. The Lead Agent only fulfills 'active'.
-- ---------------------------------------------------------------------------
create table if not exists subscriptions (
  id                          uuid primary key default gen_random_uuid(),
  customer_id                 uuid not null references customers(id) on delete cascade,
  stripe_customer_id          text,
  stripe_subscription_id      text,
  stripe_checkout_session_id  text,
  status                      text not null default 'inactive'
                              check (status in ('inactive','active','past_due','cancelled')),
  mode                        text not null default 'test' check (mode in ('test','live')),
  current_period_end          timestamptz,
  updated_at                  timestamptz not null default now(),
  unique (customer_id)
);

-- Webhook idempotency: a replayed Stripe event must be a no-op.
create table if not exists stripe_events (
  id           text primary key,
  type         text not null,
  received_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- events: append-only decision log. This log IS the demo.
-- ---------------------------------------------------------------------------
create table if not exists events (
  id       bigserial primary key,
  ts       timestamptz not null default now(),
  agent    text not null check (agent in ('ceo','sales','lead','customer')),
  decision text not null,
  summary  text not null,
  refs     jsonb not null default '{}'::jsonb
);

create index if not exists events_ts_idx    on events (ts desc);
create index if not exists events_agent_idx on events (agent, ts desc);

-- Append-only is enforced, not just intended.
create or replace function events_block_mutation() returns trigger
  language plpgsql as $$
begin
  raise exception 'events is append-only (attempted %)', tg_op;
end;
$$;

drop trigger if exists events_no_update on events;
create trigger events_no_update before update or delete on events
  for each row execute function events_block_mutation();

-- ---------------------------------------------------------------------------
-- message_studies: the Terac GenPop before-and-after (P0 event rule).
-- ---------------------------------------------------------------------------
create table if not exists message_studies (
  id                 uuid primary key default gen_random_uuid(),
  study_ref          text,
  -- [{ id, text }]
  variants           jsonb not null,
  -- [{ id, mean_rank, trust, clarity, n }]
  results            jsonb,
  winner_variant_id  text,
  winner_text        text,
  status             text not null default 'draft'
                     check (status in ('draft','launched','complete','failed')),
  launched_at        timestamptz,
  completed_at       timestamptz,
  created_at         timestamptz not null default now()
);

insert into public.schema_migrations (version, checksum) values ('0001_init', 'fe6bb0b88d6503cbb17ccbdcb1f06a388e3e8be231e02a44da244260ca55bece')
  on conflict (version) do nothing;

-- ===================================================================
-- 0002_linq_channel.sql
-- ===================================================================
-- Linq becomes the delivery channel.
--
-- Two changes, both driven by real platform behaviour rather than preference.
--
-- 1. `inbound_contacts` records who has texted the company's Linq number.
--    Linq's sandbox refuses outbound to anyone who has not made contact first,
--    so "may we message this handle" is a real question the Sales Agent has to
--    answer before composing, not a 403 to discover afterwards.
--
-- 2. `outbound_queue` holds a message that was composed but could not be sent
--    yet because of that rule. Holding it is the honest behaviour: the company
--    did the work, and it is waiting on consent rather than pretending to have
--    delivered. The decision log shows both states.

-- ---------------------------------------------------------------------------
-- inbound_contacts: handles that have messaged us, and are therefore reachable
-- ---------------------------------------------------------------------------
create table if not exists inbound_contacts (
  handle          text primary key,
  channel         text not null default 'linq' check (channel in ('linq','twilio')),
  chat_id         text,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  message_count   integer not null default 1,
  -- Set when the contact asks to stop. Never cleared by the company itself.
  opted_out       boolean not null default false,
  opted_out_at    timestamptz
);

create index if not exists inbound_contacts_recent_idx
  on inbound_contacts (last_seen_at desc);

-- ---------------------------------------------------------------------------
-- outbound_queue: composed, not yet permitted to send
-- ---------------------------------------------------------------------------
create table if not exists outbound_queue (
  id              uuid primary key default gen_random_uuid(),
  handle          text not null,
  body            text not null,
  link_url        text,
  -- What this message is, so the log reads clearly.
  purpose         text not null default 'sales_sample'
                  check (purpose in ('sales_sample','opportunity','other')),
  opportunity_id  uuid references opportunities(id) on delete set null,
  status          text not null default 'waiting_for_inbound'
                  check (status in ('waiting_for_inbound','sent','abandoned')),
  created_at      timestamptz not null default now(),
  sent_at         timestamptz,
  -- Provider id once it actually goes out.
  message_id      text
);

create index if not exists outbound_queue_pending_idx
  on outbound_queue (status, handle, created_at);

-- One pending message per handle per purpose: a tick that runs every two
-- minutes must not pile up twenty copies of the same sample.
create unique index if not exists outbound_queue_one_pending_idx
  on outbound_queue (handle, purpose)
  where status = 'waiting_for_inbound';

insert into public.schema_migrations (version, checksum) values ('0002_linq_channel', 'cdf2aae5330c9911685abee39bdf11c82aacc6e82fb2df8d290a4ef90650394a')
  on conflict (version) do nothing;
