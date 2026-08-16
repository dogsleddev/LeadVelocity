# SOP: Build Execution (CORRECTED)

**LeadVelocity - corrected against the real repo state on event day, Aug 15 2026**

Status: **CORRECTED.** The preliminary version of this document (kept at
`kickoff/SOP_BUILD_PRELIMINARY.md` as the pre-inspection artifact) was written before anyone had opened
the repo. Its step 0 instructed Claude Code to inventory reality and rewrite it. This is that rewrite.

Source of truth for scope and rules is unchanged: `LEADVELOCITY_KICKOFF.md` and `CLAUDE.md`.

---

## Step 0 findings: what was actually here

**The repo was empty.** It contained `kickoff/` and nothing else. No scaffold, no `package.json`, no
SiteVelocity files, no `/data`, no git repository.

Which means the entire "Tonight (pre-event)" list in kickoff section 7 was outstanding at the start of the
day. The preliminary SOP's assumptions were wrong in a specific and important way: it assumed a partially
built repo to reconcile against, and there was nothing to reconcile.

| Preliminary SOP assumed | Reality |
|---|---|
| Scaffold partially done, reconcile step 1 against it | Nothing existed. Built from scratch today. |
| SiteVelocity files copied per the reuse map | Not copied. Fresh modules written to the documented patterns, vocabulary adopted, origin notes in headers. |
| `mappings.md` may be a stub, flag as P0 blocker | Absent entirely. **Now generated from live schema inspection.** No longer a blocker. |
| `hero-permits.md` may be a stub | Absent entirely. **Now generated, hero verified against the real extract.** |
| `/data` extracts may be missing | Absent. **Now real: 10,880 permits, 22,148 contacts.** |
| `cslb-c10-sf.csv` carried over from sandbox | Absent and **not obtainable non-interactively.** See the deviation below. |
| Run typecheck/test for a baseline | Nothing to run. Baseline established today. |

**Corrections to the kickoff's data assumptions**, from live inspection (full detail in `docs/mappings.md`):

- Contacts **do** carry license numbers (`license1` 63.5%, `sf_business_license_number` 40.8%). The
  kickoff's assumption held; it is now measured rather than assumed.
- Every SODA value arrives as a **string**. Costs and dates need explicit coercion.
- `revised_cost` is 96% populated and is sometimes `"0.0"` on freshly filed permits, so project valuation
  must be `max(revised_cost, estimated_cost)`.
- `issued_date` 82.2%, `approved_date` 76.4%, `completed_date` 30.0% populated. Absence is `unknown`.
- Dataset choice resolved: **`i98e-djp9`**, not the `p4e4-a5a7` variant. 53 columns vs 51, and it carries
  `approved_date`, which the timing component of the score uses. The kickoff required picking one after
  live inspection; this is that decision.
- The permits dataset has no electrical-permit type. That is fine and actually better for the thesis: a
  commercial building permit means electrical work is *forming*, before the sub is hired.

---

## Step 1: Foundations: DONE

- [x] `render.yaml` (web + worker + ingest cron, every secret `sync: false`, health probe, preDeploy migration)
- [x] Supabase migration `supabase/migrations/0001_init.sql` covering all nine kickoff tables plus
      `replay_staging`, `stripe_events` (webhook idempotency), and `message_studies` (the Terac before/after)
- [x] `lib/config/deployment-env.ts`: capability-gated, never throws at import, presence-only reporting
- [x] Health probes at `/api/health/live` and `/api/health/ready`
- [x] TypeScript strict with `noUncheckedIndexedAccess`, Zod at every boundary, no `any`
- [ ] **`npm run db:migrate` against a real Supabase project**: blocked on credentials, see `docs/BLOCKERS.md` section 1

Note on the reuse map: the SiteVelocity repo was not cloned. Interfaces were written to the documented
patterns and the merge-critical vocabulary was adopted exactly. If merge fidelity matters, diff against
the source repo.

---

## Step 2: Ingestion + registry: DONE (code), BLOCKED (live run)

- [x] DataSF permits registry entry using verified field names
- [x] DataSF contacts registry entry, join key `permit_number` confirmed at **99.6% coverage**
- [x] Snapshot change detection on `data_as_of` / `data_loaded_at` with content hashing
- [x] Replay harness: `npm run replay`, original timestamps, `REPLAY_SPEED_MULTIPLIER`,
      provenance marked `replayed:true`, `--until-hero` flag to fire the hero on cue in rehearsal
- [x] Hero permit verified present in the extract and traced through every gate
- [ ] Live ingestion run: blocked on Supabase

---

## Step 3: Shortlist pipeline: DONE

- [x] Pure deterministic filters (geography, status, project type, commercial use, cost floor, dedupe),
      unit tested against the real extract
- [x] Narrow AI interpretation step against the subscriber's trade
- [x] **Hero permit clears every deterministic gate.** Asserted in a test, not assumed.

---

## Step 4: Enrichment + Findings: DONE (code), PARTIAL (CSLB)

- [x] Permit contacts join
- [x] Findings with evidence labels; absent facts are `value: null` + `unknown`, never guessed
- [~] CSLB license verification: per-license lookup implemented and fails to `unknown` rather than guessing.
      Bulk classification list not obtainable, see the deviation below.
- [ ] Google Places: explicitly optional, not built. Correct call; steps 1-8 come first.

---

## Step 5: Scoring: DONE

- [x] Pure `lib/calculations/scoring/lead-score.ts`, no LLM import anywhere in the module
- [x] fit 30, demand 25, timing 20, value 15, evidence 10
- [x] `LEAD_SCORE_THRESHOLD = 80` as a named, findable constant
- [x] Fatal flags returned separately, never averaged into the score
- [x] Unit tests: hero scores at or above threshold, a real weak candidate scores below

---

## Step 6: Delivery + subscription state: DONE (code), BLOCKED (accounts)

**The channel is Linq, not Twilio.** Linq delivers over iMessage, RCS or SMS through one API. Twilio is not
deleted: it stays implemented as the fallback. Both sit behind one seam.

- [x] Stripe webhook with signature verification on the raw body, idempotent via `stripe_events`
- [x] Lead Agent only fulfills accounts with an active subscription
- [x] `lib/delivery/channel.ts`, the seam. `DELIVERY_CHANNEL=linq|twilio`, default `linq`. Agents and routes
      call the seam, never an integration module, so the fallback stays a config flip
- [x] `lib/integrations/linq.ts`, written against the `@linqapp/sdk` v0.39.1 type declarations rather than
      the published web reference, which disagrees with the SDK on the text part shape and on the auth header
- [x] Delivery above threshold, with a hard guard that **throws** on AI/agent/autonomous language or em
      dashes rather than sending it (rule 9 enforced in code, not by discipline). The guard runs inside each
      integration before its capability check, so banned copy throws on a machine with no credentials too
- [x] `lib/integrations/twilio.ts` unchanged behind the seam as the fallback
- [x] Migration `0002_linq_channel.sql`: `inbound_contacts` (who may be messaged) and `outbound_queue`
      (composed, not yet permitted to send)
- [x] Web opportunity detail page: trigger record, Findings with evidence badges, score drivers, path in
- [ ] Live Stripe individual account, Linq sandbox key and number, webhook subscription pointed at
      `/api/linq/inbound`. `docs/BLOCKERS.md` sections 2 and 3

---

## Step 7: Sales motion + Terac study: DONE (code), BLOCKED (key)

- [x] Prospect pool loader, deterministic qualification, AI commercial/residential classification (`inferred`)
- [x] Limited sample pass of the lead engine over the prospect's territory
- [x] Three genuinely distinct message variants, copy-safety tested
- [x] **Terac integration written against the verified OpenAPI v2 contract** (this was an open risk this
      morning and is now closed). Study is an opportunity with `unrestricted_audience: true`, questions
      carried as non-disqualifying screening questions, results read from `screening_stats`.
- [x] Deterministic winner selection in code, never a model call
- [x] **Inbound-first handling in the Sales motion.** See below. Composed samples that cannot legally be sent
      are queued, not dropped and not faked
- [ ] Launch a real study: needs `TERAC_API_KEY`, and launching **spends money**, so it is gated behind an
      explicit budget ceiling. `docs/BLOCKERS.md` section 4.

### The consequence of Linq: the Sales Agent cannot cold send

Linq's hackathon sandbox states it plainly: your agent can only message people who have texted your Linq
number first. That is a platform rule, not a preference, and it lands squarely on the acquisition motion,
which was designed around sending a prospect an unsolicited real sample lead.

The behaviour, deterministic and gated up front rather than discovered from a 403:

1. Sales composes the sample message as before. Composing is never blocked.
2. `requiresInboundFirst()` and the `inbound_contacts` table answer "may we message this handle" before the
   send is attempted.
3. Unreachable handle: the message goes to `outbound_queue` and the decision log records
   "sample prepared, waiting for first contact". That is a logged decision under rule 6, with the handle and
   the reason.
4. When that handle texts in, the inbound webhook at `/api/linq/inbound` verifies the Standard Webhooks
   signature, records the contact, and releases the queued message.

Three things this is not. It is not a failure state, it is the consent model the kickoff's own cold-outreach
note asked for (SMS only after opt-in). It is not hidden, both states are on the log. And a queued message is
never reported as sent, per rule 3.

What it costs, plainly: the unattended demo cannot show a cold prospect being acquired end to end from a
standing start. Somebody has to text the number first. That is why `docs/BLOCKERS.md` section 3 says to have
the demo phone text the Linq number **before** the demo, so the thread exists when the slot starts.

**Deviation, recorded:** the kickoff asks the panel to rank the three texts and rate trust and clarity 1-5.
Terac's mechanism yields forced first-choice selections, not ordinal ranks, so the study asks three
first-choice questions (most trusted, clearest, most likely to get a reply) and the winner is combined
selections with trust breaking ties. Same intent, real numbers, no invented ranks.

---

## Step 8: Decision log + kill switch: DONE

- [x] Append-only `events` table, **enforced by a database trigger** that raises on update or delete
- [x] Every agent tick writes at least one entry, including "considered nothing, here is why"
- [x] UI feed, newest first, color-coded by agent
- [x] `settings.kill_switch`, checked at the start of every tick, with a UI pause/unpause control

---

## CUT LINE

Everything above is P0. **Do not start below until the loop has run live, end to end, at least once.**

Right now the loop cannot run live because it has no database, no payment account, no delivery number, and
no Terac key. **Clearing `docs/BLOCKERS.md` is the highest-value work remaining, ahead of any new code.**
Order: Supabase, then Linq (key, number, webhook subscription, and text the number from the demo phone so a
thread exists), then Terac (launch the study early, results take time), then Stripe, then deploy to Render so
the company accumulates decision-log depth before your slot.

---

## Step 9-11: P1: NOT STARTED, correctly

- Feedback learning: the Customer Agent and the inbound webhook routes are written, so the wiring exists.
  Confirming a feedback reply visibly moves the next scoring pass needs a live loop first.
- CEO dashboard: `/dashboard` is built and reads real rows. The "one autonomous decision" comes from the
  CEO Agent's real run data, not a canned example.
- Terac expert escalation: not built. Correctly demoted to stretch; the GenPop study is the required beat.

## Step 12: Linq: NO LONGER A STRETCH, it is step 6

The preliminary plan had Linq here, behind the cut line and the 45-minute fence, to be abandoned on sight.
That is not what happened. Linq is now the delivery channel and step 6 is where it lives. The reasoning and
the tradeoff are in the channel decision entry below. This heading stays so the change is not silent.

---

## What is genuinely different from the preliminary plan

1. **The P0 data blocker cleared itself.** The SOP said to flag missing mappings and extracts back to Chris.
   Both DataSF datasets were live, so real artifacts were generated instead. This was the single biggest
   unblock of the morning.
2. **The Terac contract went from guessed to verified** mid-build, once the docs arrived. The integration
   was rewritten against the real OpenAPI spec.
3. **CSLB went the other way.** See below. This is the one place the build is genuinely thinner than spec.
4. **Spending money is gated.** Fielding a panel is a real purchase, so it cannot happen as a side effect
   of a worker tick. It needs an explicit ceiling.
5. **Order of the remaining day is inverted from the plan.** The plan assumed code was the bottleneck. It
   is not: credentials are. Clear blockers, then harden.
6. **THE CHANNEL CHANGED: Linq replaces Twilio as the delivery channel.** This one reverses a resolved
   decision. Read the entry below before changing anything about delivery.

---

## CHANNEL DECISION: Linq replaces Twilio, and this reverses kickoff section 10 decision 2

**What the kickoff decided.** Section 10 decision 2 reads: "RESOLVED: Twilio is the delivery channel for the
build. Linq is an additive stretch behind the cut line under the 45-minute rule in section 3, never a
replacement." Section 3's fenced-stretch rule says the same thing from the other side: additive only, Twilio
stays wired, and **never in the demo path**. Section 7 locks the stack line to Twilio SMS.

**What is true now.** Linq is the delivery channel and the demo path. It sends over iMessage, RCS or SMS
through one API. `DELIVERY_CHANNEL` defaults to `linq`.

**Why.** The product is a message thread with a contractor: sample lead, checkout link, delivered leads,
feedback, all in one place. Linq reaches that thread as iMessage where the handle supports it and degrades to
RCS or SMS where it does not, from a single call, which is a materially better version of the same beat than
SMS alone. Both integrations are small and the seam between them is smaller.

**What the fence was actually protecting, and how that protection survives.** The fence existed so a late
messaging swap could not become a single point of failure on demo day. That protection is preserved, but
differently: Twilio is not deleted. It stays fully implemented behind `lib/delivery/channel.ts`, and switching
back is `DELIVERY_CHANNEL=twilio` plus a restart, with no code change and no redeploy of anything but an env
var. The fallback exists and is exercised by the same call sites.

**What was traded away, stated plainly.**

- Linq **is** in the demo path now, which the fence explicitly forbade. If Linq is down at the venue, the
  demo needs a config flip and a restart under time pressure. That is a much smaller failure than a rewrite,
  but it is not zero, and the fence's answer was to have no such moment at all.
- The Twilio path is now the less rehearsed one. It compiles and it is wired, but the hours of live decision
  log will accumulate on Linq. Keep the Twilio credentials populated in Render, or the flip fails at exactly
  the wrong moment.
- Linq's sandbox imposes inbound-first, which Twilio does not, and that **changed the sales motion** rather
  than just the transport. Cold sending a sample is no longer possible; the Sales Agent queues. See step 7.
  This is the real cost of the swap, and it is a product change, not a plumbing change.
- Three sandbox limits now sit on the demo: inbound-first, 100 unique contacts, and the number expires after
  7 days. None of these applied to Twilio.

**This was deliberate.** It was not a drift, and it was not somebody being tempted by a shinier API mid-build.
A future session reading section 10 decision 2 will find it contradicted by the code; this entry is the
record of why, and of what it cost. If the tradeoff no longer looks worth it, the reversal is one env var.

---

## The one real deviation: the CSLB prospect pool

The kickoff calls for `cslb-c10-sf.csv`, the C-10 list for San Francisco county. The CSLB portal's download
is an ASP.NET WebForms page behind a `__VIEWSTATE` postback and the documented bulk zip 404s. Chasing it is
exactly the open-ended integration the fenced-stretch rule exists to prevent.

Substituted: the prospect pool is seeded from the real permit contacts already on disk, roughly 14,000
licensed contractors **demonstrably active in San Francisco**, deduplicated by license. Arguably a better
acquisition list than a raw classification dump.

The cost, stated plainly: that dataset carries no CSLB classification, so C-10 cannot be filtered
deterministically and is **not invented**. Classification stays `null`, and the commercial/residential
judgement is labeled `inferred`, never `verified`. Dropping a real `data/cslb-c10-sf.csv` in place upgrades
every prospect; the loader already prefers that file. Fifteen minutes of browser work for a spare human.

---

## Rules that still apply at every step

From `CLAUDE.md`, and all ten are now enforced somewhere in code rather than by memory:
permit-first, deterministic below and AI above, evidence labels on every fact, exactly four agents, no mock
data in the demo path, every decision logged, kill switch at tick start, never assume external field names,
AI is the engine and not the pitch, and inbound first.

Rule 10, inbound first, is new with the channel change. It says the Sales Agent queues rather than cold sends
on Linq, and that a queued message is never reported as sent. It reads like an inconvenience and it is the
honest behaviour. Do not remove the queue to make the demo look smoother.
