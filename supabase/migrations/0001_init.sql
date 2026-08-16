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
