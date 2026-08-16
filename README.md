# LeadVelocity

**From Permit to Pipeline.**

An autonomous subscription company for commercial contractors. It finds its own customers, bills them,
watches San Francisco permit activity, and delivers only the projects worth pursuing.

Built for the Zero-Human Company Hackathon (Terac), Humanmade, San Francisco, Aug 15 2026.

---

## What it does

A 15-person commercial electrical shop in San Francisco is great at the work and hears about projects late,
through referrals and luck. The signals are public and sitting in city permit records, but they are
fragmented and noisy.

LeadVelocity watches that activity and delivers only the projects worth pursuing: what it is, why it fits,
who to call, and why now. It runs with zero employees, which is why it costs 149 a month instead of a
business development hire.

## How it works

Four agents coordinating through shared state. No agent-to-agent chat, no org chart.

| Agent | Does |
|---|---|
| **Sales** | Pulls the contractor universe, qualifies, classifies, runs a real sample opportunity, sends it with a checkout link. If the prospect has not messaged us yet, the sample is queued and the wait is logged, not faked. |
| **Lead** | New permit -> deterministic filters -> interpretation -> enrichment -> evidence-labeled Findings -> deterministic score -> deliver above 80, archive below. |
| **Customer** | Maps inbound feedback to effective-profile weight changes that visibly move the next scoring pass. |
| **CEO** | Computes segment economics from real run data and makes one allocation decision, logged with the numbers. |

Two rules make the output trustworthy:

- **Deterministic code below, AI above.** Filters, dedupe, thresholds, scoring arithmetic, and billing state
  are code. Interpretation, research, contact-path reasoning, and drafting are the model's job. A model
  never produces a score.
- **Every stored fact carries an evidence label:** `verified`, `corroborated`, `inferred`, or `unknown`.
  Nothing is fabricated. Unknowns stay on screen.

Every agent decision appends to a log that cannot be updated or deleted (enforced by a database trigger).
One kill switch, checked at the start of every tick, halts the company.

### Delivery

Contractors are in the field, not in dashboards, so the sample lead, the checkout link, the delivered leads
and the feedback all live in one message thread. That thread runs on **Linq**, which reaches the phone over
**iMessage, RCS or SMS** through a single API and picks the best of the three for that handle.

Twilio is not gone. Both channels sit behind one seam, `lib/delivery/channel.ts`, and `DELIVERY_CHANNEL=linq|twilio`
chooses between them, so losing a channel is a config change and a restart rather than a rewrite.

One platform rule shapes the sales motion and is worth knowing before you read the log: **Linq's sandbox will
only message a handle that has texted the Linq number first.** So the Sales Agent cannot cold send a sample.
It composes the message, finds the handle unreachable, queues it, and logs "sample prepared, waiting for first
contact". When that handle texts in, the inbound webhook at `/api/linq/inbound` releases the queued message.
A queued message is shown as queued. It is never counted as delivered.

## Data

Real San Francisco records. No mock data in the demo path.

| Source | Use | Dataset |
|---|---|---|
| DataSF Building Permits | Trigger layer | Socrata `i98e-djp9` |
| DataSF Building Permits Contacts | Who is on the project | Socrata `3pee-9qhc`, joins on `permit_number` |
| CSLB | License verification | Public data portal |

A committed extract of **10,880 real permits and 22,148 contact rows** lives in `data/`, so the replay
harness and the tests run against real records even if the API is down. Replayed records are labeled as
replayed in the UI.

Field mappings were derived from live schema inspection, not assumption. See [docs/mappings.md](docs/mappings.md).

## Quick start

```bash
npm install
cp .env.example .env.local   # then fill it in, see docs/BLOCKERS.md
npm run db:migrate
npm run dev
```

Then, to make the company actually run:

```bash
npm run replay -- --speed=60
npm run workers
```

One prerequisite for a real send: on Linq's sandbox the recipient has to text the Linq number **before** the
company can message them. Text the number from the demo phone first, then set `DEMO_PHONE_NUMBER` to it.
Skip that and the run is still correct, it just queues instead of sending. See
[docs/BLOCKERS.md](docs/BLOCKERS.md) section 3.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Local app |
| `npm run typecheck` | `tsc --noEmit`, strict |
| `npm test` | Unit tests (vitest) |
| `npm run ingest` | One live ingestion pass from DataSF |
| `npm run replay` | Feed the committed real extract on an accelerated clock |
| `npm run workers` | Start the four agent tick loops |
| `npm run db:migrate` | Apply Supabase migrations (also Render preDeploy) |
| `npm run extract` | Re-pull the real extract into `data/` |

## Screens

| Path | What |
|---|---|
| `/` | The operating view: live decision log, counters, kill switch |
| `/opportunities/[id]` | The delivered opportunity: trigger record, Findings with evidence labels, score drivers, path in |
| `/log` | Full decision log, filterable by agent, including messages queued and waiting on first contact |
| `/dashboard` | CEO view: MRR, delivered vs archived, and the human-input before-and-after |

## Documentation

| Doc | What |
|---|---|
| [CLAUDE.md](CLAUDE.md) | Operating rules, conventions, command contract |
| [LEADVELOCITY_KICKOFF.md](LEADVELOCITY_KICKOFF.md) | Full build spec, scope, architecture rules |
| [SOP_BUILD_PRELIMINARY.md](SOP_BUILD_PRELIMINARY.md) | Build playbook, corrected against the real repo state |
| [docs/BLOCKERS.md](docs/BLOCKERS.md) | What still needs a human: accounts, keys, decisions |
| [docs/mappings.md](docs/mappings.md) | Verified field mappings and corrections to the spec's assumptions |
| [docs/hero-permits.md](docs/hero-permits.md) | The demo's anchor record and its trace through every gate |
| [kickoff/SOP_EVENT_DAY.md](kickoff/SOP_EVENT_DAY.md) | The human playbook for the day |
| [kickoff/diagrams/](kickoff/diagrams/) | Company loop and lead pipeline diagrams |

## Stack

| Layer | What |
|---|---|
| App | Next.js (App Router) + TypeScript strict + Zod |
| Persistence | Supabase (Postgres), append-only `events` enforced by trigger |
| Hosting | Render: web service, worker service, ingest cron |
| Billing | Stripe (test mode for the build, live account for the demo checkout) |
| Delivery | **Linq (iMessage, RCS or SMS)**, with Twilio SMS as the implemented fallback behind `lib/delivery/channel.ts` |
| Reasoning | Anthropic API, for interpretation and drafting only |
| Panel | Terac, for the GenPop message study |

## Reuse disclosure

This repo does not fork or copy [SiteVelocity](https://github.com/samshanmukh/SiteVelocity). It adopts that
project's architecture and merge-critical vocabulary (`SourceDescriptor`, `Finding`, `ScoreOutput`, snapshot
semantics) so the eventual consolidation is a lift-and-mount rather than a rewrite. Modules derived from
those patterns carry an origin note in their header. The product and agent logic were written for this event.
