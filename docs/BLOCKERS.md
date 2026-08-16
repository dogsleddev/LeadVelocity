# Blockers: what only a human can clear

Status as of event day, Aug 15 2026. Everything in this file is something I could not do from the
build environment, either because it needs an account/credential or because it needs a human decision.
Everything NOT in this file is either done or in the build.

Ordered by what breaks the demo soonest.

---

## 1. Supabase project + keys (blocks: literally everything stateful)

Nothing persists without this. The migration, the workers, the decision log, and every screen read from it.

1. Create a Supabase project (free tier is fine for the day).
2. From Project Settings -> API, copy `Project URL`, `anon public`, and `service_role` keys.
3. Put them in **`.env.local`**, not `.env.example`. `.env.example` is a committed template and is
   deliberately not gitignored; `.env.local` is. Keys go in as `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`.
4. Apply the schema. There are two ways; the first needs nothing else from you.

**Fastest, no password (recommended for event day).** Open the **SQL Editor** in the Supabase dashboard
left nav, paste all of `supabase/bootstrap.sql`, and run it once. That file is generated from the
migrations and records the same ledger rows with the same sha256 checksums, so a later `npm run db:migrate`
reports "skipped (already applied)" rather than re-running. Every statement is guarded, so running it twice
is harmless. Regenerate it if you change a migration.

**Or, the connection-string route.** Set `SUPABASE_DB_URL` and let the runner do it:

```bash
npm run db:migrate
```

The `pg` driver is installed and every `tsx` script loads `.env.local` automatically
(`--env-file-if-exists`), so it will just run once the URL is set.

Finding the connection string: it is **not** under Project Settings in current dashboards. Use the
**Connect** button in the header next to the project name. That modal offers a direct connection, a
transaction pooler and a session pooler. Prefer a **pooler** string if your network is IPv4 only, since the
direct `db.<ref>.supabase.co` host is IPv6 only on newer projects. Append `?sslmode=require`.

```
SUPABASE_DB_URL=postgresql://postgres.<ref>:<password>@<pooler-host>:5432/postgres?sslmode=require
```

That string contains your database password, which is separate from the API keys.

There is also a third path, mentioned only so it is not a surprise: running `npm run db:migrate` with no
`SUPABASE_DB_URL` prints bootstrap SQL that installs two `security definer` helpers so the runner can work
over PostgREST. Those helpers execute arbitrary SQL as their definer. The script revokes them from `anon`
and `authenticated`, but prefer either option above.

Exit criteria: `npm run db:migrate` prints applied migrations and exits 0, and
`/api/health/ready` reports `supabase: ready`.

---

## 2. Stripe individual account in LIVE mode (blocks: Best Overall eligibility)

This is an event eligibility rule (kickoff section 10.3), not just a feature. I cannot create accounts or
handle payment credentials, so this is entirely yours.

1. Stripe account as an **individual**, live mode activated.
2. Create a recurring product at **149/mo** and a Payment Link for it.
3. Webhook endpoint -> `https://<your-render-url>/api/stripe/webhook`, subscribed to
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed`.
4. Env: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`, `STRIPE_PAYMENT_LINK_URL`.

Build and rehearse against **test** keys, then swap to live keys for the demo. The app derives the reported
mode from the key prefix, so the UI can never claim live while running test.

Confirm at check-in whether eligibility needs an actual live charge during the event or only a live account
collecting. If a live charge is needed, plan to refund it afterwards.

Exit criteria: a checkout completes, the webhook flips the subscription row to `active`, and a repeated
webhook delivery is a no-op.

---

## 3. Linq sandbox key, number and webhook (blocks: the delivery channel, which is the whole product)

**The channel is Linq now, not Twilio.** Linq reaches the phone over iMessage, RCS or SMS through one API.
Twilio is still implemented as the fallback, see 3b below. The reversal of kickoff section 10 decision 2 is
recorded in `SOP_BUILD_PRELIMINARY.md`.

### 3a. Linq (do this one)

1. In the Linq dashboard, get a **sandbox API key** and a **Linq number** for the event.
2. Env: `LINQ_API_V3_API_KEY`. Leave `LINQ_API_V3_BASE_URL` unset unless Linq tells you otherwise; it
   defaults to `https://api.linqapp.com/api/partner`. `LINQ_FROM_NUMBER` is optional, Linq picks a line if
   it is unset.
3. Create a **webhook subscription** pointing at `https://<your-render-url>/api/linq/inbound`, subscribed to
   the `message.received` event.
4. Copy that subscription's **`signing_secret`** into `LINQ_WEBHOOK_SECRET`. Signatures are Standard
   Webhooks. Without this value the app refuses to parse inbound bodies at all, on purpose, rather than
   trusting an unverified payload. No secret means no feedback loop and no queue release.
5. Set `DEMO_PHONE_NUMBER` to the consenting demo phone.
6. Leave `DELIVERY_CHANNEL=linq` and `LINQ_ALLOW_COLD_OUTBOUND=false`.

### Three sandbox limits that shape the day

| Limit | What it means for you |
|---|---|
| **Inbound first** | The company can only message a handle that has texted the Linq number first. Outbound to a stranger is refused by the platform, not just discouraged. |
| **100 unique contacts** | The prospect pool is roughly 14,000 contractors. The Sales Agent will queue far more than it ever sends, which is correct behaviour, but do not expect volume. |
| **The number lives 7 days** | Provision it close to the event. If it has expired, everything queues and nothing sends. Messages are unlimited within those limits. |

### The one thing that will break the demo if you skip it

**Text the Linq number from the demo phone BEFORE the demo.** Send anything, "hi" is fine.

That single inbound message is what creates the thread and puts the handle in `inbound_contacts`, which is
what makes the handle reachable. Skip it and the demo is still honest and still correct, it just shows the
Sales Agent composing a sample, queueing it, and logging "sample prepared, waiting for first contact"
instead of a message arriving on the phone in front of the judges. Do it during setup, not during your slot.

Do not work around this by setting `LINQ_ALLOW_COLD_OUTBOUND=true`. That flag is for a production Linq number
that genuinely has no such restriction. On the sandbox it does not remove the platform rule, it only removes
the app's up-front check, so sends fail at the API instead of queueing cleanly.

Note: outbound copy is hard-guarded in code on both channels. A message containing AI/agent/autonomous/LLM
language or an em dash throws rather than sends (CLAUDE.md rule 9).

Exit criteria: the demo phone texts the Linq number, an events row records the inbound contact, a real
message lands back on the demo phone over iMessage, RCS or SMS, and replying "good" writes feedback and an
events row. Bonus check that the queue works: with a handle that has not texted in, confirm an
`outbound_queue` row and a "waiting for first contact" entry in the decision log.

### 3b. Twilio (fallback only, optional, but cheap insurance)

Twilio stays implemented behind `lib/delivery/channel.ts`, so if Linq is down at the venue the fix is one env
var and a restart rather than a rewrite. That only works if the credentials are actually present.

1. Twilio account, SMS-capable number provisioned.
2. Env: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`.
3. Messaging webhook for inbound -> `https://<your-render-url>/api/twilio/inbound`.
4. To flip: set `DELIVERY_CHANNEL=twilio` and restart. Twilio has no inbound-first rule, so cold sending
   works on this path and the queue drains.

If you only have time for one, do Linq. Fill in Twilio if you want the fallback to be real rather than
theoretical.

---

## 4. Terac API key (blocks: the P0 GenPop study, an explicit event rule)

**Resolved: the contract is now verified, not guessed.** `lib/integrations/terac.ts` is written against the
real Terac External API v2 OpenAPI spec (`https://terac.com/api/external/v2/openapi.json`). Auth is
`Authorization: Bearer <key>`. All you need is the key.

1. Get your Terac API key.
2. Set `TERAC_API_KEY`. `TERAC_BASE_URL` already defaults correctly.
3. Run the flow. Each step is separate on purpose, because the launch costs money:

```bash
npm run study -- quote
```

Then `draft`, then `launch --max-usd=25`, then `results`. Only `launch` spends anything.

### How the study is modelled, and one honest deviation

Terac has no "survey" primitive. Its model is project -> opportunity -> submissions. So the study is an
opportunity with `unrestricted_audience: true` (that flag is what makes the panel general population),
carrying the questions as `screening_questions` with every answer marked `qualify_logic: 'may'` so they
collect an opinion instead of disqualifying anyone. Results come back as per-answer `selected` counts and
`share` in `screening_stats`.

**The deviation:** the kickoff says the panel should "rank the three texts" and select on mean rank. The
screening mechanism gives forced first-choice selections, not ordinal ranks. So the study asks three
first-choice questions instead (most trusted, clearest, most likely to get a reply), and the winner is
decided on combined selections with trust breaking ties. Same intent, real numbers, no invented ranks.
Winner selection is pure deterministic code, never a model call.

### On spending money autonomously

Launching a panel is a real purchase, so it cannot happen as a side effect of a worker tick. `launchStudy`
requires an explicit authorization object carrying a spend ceiling and re-checks the live quoted cost against
it before committing. An unknown cost is treated as over budget, never as free.

`TERAC_STUDY_BUDGET_CENTS` defaults to **0**, meaning the company will draft a study and get a quote on its
own but will never spend without you. If you want the company to authorize its own panel within a ceiling
during the demo (a strong autonomy beat), set it deliberately, for example `TERAC_STUDY_BUDGET_CENTS=2500`.

**I have not launched a study or spent any money.** That is yours to trigger.

### Still worth asking at check-in

Expected panel turnaround and any caps, since the before-and-after beat depends on results landing before
your slot. Launch as early as possible.

Exit criteria: a study launches, results land, deterministic winner selection picks the shipped copy, and the
before-and-after renders on `/dashboard` with real panel numbers.

---

## 5. Anthropic API key (blocks: shortlist interpretation, prospect classification, drafting)

Env: `ANTHROPIC_API_KEY`. The deterministic path (filters, scoring, billing) runs without it; the
interpretation steps degrade to a logged "skipped" rather than guessing.

---

## 6. Render deploy (blocks: "the company runs unattended", which is the autonomy proof)

`render.yaml` is written and declares the web service, the worker service, and the ingest cron, with every
secret `sync: false`.

1. Connect the repo to Render, apply the blueprint.
2. Fill every `sync: false` value in the Render dashboard, and populate the `leadvelocity-shared` env group.
   That includes the `LINQ_*` keys on both the web service and the group; the workers send, the web service
   receives.
3. Confirm `/api/health/live` is green and `/api/health/ready` names anything still missing.
4. Render is also what gives the Linq webhook a public URL. Once the web service is up, take its URL and
   point the Linq subscription at `https://<your-render-url>/api/linq/inbound` (section 3a step 3). Deploy
   before you create the subscription and you only have to do it once.

Per SOP_EVENT_DAY Phase 1, get this running before building further. Hours of accumulated decision-log depth
is proof you cannot fake at demo time.

---

## 7. Decisions only you can make

| # | Decision | Default if you say nothing |
|---|---|---|
| 1 | SF confirmed as territory, or override to San Jose | **SF.** The build is SF-specific and the data is already on disk. Switching now is a bad trade. |
| 2 | Who plays the subscriber phone during the demo | Unassigned. Needed before rehearsal, and that phone has to text the Linq number before the demo, see section 3. |
| 3 | Repo name and where it lives | Local only right now, git initialised on `main`, no remote. |
| 4 | Whether to disclose the SiteVelocity-derived patterns at check-in | Disclose. See note below. |

**On reuse disclosure:** I did not clone or copy SiteVelocity. The repo was empty, so I wrote fresh modules
that follow the documented patterns and adopt the merge-critical vocabulary (`SourceDescriptor`, `Finding`,
`ScoreOutput`, snapshot semantics), with origin notes in the file headers pointing at the public repo. The
honest line at check-in is: "adopted the architecture and vocabulary of an existing personal project,
wrote the LeadVelocity product and agent logic today." If the reuse map's fidelity matters for the
post-hackathon merge, clone https://github.com/samshanmukh/SiteVelocity and diff the interfaces.

---

## 8. Known deviation: the CSLB prospect pool

The kickoff calls for `cslb-c10-sf.csv`, the CSLB C-10 list for San Francisco county.

**I could not obtain it.** The CSLB data portal's ListByClassification download is an ASP.NET WebForms page
gated behind a `__VIEWSTATE` / `__EVENTVALIDATION` postback, and the documented bulk zip returns 404.
Reverse-engineering the postback is exactly the kind of open-ended integration the kickoff's fenced-stretch
rule exists to prevent, so I did not spend the day on it.

**What I substituted:** the prospect pool is seeded from the real DataSF permit contacts already on disk,
roughly 14,000 rows carrying a contractor license number and firm name, deduplicated by license. These are
contractors *demonstrably active in San Francisco*, which is arguably a better acquisition list than a raw
classification dump. Each is stored with `source_id = 'datasf.building_permit_contacts'`.

**What this costs:** the permit contacts dataset does not carry the CSLB classification, so I cannot filter
to C-10 deterministically, and I will not invent it. Classification is left `null`/`unknown`, and the AI
commercial-vs-residential step labels its judgement `inferred`, never `verified`.

**If you want the real C-10 list:** either drive the CSLB portal by hand in a browser and drop the CSV at
`data/cslb-c10-sf.csv`, or ask CSLB for the bulk file. The loader is already written to prefer that file if
it appears. This is a 15-minute manual job for a human with a browser and it would upgrade the evidence
label on every prospect, so it is worth doing if you have a spare pair of hands.
