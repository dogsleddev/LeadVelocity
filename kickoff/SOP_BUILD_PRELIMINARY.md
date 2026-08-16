# SOP: Build Execution (Preliminary)

**LeadVelocity - for Claude Code, once it has the repo open**

Status: PRELIMINARY. This is the build-order playbook before Claude Code has actually inspected the scaffold, the copied SiteVelocity files, or last night's extracts. Treat every step below as a hypothesis to confirm, not a fact. The moment Claude Code opens the repo, step 0 is to verify or correct this document, then proceed.

Source of truth for scope and rules: `LEADVELOCITY_KICKOFF.md` (P0/P1, architecture rules, reuse map) and `CLAUDE.md` (hard rules, conventions, commands). This SOP sequences the work; it does not override either.

**EVENT RULES UPDATE (applies across this SOP):** every project must use the Terac MCP to collect real human input during the event and show a clear before and after. The Terac General Population study is therefore P0 and lives inside Step 7. Payments must collect through a Stripe individual account in live mode for Best Overall eligibility, which changes Step 6. Step 11's expert escalation is demoted to stretch.

---

## Step 0: Orient before building anything

Do this first, every session, and re-verify if the repo has changed since last checked.

1. Read `CLAUDE.md` and `LEADVELOCITY_KICKOFF.md` in full if not already in context.
2. Inventory what actually exists: run the repo's directory listing, check which files from the SiteVelocity reuse map (kickoff section 5) actually made it in, and in what state, complete, stubbed, or still todo.
3. Check `mappings.md` and `hero-permits.md` from the sandbox handoff: are they filled in, or still stubs? If still stubs, that is now a P0 blocker, flag it back to Chris before writing ingestion code against guessed field names.
4. Check `/data` for the real extracts. If missing, ingestion and the replay harness have nothing to run against, flag it.
5. Run `npm run typecheck` and `npm test` on whatever exists to establish a real baseline, not an assumed one.
6. **Update this SOP's step list below to match reality** before proceeding: mark anything already done, correct anything that assumed a file exists but doesn't, and note anything the scaffold did differently than the kickoff doc described.

**Exit criteria:** a corrected, accurate picture of what's built, what's stubbed, and what's missing, replacing the assumptions in this document.

---

## Step 1: Foundations (assumed status: partially done via scaffold)

- [ ] Confirm `render.yaml`, Supabase migration, and `deployment-env.ts` pattern are in place and match kickoff section 6's table list (customers, permit_records, candidates, findings, opportunities, subscriptions, events, settings).
- [ ] Confirm `npm run db:migrate` runs clean against a real Supabase project (env keys present).
- [ ] Confirm health probe route responds.
- [ ] Confirm the copied adapter/registry files (`lib/adapters/sources/*`) compile and their interfaces are untouched, only new registry entries added.

**If any of this is missing:** build it first. Nothing downstream works without it.

---

## Step 2: Ingestion + registry entries (P0)

- [ ] Write the DataSF permits registry entry using verified field names from `mappings.md`, not guessed ones.
- [ ] Write the DataSF contacts registry entry, confirm the join key against `mappings.md`.
- [ ] Wire `snapshot-diff.ts`-pattern change detection using `data_as_of` / `data_loaded_at`.
- [ ] Build the replay harness: load `/data/permits.json` + `/data/contacts.json` into a staging table with original timestamps, release on `REPLAY_SPEED_MULTIPLIER`, UI badge "real SF records, replayed."
- [ ] Verify the hero permit(s) from `hero-permits.md` actually appear in the extract and pass a manual trace through the filter logic once step 3 exists.

**Exit criteria:** running the ingestion job populates `permit_records` with real rows, provenance intact.

---

## Step 3: Shortlist pipeline (P0)

- [ ] Deterministic filters: geography, status, project type, cost floor, dedupe. Pure function, unit tested.
- [ ] AI shortlist step: interpret permit descriptions against the subscriber's trade. Keep this a narrow, single-purpose call, not a general-purpose agent yet.
- [ ] Confirm the hero permit clears every deterministic gate here. If it doesn't, that's a data problem to fix now, not a scoring problem to paper over later.

**Exit criteria:** feeding the replayed extract through steps 2-3 produces a non-trivial, non-empty shortlist including the hero permit.

---

## Step 4: Enrichment + Findings (P0)

- [ ] Permit contacts join (already fetched in step 2, apply here).
- [ ] CSLB license verification call, using `cslb-c10-sf.csv` if a live call isn't warranted for a given candidate.
- [ ] Findings written with evidence labels (verified / corroborated / inferred / unknown), following the `Finding` schema from SiteVelocity.
- [ ] Google Places confirmation: build only if steps 1-4 are otherwise solid and time remains. Explicitly optional per kickoff section 3.

**Exit criteria:** the hero candidate has a populated Findings table with at least one entry per evidence label type, for a realistic demo.

---

## Step 5: Scoring (P0)

- [ ] Pure `lead-score.ts` module, same `ScoreOutput` shape as SiteVelocity: `{score, drivers: [{delta, reason}], warnings}`.
- [ ] Five components: fit 30, demand 25, timing 20, value 15, evidence 10.
- [ ] Threshold constant at 80, easy to find and change.
- [ ] Unit tests: hero permit scores at or above threshold, a deliberately weak candidate scores below it.

**Exit criteria:** score computed deterministically from Findings, no LLM call in this module at all.

---

## Step 6: Delivery + subscription state (P0)

- [ ] Stripe individual account in live mode (event eligibility rule): live 149/mo Payment Link for the demo checkout, test-mode mirror for development; wire the checkout entry point in the app.
- [ ] Webhook endpoint receives Stripe event, flips `subscriptions` row to active, idempotent on repeated events.
- [ ] Lead Agent only fulfills accounts with active subscriptions.
- [ ] SMS delivery via Twilio: opportunity summary + link, sent only for scores ≥ threshold.
- [ ] Web detail page renders trigger record, evidence with labels, score drivers, best path in, recommended action.

**Exit criteria:** a live end-to-end pass, subscribe → account active → next qualifying opportunity delivered by SMS and visible on the web detail page.

---

## Step 7: Sales sample motion (P0, promoted from the original handoff's P1)

- [ ] Load CSLB C-10 SF prospect pool from `cslb-c10-sf.csv`.
- [ ] Deterministic qualification (license active, geo).
- [ ] AI classification step: commercial vs residential from public web presence.
- [ ] Run a limited sample of the step 3-5 pipeline against the chosen prospect's territory.
- [ ] Compose and send the sample message + checkout link to the demo phone. Copy must follow CLAUDE.md rule 9: no AI/agent/autonomous/LLM language.
- [ ] Terac GenPop study (P0, event rule): Sales Agent drafts 3 message variants; launch a General Population study via the Terac MCP (rank the three texts, rate trust and clarity); deterministic winner selection in code; the winner becomes the live outreach copy; decision logged with the numbers. Launch as early as results latency allows.
- [ ] Before-and-after surfaced: losing drafts vs shipped copy with panel numbers, stored for the CEO dashboard (Step 10 renders it) and screenshot-ready for the pitch.

**Exit criteria:** triggering the Sales Agent once, live, results in a real SMS landing on the demo phone with a real sample opportunity and a working checkout link. The shipped message is the panel-tested winner, and the study numbers are stored.

---

## Step 8: Decision log + kill switch (P0)

- [ ] Append-only `events` table, every agent tick writes an entry: timestamp, agent, decision, summary, refs.
- [ ] UI feed rendering the log, newest first, color-coded by agent.
- [ ] `settings.kill_switch` row; every worker checks it at tick start; UI pause/unpause control.
- [ ] Confirm pausing visibly halts new log entries and unpausing resumes them.

**Exit criteria:** this is the demo's spine. Every other feature should already be writing to this log by the time it's built; this step is mostly making the log visible and the switch functional.

---

## CUT LINE

Everything above is P0. Do not start below until every box above is checked and the loop has been run live, end to end, at least once. If event-day time runs out here, stop and harden what exists instead of starting P1.

---

## Step 9: Feedback learning (P1)

- [ ] SMS keyword or UI button: good / too small / wrong scope.
- [ ] Customer Agent updates the effective profile weights.
- [ ] Confirm the next scoring pass visibly reflects the change.

## Step 10: CEO dashboard (P1)

- [ ] MRR, customers, opportunities delivered vs archived, per-account contribution economics.
- [ ] One real autonomous decision rendered from actual run data (segment shift), not a canned example.

## Step 12: Linq delivery layer (fenced stretch, lowest priority)

Only after steps 1-11. Additive second channel on top of a working Twilio path, never a swap.

- [ ] Confirm keys are already in hand and an existing number is usable. If not, stop here, this item is abandoned.
- [ ] Single commit, 45-minute hard timebox, visible timer.
- [ ] Send one message through Linq while Twilio remains fully wired and default.
- [ ] On timer expiry without a working send: `git revert` the commit, restore Twilio-only, move on. No extensions.

**Exit criteria:** either a working additive Linq send with Twilio untouched, or a clean revert. Both are acceptable outcomes; a half-wired state is not.

---

## Step 11: Terac expert escalation (stretch, optional)

The required Terac integration is the Step 7 study; this escalation is optional flavor if time remains.

- [ ] Trigger: scoring finds a blocking `unknown` Finding with high potential value.
- [ ] Create expert task via Terac MCP.
- [ ] On answer, write a new Finding at `verified` or `corroborated`, rescore.
- [ ] One live or staged beat is sufficient; do not over-build this.

---

## Rules that apply at every step (repeated from CLAUDE.md, worth having here too)

- Permit-first: no fulfillment workflow starts anywhere but a permit record.
- Deterministic code for filters, dedupe, thresholds, scoring math, billing state. AI only for interpretation, research, contact-path reasoning, drafting.
- Every stored fact is a Finding with an evidence label. Never fabricate. Unknowns stay visible.
- Exactly four agents. Do not add a fifth.
- No mock data in the demo path once real extracts exist. Replay is fine; invention is not.
- Every agent decision writes to `events`.
- AI is the engine, not the pitch: no AI/agent/autonomous/LLM language in customer-facing copy.

---

## What Claude Code should do differently once it actually looks

This document was written before the repo was inspected. Expect at least some of the following, and update the step list above accordingly rather than forcing reality to match this doc:

- The SiteVelocity copy may have pulled in more or less than the reuse map anticipated; reconcile step 1 against what's actually there.
- Field names in `mappings.md` may be incomplete if tonight's data phase ran short; step 2 may need a live re-verification pass.
- The hero permit(s) may not survive contact with the real filter logic in step 3; have a fallback candidate ready per `hero-permits.md`.
- Time pressure may force compressing steps rather than skipping them, for example building scoring and delivery together rather than sequentially. That's fine; the checklist items are the contract, the order is a suggestion.
