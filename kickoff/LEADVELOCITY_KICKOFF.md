# LEADVELOCITY - Build Kickoff

**Zero-Human Company Hackathon (Terac) - Humanmade, 655 Bryant St, San Francisco - Aug 15, 2026**

This document is the executable build spec for the hackathon MVP. It supersedes the original handoff doc wherever the two conflict. The handoff doc remains the source of truth for pitch philosophy and long-term product vision; this doc is the source of truth for what gets built, in what order, with which data.

Companion file: `CLAUDE.md` (lean operating rules Claude Code reads every session).

---

## 0. Mission and definition of done

LeadVelocity is an autonomous subscription company for commercial contractors. It acquires customers with sample opportunities, collects recurring payment, monitors city permit activity, enriches and scores matching projects, delivers only high-quality leads, and learns from feedback. Tagline: **From Permit to Pipeline.**

The demo is done when a judge can watch, on real data, with no human operating the workflow:

1. The Sales Agent identify a real contractor prospect and send a sample opportunity.
2. The prospect subscribe via Stripe checkout and the account activate on webhook.
3. The Lead Agent process real SF permit records, shortlist, enrich, score, and deliver one opportunity that crosses the threshold.
4. Customer feedback change the customer's effective profile.
5. The decision log show every agent decision, timestamped and attributed.
6. A kill switch pause the entire company.

Everything else is supporting material.

---

## 1. Revisions from the original handoff (what changed and why)

| # | Change | Reason |
|---|--------|--------|
| 1 | **Autonomous sales sample promoted from P1 to P0** | The exec summary says the proof is the operating business loop. GET BUSINESS is what makes this a company instead of an automated product. The judging rubric is the loop closing. |
| 2 | **Enrichment narrowed to 3 sources max** (permit contacts join, CSLB, Google Places) | Pays for change #1. A shallower Lead Agent inside a closing loop beats a deep Lead Agent with no acquisition. |
| 3 | **Territory moved to San Francisco** (was San Jose) | DataSF publishes a Building Permits Contacts dataset that joins directly to permits with names and license numbers, updated weekly. That join is the enrichment step, pre-built. Judges are SF people. See section 4 for the San Jose fallback position. |
| 4 | **Fictional demo lead (Nova Diagnostics) replaced with a real hero permit** | A fictional canonical lead violates the handoff's own credibility guardrails. Real permit numbers on screen beat architecture slides. |
| 5 | **Replay harness added as P0** | "Zero leads on a weak day" is great product policy and a terrible demo. Replaying real records at accelerated time guarantees the hero permit fires on cue and satisfies the guardrail that the loop advances on events, not a scripted slideshow. Label it honestly on screen. |
| 6 | **Terac expert escalation added (P1)** | The evidence model already has "unknown" as a first-class status. When a high-value unknown blocks scoring, the agent hires a human expert for five minutes through the Terac MCP. Zero employees, humans on demand. Host's product, load-bearing. |
| 7 | **Delivery channel is SMS** (Twilio locked; Linq is a fenced post-cut-line stretch, see section 3) | Contractors are in the field, not in dashboards. Sample lead, checkout link, delivered leads, and feedback all live in one text thread. Web UI survives as the judge-facing detail view and CEO dashboard. |
| 8 | **Company starts at doors-open, not at demo time** | Accumulated state (MRR, opportunities delivered, decision log depth) is the proof of autonomy. Live beats on stage are increments on top of real history. |
| 9 | **SiteVelocity vocabulary adopted** (SourceDescriptor, Finding, ScoreOutput, snapshot semantics) | Makes the post-hackathon Build Velocity merge a lift-and-mount instead of a rewrite. Costs nothing since the files are being copied anyway. |
| 10 | **Event rules applied: Terac GenPop study is P0, Stripe individual account in live mode** | Rules require every project to use the Terac MCP to collect real human input during the event with a clear before and after, and require collecting payments through a Stripe individual account for Best Overall Agent-Run Company eligibility. |

---

## 2. Non-negotiable architecture rules

1. **Permit-first.** A city permit record starts every fulfillment workflow. LeadVelocity never roams the web inventing reasons a business might need a contractor. The permit creates the candidate; enrichment explains it.
2. **Deterministic code below, AI above.** Code handles filters, deduplication, geography, thresholds, scoring arithmetic, and billing state. AI handles interpretation of permit descriptions, targeted research, contact-path reasoning, and message drafting. An LLM never makes up an overall score.
3. **Evidence labels on every fact.** `verified | corroborated | inferred | unknown`. Unknowns stay explicit. Nothing is fabricated, ever, including in the demo. If a fact cannot be sourced, it is displayed as unknown.
4. **Four agents, no more.** CEO, Sales, Lead, Customer. Stripe is not a Billing Agent. Cron is not a Monitoring Agent. No agent titles for ordinary software.
5. **No mock data in the demo path.** Real SF permit records (live or replayed from a real extract, labeled as replay), real CSLB contractor records, real Stripe test-mode transactions. The only simulated element is the consenting demo phone playing the subscriber.
6. **Every agent decision is logged.** Append-only event log: timestamp, agent, decision, inputs summary, outcome. This log IS the demo.
7. **AI is the engine, not the pitch.** Every piece of customer-facing copy the system generates (outbound samples, SMS templates, landing page, opportunity summaries) sells the contractor's problem and the outcome. It never leads with AI, agents, or autonomy. Autonomy appears only as the reason the economics work.

---

## 3. Scope

### P0 (the demo fails without these)

| Capability | Definition of done |
|---|---|
| Customer profile | Create/update a contractor profile: trade, territory (geo), project preferences, minimum opportunity size. |
| SF permit ingestion | Pull DataSF building permit records via Socrata SODA; detect new/changed records using `data_as_of` / `data_loaded_at`; normalize with provenance. |
| Replay harness | Feed a pre-downloaded real extract on an accelerated clock; UI badge reads "real SF records, replayed"; hero permit guaranteed to fire. |
| Shortlist pipeline | Deterministic filters (geo, status, type, valuation, dedupe) then AI interpretation of permit descriptions to shortlist candidates relevant to the subscriber's trade. |
| Targeted enrichment | For shortlisted candidates only: join DataSF permit contacts (names, roles, license numbers), verify contractor identity via CSLB, optionally confirm the business via Google Places. Store as Findings with evidence labels. |
| Lead scoring | Deterministic weighted score: fit 30, demand 25, timing 20, value 15, evidence 10. Threshold 80. Output shape: `{score, drivers[{delta, reason}], warnings}`. Fatal flags never averaged away. |
| Lead delivery | SMS to the subscriber with the opportunity summary and a link; web detail page showing trigger record, evidence with labels, score drivers, best path in, recommended action. |
| Subscription state | Stripe test-mode Payment Link in the sample message; webhook flips the account to active; Lead Agent only fulfills active accounts. |
| Autonomous sales sample | Sales Agent pulls the CSLB C-10 universe for SF, qualifies deterministically, AI-classifies commercial vs residential from public web presence, selects one prospect, runs a limited sample of the Lead engine on that prospect's territory, sends the sample plus checkout link to the consenting demo phone. |
| Terac human-input study (event rule) | Sales Agent drafts 3 variants of the sample message; a General Population study launched via the Terac MCP ranks and rates them; code picks the winner; the Sales Agent ships it; the before and after (panel numbers plus the adopted copy) renders on the CEO dashboard and in the pitch. |
| Decision log + kill switch | Append-only agent decision feed rendered in the UI; one pause flag every worker checks. |

### P1 (build only after every P0 works end to end)

| Capability | Definition of done |
|---|---|
| Feedback learning | good / too-small / wrong-scope replies (SMS keywords or UI buttons) update the customer's effective profile and visibly change the next scoring pass. |
| CEO dashboard | MRR, customers, opportunities delivered, per-account contribution economics, and ONE autonomous decision rendered from real run data (e.g., shift acquisition toward the segment with better acceptance). |
| Linq delivery layer (stretch, fenced) | Additive second channel on top of a working Twilio path, never a swap. Hard 45-minute timebox, single commit, revert on expiry. Abandon rules in the note below this table. |
| Terac expert escalation (stretch) | The original escalation beat: when a scoring-blocking Finding is `unknown` and potential value is high, request expert judgment via the Terac MCP, upgrade the evidence label, rescore. Optional flavor on top of the required GenPop study, not the primary Terac integration. |

**Fenced-stretch rule (applies to Linq, and to anything added late):**

Precedent: on the Magpie build, an integration like this consumed far more time than budgeted. So the fence is structural, not a matter of discipline in the moment.

1. **Behind the cut line.** Not started until every P0 is checked and the loop has run live end to end, and not before the required Terac study has produced its before-and-after.
2. **Additive only.** Twilio stays wired and working. Linq is a second channel alongside it, never a replacement, so failure costs nothing.
3. **45 minutes, one commit, hard stop.** Set a visible timer at the start. If it is not sending on a working number when the timer ends, `git revert` the commit and walk away. No extensions, no "five more minutes," no debugging into the rehearsal block.
4. **Abandon immediately, no timer needed, if any of these appear:** access or API keys are not already in hand, onboarding requires a sales conversation or approval, docs are thin enough to require guessing, or it needs a number/short-code provisioned rather than one that already exists.
5. **Never in the demo path.** The pitch runs on Twilio. If Linq lands, it is a bonus sentence, not a beat anything depends on.

### Not building (hard list)

Carried from the handoff, plus repo-informed additions: no generic-SMB positioning, no BuildVelocity/SiteVelocity roadmap on stage, no second trade unless electrical is rock solid, no extra trigger sources (RFPs, HCAI, CEQA wait), no CRM, no mass outbound, no 15-agent org chart, no multi-tenant admin, no auth beyond the minimum for demo state, no Mapbox, no voice, no Mem0/Nexla/RocketRide/Rtrvr/MiniMax carryover, no long-term brand architecture.

---

## 4. Territory and data sources

**Primary territory: San Francisco.** Demo persona stays "Mike's Commercial Electric," territory SF (optionally SF + Peninsula in the profile).

| Source | Use | Endpoint / access |
|---|---|---|
| DataSF Building Permits | Trigger layer | Socrata dataset `i98e-djp9` at `data.sfgov.org` (SODA: `https://data.sfgov.org/resource/i98e-djp9.json`). A variant dataset `p4e4-a5a7` (permits filed on or after Jan 1, 2013) also exists; pick ONE after live schema inspection. Incremental changes via `data_as_of` / `data_loaded_at`. |
| DataSF Building Permits Contacts | Enrichment (who is on the project) | Socrata dataset `3pee-9qhc`; joins to permits on application/permit number; includes contact names, addresses, license numbers; DBI uploads weekly. |
| CSLB public data portal | Sales prospect universe AND license verification | List-by-classification tool at `www2.cslb.ca.gov/onlineservices/dataportal/ListByClassification` (filter C-10, San Francisco county). Master downloadable files exist on the ContractorList portal page if bulk is easier. Same source serves both sides of the company: one integration, two uses. |
| Google Places | Optional business confirmation | Only for the hero flow; keep last; skip if time is short. |

**Rules for all sources:** copy the SiteVelocity registry discipline. Every registry entry preserves agency, dataset identity, and exact endpoint so raw records carry provenance. Field mappings are declared only after live schema inspection. Never assume field names.

**Fallback position:** the real risk is live-API flake, not geography. Tonight, export a static extract of the SF permits and contacts datasets to CSV/JSON. The replay harness runs from that extract regardless, so the demo survives a dead API. San Jose remains available as a territory override (SiteVelocity's SCC/San Jose registry entries exist), but switching geographies mid-day is a bigger risk than any SF data problem. Decision owner: Chris. Default if undecided: SF.

**Cold-outreach compliance note:** in the demo, the sample goes to a consenting demo phone. In real operation, cold outreach goes by email (CAN-SPAM with opt-out); SMS only after the prospect opts in by subscribing. Do not build mass outbound.

---

## 5. Reuse map (SiteVelocity -> LeadVelocity)

Fresh repo. Do not fork SiteVelocity. Copy the files below, keep their doc-comment provenance headers, and add a one-line header noting origin. Disclose reuse per event rules (confirm the pre-existing-code policy at check-in, same habit as the July event).

**Source repo: https://github.com/samshanmukh/SiteVelocity (public).** If a listed file is missing from the copy, or a pattern needs more context, read it from the source repo rather than reinventing it. The copied files are the quality bar: new modules must match their structure, rigor, and doc-comment style.

**Copy:**
- `lib/adapters/sources/{source-record,http-json,socrata,arcgis,registry}.ts` - keep the adapter interfaces; replace registry entries with the DataSF and CSLB sources above.
- `lib/domain/schemas/core.ts` (Finding and friends) and `lib/research/snapshot-diff.ts` - the evidence model and new/changed detection.
- `lib/calculations/registry.ts` plus the pattern from `lib/calculations/scoring/alpha-scores.ts` - write `lead-score.ts` with the five components in the same ScoreOutput shape.
- `lib/domain/candidate-normalizer.ts` pattern - becomes `permit-normalizer.ts`.
- `render.yaml` shape (one web service, one ingestion cron, health probes, `preDeployCommand: npm run db:migrate`, secrets presence-only) and the `lib/config/deployment-env.ts` approach.
- Supabase migration/store patterns, simplified to a single workspace. Drop tenant-aware complexity.

**Leave behind:** auth gate, Mapbox/maplibre/turf, feasibility studio, voice routes, administration screens, watchlists, Nexla/RocketRide/Rtrvr/MiniMax/Mem0 provider wiring, PDD tooling.

**Stack (locked):** Next.js + TypeScript + Zod, Supabase (Postgres) for persistence, Render for web + cron workers, Stripe test mode, Twilio SMS (locked for the whole build; Linq is an additive stretch behind the cut line, never a swap), Anthropic API for agent reasoning, Terac MCP for expert escalation.

---

## 6. System design (concise)

**Core tables/entities:** `prospects` (from CSLB), `customers` (profile: trade, territory geometry or radius, preferences, min value, status), `permit_records` (raw + normalized + provenance + content hash for change detection), `candidates`, `findings` (evidence-labeled facts keyed to candidate), `opportunities` (score, drivers, warnings, status: delivered/archived), `subscriptions` (Stripe state), `events` (append-only decision log: ts, agent, decision, summary, refs), `settings` (kill switch flag).

**Agent runtime:** each agent is a worker loop (cron or queue tick) with narrow tools and a system prompt. Sequence per tick: check kill switch, pull work, decide, act, log. No agent-to-agent chat; agents coordinate through state.

- **Lead Agent tick:** new/changed permits -> deterministic filters -> AI shortlist -> enrichment (contacts join, CSLB, Places) -> Findings -> deterministic score -> deliver if >= 80 else archive. Log every gate.
- **Sales Agent tick:** if prospect pool empty, pull CSLB C-10 SF -> deterministic qualify (active license, geo) -> AI commercial/residential classification -> rank -> for top prospect run limited Lead-engine sample -> compose message -> send SMS with sample + Stripe Payment Link. Log selection reasoning.
- **Customer Agent:** on inbound SMS/webhook feedback, map to good/too-small/wrong-scope, adjust effective profile weights, log the change.
- **CEO Agent:** on schedule, compute segment economics from `events` + `subscriptions`, make one allocation decision (which segment Sales targets next), log it with the numbers that drove it.

**Terac human-input study (P0, event rule):** Sales Agent drafts 3 message variants -> company launches a General Population study through the Terac MCP (respondents imagine owning a small commercial electrical shop, rank the three texts, rate trust and clarity 1-5) -> deterministic winner selection in code (highest mean rank, trust score breaks ties) -> Sales Agent adopts the winner for live outreach -> decision logged with the numbers -> before and after rendered on the CEO dashboard. Launch the study as early in the day as possible; panel results take time.

**Terac expert escalation (stretch):** scoring finds a blocking `unknown` with potential value above a threshold -> request expert judgment via the MCP -> on answer, write Finding as `verified` or `corroborated` with the expert response as evidence -> rescore -> deliver if it now clears.

**Replay harness:** loader ingests tonight's real extract into a staging table with original timestamps; a clock multiplier releases records into `permit_records` during the demo; badge in the UI. Hero permit is chosen tonight (2-3 backups) and verified to clear every deterministic gate.

**Kill switch:** one row in `settings`; every worker checks it at tick start; UI button flips it; the decision log shows the halt.

---

## 7. Build order and checkpoints

**Tonight (pre-event):**
1. Scaffold repo from the reuse map; deploy the skeleton to Render; health probes green.
2. Export SF permits + contacts extracts; live-inspect schemas; write registry entries and field mappings.
3. Select hero permit candidates (2-3 real, recent, clearly electrical-relevant SF projects).
4. Pull CSLB C-10 SF list; stash as the prospect seed.
5. Stripe test account + Payment Link + webhook endpoint stub. Twilio number provisioned (Twilio is the channel regardless of Linq). Terac MCP auth verified.
6. Draft all four agent prompts and the SMS templates.
7. Confirm event rules on pre-existing scaffolds at check-in tomorrow.

**Day-of order (each step ends with the loop still demoable):**
1. Customer profile + opportunity detail screen.
2. Ingestion live + replay harness feeding real records.
3. Shortlist (filters, then AI interpretation).
4. Enrichment: contacts join + CSLB verify. Findings with labels.
5. Scoring + evidence display + threshold gate.
6. Delivery SMS + Stripe webhook -> active account.
7. Sales sample motion end to end to the demo phone.
8. Decision log UI + kill switch.
9. Feedback learning (P1).
10. CEO dashboard + one autonomous decision (P1).
11. Terac escalation beat (P1).

**Cut line:** if steps 1-8 are not solid by mid-afternoon, P1 items are dropped without discussion. A shallow closed loop beats a deep open one.

**Demo-state targets by presentation time:** company running since doors-open, at least 1 active subscriber, several opportunities processed with at least 1 delivered and several archived (archives prove selectivity), decision log with dozens of entries, one Terac escalation completed or staged.

---

## 8. Pitch anchor

The 30-second version (verbatim, the north star for every screen):

> LeadVelocity tells commercial contractors where the work is forming, before it's awarded. Picture a 15-person electrical shop in San Francisco. Great at the work, but they hear about projects late, through referrals and luck. The signals are public, sitting in city permit and planning records, but they're fragmented and noisy. LeadVelocity watches that activity and delivers only the projects worth pursuing: what it is, why it fits, who to call, and why now. And it runs with zero employees, which is why it costs 149 a month instead of a business development hire. From permit to pipeline.

The governing principle, verbatim from the handoff and binding on every piece of copy this company emits:

> "The best AI pitches barely sell the AI. They sell the problem. The Buyer. The painful workaround. The reason this company needs to exist. AI is the engine, not the pitch."

Required order, always: Buyer -> Problem -> Painful workaround -> Why this company must exist -> Product outcome -> autonomy revealed last, as the economic reason the service can exist at SMB pricing.

Demo-day calibration: the order is sacred, the timing is compressed. Roughly 45-60 seconds of Mike and the painful workaround, then "now watch the company operate" for the remainder. If a judge hears about agents, models, or orchestration before they understand Mike's pipeline problem, the pitch is out of order.

**Closing beats** (added after pressure-testing against a standard demo-deck template):

1. **The ROI line**, delivered right after the opportunity card is shown: Mike pays 1,788 dollars a year. The projects on his screen are 100K to 300K jobs. One win pays for the service for decades.
2. **The enumerated-market line**, for the how-big-is-this question: the market is not estimated, it is enumerated. Every licensed contractor in California sits in one public database, the same one the company already prospects from.
3. **The ask, final screen:** a live entry point (QR to the public sample page, or the SMS number once inbound handling is wired). Spoken line: "The company is live right now. If you know a commercial contractor in San Francisco, point them here and it will find them a project." Never show an entry point that dead-ends.

---

## 9. Environment and secrets

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (test AND live: build in test mode, the demo checkout runs live per the eligibility rule), `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER`, `ANTHROPIC_API_KEY`, `TERAC_*` (required, event rule; per their MCP docs), `SODA_APP_TOKEN` (optional, raises DataSF rate limits), `APP_BASE_URL`, `DEMO_PHONE_NUMBER`, `REPLAY_SPEED_MULTIPLIER`, `KILL_SWITCH_DEFAULT=off`.

Never committed. Presence-only in `render.yaml` (`sync: false`), same as the SiteVelocity deployment pattern. `.env.example` only.

---

## 10. Open decisions (owner: Chris)

1. SF confirmed as territory, or override to San Jose (this doc assumes SF; see section 4).
2. RESOLVED: Twilio is the delivery channel for the build. Linq is an additive stretch behind the cut line under the 45-minute rule in section 3, never a replacement.
3. RESOLVED by event rules: payments collect through a Stripe individual account in live mode (Best Overall Agent-Run Company eligibility). Build and test in test mode; the demo checkout runs live; refund after if needed.
4. Repo name and where it lives (recommend: a Build Velocity org, even if empty otherwise, so the IP consolidation starts now).
5. Who plays the subscriber phone during the demo.
