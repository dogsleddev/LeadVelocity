# LeadVelocity: session handoff

**Written Aug 15 2026, end of build day. Updated Aug 15 2026, second session.
Read this first, then `CLAUDE.md`.**

This replaces the "what next" guesswork. It records what is genuinely working, what is half
done, what is a trap, and the four priorities in order.

---

## What the second session changed

Four things, all verified by running them. Detail is inline in the sections below.

1. **The owner-nav bleed is fixed.** The console lives in a route group, `app/(owner)/`, and
   its chrome is no longer in the markup of any other surface. The CSS that used to hide it
   is gone. No URL changed.
2. **The price is one accessor.** `monthlyPriceUsd()` in `lib/config/deployment-env.ts`. It
   was written six times, and two of those copies ignored `SUBSCRIPTION_PRICE_USD` entirely.
3. **The Sales outreach link 404'd on every message.** Fixed, with a copy change it forced.
   See "The dead links" below.
4. **A second family of dead links is found and NOT fixed.** Also in "The dead links".

Terac was deliberately left alone this session. Live pricing was re-quoted and it moved; the
numbers below are current.

---

## The four priorities, in order

1. **Contractor interface + owner dashboard** — both exist and render real data. The one real
   bug is fixed. What remains is polish.
2. **Terac integration** — connected and verified live. A study has never been launched.
   This is the only P0 event rule still unmet.
3. **A 2 minute video demo.**
4. Everything else is behind the cut line.

---

## State in one table

| Thing | State |
|---|---|
| Typecheck | **0 errors** (re-verified after the route-group move) |
| Tests | **225 passing** (re-verified) |
| Production build | compiled clean on day one, **not re-run since**; see the note at the end |
| Supabase | **live**, schema applied, 2 migrations recorded |
| Real permits in store | **1,996** released of 10,049 staged |
| Scored opportunities | **19** (2 delivered at 86 and 85, 17 archived) |
| Findings | **323**, evidence-labeled |
| Decision log | **6,876 events** |
| Prospect pool | **2,564** licensed SF contractors |
| Linq | **working**, number `+14848929911`, healthy |
| Terac | **auth verified**, $125.00 balance, never launched a study |
| Stripe | not configured |
| Deployed | no, local only |

---

## What actually works, verified by running it

**The loop closes.** Real DataSF permit records go in, deterministic filters and an AI
interpretation step run, evidence-labeled Findings get written, a pure scoring module produces
a number, and results are delivered or archived with reasons. All of it against real records,
none of it mocked.

The two delivered leads are real San Francisco jobs:

| Score | Permit | Address | Value |
|---|---|---|---|
| 86 | 202603207976 | 735 Market St | $1,600,000 |
| 85 | 202603238043 | 1 Embarcadero Center | $2,900,000 |

**Screens that render real data today** (`npm run dev`):

| Route | Who | State |
|---|---|---|
| `/app/leads` | contractor | works, shows both leads + "17 turned down" |
| `/app/leads/[id]` | contractor | score gauge, driver bars, evidence table, feedback bar |
| `/app/profile` | contractor | works |
| `/sample` | public | works, the QR/closing-ask target |
| `/` | owner | operations view, counters, kill switch |
| `/log` | owner | full decision log |
| `/dashboard` | owner | MRR, delivered vs archived, Terac before/after block |

---

## Priority 1: the interfaces

### The one real bug: FIXED

**The owner nav bled into every other surface.** The root `app/layout.tsx` rendered
"Operations / Decision log / Company" and wrapped every route, so the contractor's screens and
the two public screens all carried the owner's navigation.

By the time this was picked up the console header was already invisible on `/app/*`, hidden by
a `body:has(.lv-app)` rule in `contractor.css`. It was still in the markup, still announced to a
screen reader, and one unsupported selector from being visible. `/study/thanks` was not covered
by that rule at all, so a member of the public who answered a research question was shown the
owner's console navigation and a `<main>` nested inside another `<main>`.

What was done, in `app/`:

| Before | After |
|---|---|
| `app/layout.tsx` held the chrome | renders `<html><body>` and loads `globals.css`, nothing else |
| `app/page.tsx`, `log/`, `dashboard/`, `opportunities/` | moved into `app/(owner)/`, chrome now in `app/(owner)/layout.tsx` |
| `body:has(.lv-app)` hid `.site-header`, `.site-footer`, `.site-main` | those three rules deleted; only the body ground colour rule remains |
| `.study-thanks` had no styles and borrowed the console's | has its own rules at the end of `globals.css` |

`(owner)` is a route group, so **no URL changed**. `/log` is still `/log`.

Verified in the browser on all six screens: `.site-header` is absent from the DOM on
`/app/leads`, `/app/leads/[id]`, `/app/profile`, `/sample` and `/study/thanks`, and present with
its three nav links, its 1200px `.site-main` and its dark ground on `/`, `/log`, `/dashboard`
and `/opportunities/[id]`. Typecheck clean, 225 tests passing.

One thing this did **not** change, and it is a live product question: a delivered lead texts the
contractor a link to `/opportunities/<uuid>`, which is an owner console screen and now visibly
so. It works and it reads as the operator's view rather than the subscriber's. The subscriber's
own detail screen is `/app/leads/[id]`. Pointing the delivery link there is a one-line change in
`lib/agents/lead-agent.ts:1598` and was left alone as a product decision, not a bug.

### Known gaps, from a field-level audit of the prototype

The prototype in `prototype review/` was audited against the backend. Of roughly 90 data fields
it reads, **61 already work, 18 need a small named change, 9 cannot be honestly sourced.**

Cannot be sourced, do not try:

- **Project names.** "Arcadia Biosciences Lab Conversion" does not exist in permit data. Titles
  are composed from address + use + permit type, which is why they read "Museum alteration,
  735 Market St".
- **Square footage.** Only 3.8% of descriptions mention one.
- **Contact job titles.** DataSF gives `contractor`, `architect`, `engineer`. Not "Project Executive".
- **A phone number.** The contacts dataset has **no phone or email column at all**. Do not render
  a call button. "Who to call" is a name and a firm.
- **Per-account cost lines and retention** on the CEO dashboard would be assumptions dressed as
  measurements.

Worth doing, cheap:

- **Light theme.** The prototype converged on light (`#F4F8FC`, accent `#2878F0`) for both
  surfaces; v3 tried a dark console and v4 reverted it. The owner console is still dark. The
  contractor app already uses the light palette in `app/app/contractor.css`.
- ~~`149` is hardcoded in two places. Centralise it.~~ **Done, and it was worse than two.**
  The number was written six times: `envInt('SUBSCRIPTION_PRICE_USD', 149)` in `ceo-agent.ts`,
  `sales-agent.ts` and `ProfileRow.tsx`, a bare `const MONTHLY_PRICE_USD = 149` in both owner
  screens, and a bare `priceMonthlyUsd: 149` in `scripts/study.ts`.

  The bare three were not duplicates, they were **a different behaviour**: setting
  `SUBSCRIPTION_PRICE_USD` moved the price in every message the company sent while both revenue
  screens carried on reporting 149. The company could have billed one number and displayed
  another.

  All six now call `monthlyPriceUsd()` from `lib/config/deployment-env.ts`. The key is documented
  in `.env.example` and carried as a plain value in both `render.yaml` blocks, since the web
  service renders the price and the worker quotes it.

### The dead links

Two families, found by following the URLs the company actually sends. Both were live defects,
neither was in the previous handoff.

**1. Sales outreach: fixed.** Every message the Sales Agent composed ended in
`{APP_BASE_URL}/sample/<permitNumber>`. **That route does not exist.** There is one public sample
screen, at `/sample`, and no per-permit variant. Confirmed live: `/sample/202512292849` returns
404. Every prospect who tapped the one link the whole acquisition motion asks for got a dead
page, and those links are on screen in the dashboard's before-block.

Fixed by pointing `buildOutreachContext` at `/sample`, which is the cheap close rather than the
right one, and it forced a copy change. `/sample` shows the **highest scoring job on the board**,
not the job the message names, so two calls to action were asserting something false:

| Variant | Was | Now |
|---|---|---|
| A, evidence-led | `Here is the record:` | `Here is a live one:` |
| B, loss-led | `Proof:` | `See what we send:` |
| C, deal-led | `See it:` | unchanged, it was already true |

The bodies are untouched; they describe the job and that is still accurate. Under hard rule 3
this is not a stylistic edit. **The honest fix is still open**: either build
`/sample/[permitNumber]`, or take the permit as a query parameter and have `app/sample/page.tsx`
prefer it over the top scorer when it resolves. Both notes are in the code at the change sites.

**2. `/opportunities/<permitNumber>`: found, NOT fixed.** The opportunity route takes an
opportunity UUID. Three places pass a permit number instead, so the page renders an error that
leaks the raw Postgres text to whoever followed the link:

```
getOpportunity failed: invalid input syntax for type uuid: "202603238106"
```

- `scripts/study.ts` — `actionUrl` and `detailUrl`, the link inside the copy a study panel judges
- `scripts/recruit.ts:66` — `detailUrl`
- `lib/integrations/terac-recruit.ts:478` — `task_url`, the URL a Terac participant is sent to

All three are Terac-side, which is why they were left: Terac was explicitly out of scope for the
session that found them. **They are one-line fixes**, and the target should almost certainly be
`/sample`, matching the Sales fix. The contractor's delivered-lead link is **not** affected:
`lib/agents/lead-agent.ts:1598` correctly passes `opportunity.id`.

---

## Priority 2: Terac, the only unmet P0 rule

**Status: connected and proven, never launched.**

Verified live this session:

```
GET /organizations/current/context   200   org "dogsled", balance $125.00
GET /projects                        200   LeadVelocity project exists
GET /opportunities                   200   0 opportunities
```

`TERAC_PROJECT_ID` is pinned in `.env.local` to the existing LeadVelocity project.

### The numbers you need to decide

**Re-quoted live in the second session, and the price moved.** Per person is now **$6.40**, not
$6.99. Balance re-checked live and unchanged at **$125.00**. Nothing has been spent.

| Participants | Total | Per person | Note |
|---|---|---|---|
| 50 (current default) | $320.00 | $6.40 | over balance, cannot be paid for |
| **19** | **$121.60** | $6.40 | the most $125.00 covers |
| **15** | **$96.00** | $6.40 | the recommendation, now $8.85 cheaper than it was |

Earlier quotes, kept only to show which way it moved: 50 was $349.50 and 15 was $104.85, both at
$6.99 per person. **Re-quote before deciding.** `npm run study -- quote` is free and read-only.

`TERAC_TARGET_RESPONDENTS` is **still 50** in `.env.local`; it was deliberately not changed.
Setting it to 15 is required before `draft`, or the draft is sized at 50 and quotes $320. A
process-level override works for a one-off, and is how the numbers above were pulled:

```powershell
$env:TERAC_TARGET_RESPONDENTS = '15'; npm run study -- quote
```

Node's `--env-file` does not override a variable already present in the environment, which is
why that works. Add credit at `https://terac.com/dogsled-msunfu1a/settings/finance`.

### The scheduling trap

`timelineHours` has a **hard minimum of 72** (the API rejects anything lower with a 400). A
GenPop panel is a three-day minimum. **This means the study cannot start and finish inside a
single event day.** If the before-and-after has to appear in the video, launch the study
before anything else and film around it.

This was found the hard way; `.env.local` and `.env.example` are now set to 72.

### How to run it

```bash
npm run study -- quote                 # free
npm run study -- draft                 # free, records the three variants as "the before"
npm run study -- launch --max-usd=110  # SPENDS MONEY
npm run study -- results               # poll, picks the winner in code
```

`launch` refuses without an explicit ceiling and re-checks the live quoted cost against it. An
unknown cost is treated as over budget, never as free. `TERAC_STUDY_BUDGET_CENTS` is 0, so the
company will draft and quote on its own but never spend without you.

**A study has never been launched. No money has been spent.**

### Where it connects

- `lib/integrations/terac.ts` — verified against the v2 OpenAPI spec, not the web docs
- `lib/integrations/terac-recruit.ts` — the second, unused idea: recruit real SF C-10
  contractors as a panel, so the expert who answers the research question *is* the prospect.
  Feasibility is free and async (`npm run recruit -- feasibility`). Never run.
- Results render on `/dashboard` in the before-and-after block
- One draft study row already exists in `message_studies` (status `draft`, no `study_ref`)

**That stored row is stale, and it shows on camera.** Its three variants were composed by the
Sales Agent before the outreach link was fixed, so the copy rendered in the dashboard's
before-block still ends in `http://localhost:3000/sample/202512292849`, which 404s, and still
says "Here is the record:" and "Proof:". The code that generates variants is fixed; this row is
a snapshot taken before the fix.

Refreshing it means writing a new `message_studies` row. `createStudy(variants)` in
`lib/store/studies.ts` is a plain store insert with **no Terac call**, so this can be done
without spending or touching Terac; `npm run study -- draft` also does it but creates a Terac
draft opportunity on the way. It was left alone because Terac was out of scope for that session.
**Do this before recording if the dashboard's before-block is in frame.**

---

## Priority 3: the 2 minute video

Nothing needs deploying. `npm run dev` is enough to record.

Suggested beats, matching the pitch order (buyer first, autonomy last):

1. **0:00-0:40** Mike's problem. `/sample` on screen: one real $1.6M job, evidence labels visible.
2. **0:40-1:00** `/app/leads` — the contractor's inbox, two leads, "17 turned down". Then
   `/app/leads/[id]`: the score gauge, the five driver bars, the evidence table with its four
   labels, the recommended action. Land the ROI line here.
3. **1:00-1:40** "Now watch the company operate." `/log` — 6,876 real decisions with timestamps.
   Then the kill switch: pause, show the log freeze, unpause.
4. **1:40-2:00** `/dashboard` — the before-and-after from the Terac panel, if it has landed.
   Close on the audit log and the kill switch.

Two production notes:

- **Do not start `npm run workers` while recording.** The Sales Agent texts the demo phone on
  every tick. See the trap section below.
- To fill the log further, release more permits first:
  `npm run replay -- --skip-stage --speed=100000` then `npm run lead -- --no-send`.

---

## Traps that already cost time. Do not rediscover these.

### 1. `npm run workers` sends real texts on a timer

The Sales Agent has **no subscription gate** — sending a sample *is* its job, and it goes to
`DEMO_PHONE_NUMBER` every `SALES_TICK_SECONDS`. Over this session it sent **42 logical messages**
(~84 on Linq, since each send is a text plus a link card) to `+16503806311`.

Use `npm run lead -- --no-send` instead. It runs the fulfilment half only, and `--no-send`
unconfigures the channel for that process so `channelReady()` is false and nothing can send.
Verified working.

### 2. The kill switch does not stop a running process

Flipping `settings.kill_switch` stops agents at their *next tick check*, but the node process
survives. Worse: **stopping the background bash task does not kill the node child.** A worker
process survived a `TaskStop` and kept texting for 80 minutes.

To actually stop it:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'workers' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

### 3. Use PowerShell, not Bash, for long node runs

Git Bash hits `fork: Resource temporarily unavailable` once a dozen node processes exist, which
kills runs mid-flight. PowerShell does not.

### 4. `sslmode=require` breaks the Postgres connection

`pg` v8.16+ treats `sslmode=require` as `verify-full`, which fails against Supabase's pooler
cert. The connection string needs `?uselibpqcompat=true&sslmode=require`. Already fixed in
`.env.local`; do not "clean it up".

Also: the direct host `db.<ref>.supabase.co` is **IPv6 only** and unreachable. Use the session
pooler `aws-0-us-west-2.pooler.supabase.com:5432`.

### 5. Secrets belong in `.env.local`, never `.env.example`

`.env.example` is a committed template and is not gitignored. Credentials were pasted there
once. Nothing was committed (the repo still has no commits), but check before any `git add -A`.

### 6. Replay re-staging is slow and fails

`npm run replay` re-pushes 10,049 rows through PostgREST every run and has failed with
`fetch failed`. Use `--skip-stage` once the extract is staged.

---

## Commands that work

```bash
npm run dev                                   # the app
npm run lead -- --no-send                     # fulfilment only, cannot text
npm run replay -- --skip-stage --speed=100000 # release more permits
npm run study -- quote|draft|launch|results   # Terac
npm run recruit -- feasibility                # Terac contractor panel, free
npm run linq:sync                             # reconcile who has texted us
npm run db:migrate                            # idempotent, reports "skipped"
npm test                                      # 225 tests
```

Every `tsx` script loads `.env.local` automatically via `--env-file-if-exists`.

---

## Deliberate deviations from the kickoff, all recorded

1. **Linq replaced Twilio as the channel.** This reverses kickoff section 10 decision 2, which
   was marked RESOLVED. Twilio is not deleted; both sit behind `lib/delivery/channel.ts` and
   `DELIVERY_CHANNEL` picks. The fence's actual protection (the other one still works) is intact.
2. **Linq is inbound-first.** The sandbox only messages handles that texted first, so the Sales
   Agent queues and logs "waiting for first contact" rather than cold sending. Never "fix" this
   by flipping `LINQ_ALLOW_COLD_OUTBOUND`.
3. **Terac study uses first-choice selections, not ordinal ranks.** The API's screening
   mechanism does not produce ranks. Same intent, real numbers, no invented ranks.
4. **CSLB bulk list unobtainable.** The prospect pool comes from permit contacts instead, so
   classification is `unknown` rather than a verified C-10.
5. **Minimum job size is $25,000** (was $100,000). Raised shortlist yield from 714 to 1,073.
6. **The engine is trade-agnostic.** `lib/domain/trades.ts` holds seven trades; electrical is
   the configured one. A cross-over test proves scoring discriminates correctly between trades.
7. **A trade-fit gate was added.** An $8.29M office job scored 63 for a *roofing* subscriber on
   size alone despite having no roofing scope. Fit now collapses to zero when the scope was read
   and the trade is absent, capping such jobs at 70 so they can never be delivered.

---

## What is not built

- Stripe (no account configured; the subscription row was activated directly for the demo)
- Render deploy, and therefore the Linq inbound webhook, and therefore SMS-reply feedback
  (the UI feedback buttons at `/api/feedback` cover the loop without it)
- Google Places enrichment (explicitly optional in the kickoff)
- The map (Leaflet + OSM, ~45 min, coordinates already exist on 10,877 of 10,880 permits)
- Terac expert escalation (stretch)

---

## First moves in a fresh session

1. Read this file and `CLAUDE.md`.
2. `npm run dev`, open `/app/leads` and `/dashboard`, confirm both still render.
3. ~~Fix the owner-nav bleed into `/app/*`.~~ Done. See "The one real bug: FIXED".
4. Decide on Terac: `TERAC_TARGET_RESPONDENTS=15`, then quote, draft, launch. It is the last
   unmet P0 rule and it has a 72 hour floor, so it gates the timeline. **Re-quote first**, the
   price moved once already.
5. Refresh the stale `message_studies` row if the dashboard's before-block is in frame. It still
   renders the pre-fix copy with a 404 link. Free, no Terac call.
6. Record the video against the local app.

Do not start `npm run workers` unless you intend to send real messages.

## Two smaller things worth knowing

- **`npm run lint` does not work.** There is no ESLint config in the repo, so `next lint` drops
  into its interactive "How would you like to configure ESLint?" setup and hangs a
  non-interactive shell. It is not a regression and nothing depends on it. `npm run typecheck`
  and `npm test` are the real gates.
- **A production build was not run this session.** A dev server owned by another process held
  `.next`, and `next build` writing to the same directory would have disrupted it. Typecheck is
  clean and all ten screens render, but if you want the "compiles clean" line in the state table
  to stay true, stop every dev server and run `npm run build` once.
