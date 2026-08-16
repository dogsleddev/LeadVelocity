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
