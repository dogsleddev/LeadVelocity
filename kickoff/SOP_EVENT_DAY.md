# SOP: Hackathon Day (Zero-Human Company Hackathon)

**LeadVelocity - Humanmade, 655 Bryant St, San Francisco - Aug 15, 2026**

This is the execution order for the event itself. It assumes last night's SOP_TONIGHT.md exit criteria were met: extracts + hero permits on disk, field mappings verified, repo scaffolded and typechecking, Stripe test checkout proven, Twilio SMS proven. If any of those slipped, they are today's first job, not tomorrow's.

Companion docs: `LEADVELOCITY_KICKOFF.md` (day-of build order lives in section 7), `CLAUDE.md` (repo rules).

---

## Ground rules for today

1. **The cut line is real.** P0 first, always. Do not touch a P1 item while any P0 is broken. A shallow closed loop beats a deep open one.
2. **The company starts running the moment ingestion is live, not at demo time.** Every hour it runs unattended is accumulated proof: MRR, decision log depth, delivered-vs-archived ratio.
3. **Never let the demo depend on a live external call it doesn't have to.** Replay harness for permits, seeded/cached CSLB list, test-mode Stripe. Live calls are a bonus, not a dependency.
4. **Timebox every step. Re-timebox at each checkpoint, not just once at the start.**

---

## Phase 0: Arrival and check-in (30-45 min)

1. Confirm registration/badge. If approval status was ever in doubt, resolve it at the check-in desk immediately.
2. Ask the questions queued from last night: pre-existing scaffold/code disclosure policy, submission deadline, demo length and format, whether a deck or written submission template is required (if yes: fill the template as the written artifact, keep the live pitch's structure ours), and how Terac MCP access/auth is distributed. Also confirm Terac study mechanics: how to launch a General Population study through the MCP, expected turnaround on responses, any caps; and confirm whether the Stripe eligibility rule needs a live charge during the event or just the individual account collecting.
3. Disclose the SiteVelocity-derived scaffold per whatever policy you just got. Keep it short and factual: reused adapter and scoring patterns from an existing personal project, built the LeadVelocity product and agent logic today.
4. Get on wifi, confirm Render deploy is still healthy from last night (`/api/health/live`), confirm Supabase and Stripe dashboards load.
5. If Terac access is handed out at the venue: wire the MCP connection now, before anything else, since it's a hard dependency for the P1 escalation beat and other teams will be requesting the same setup help at the same time.

**Exit criteria:** badge on, questions answered, deploy confirmed alive, Terac access in progress or wired.

---

## Phase 1: Start the company (15-20 min) - DO THIS BEFORE ANYTHING ELSE

The single highest-leverage move of the day. Every hour the company runs unattended between now and your pitch slot is accumulated proof of autonomy that no amount of live-demo scrambling can fake.

1. Kick off the replay harness against last night's extract, at whatever `REPLAY_SPEED_MULTIPLIER` keeps it running steadily through the day without exhausting the dataset before your slot.
2. Confirm the Lead Agent worker tick is running (cron or loop) and writing to the decision log.
3. Confirm the Sales Agent worker tick is running against the CSLB prospect seed.
4. Watch the first few ticks resolve: at least one shortlist, one score, one archive. If the hero permit is due to fire on a schedule, do NOT force it yet, let it happen or replay-trigger it once, so there's a real timestamp deep in the log by the time you present.
5. Launch the first Terac study within the first hour: the Sales Agent's 3 message variants can be pre-drafted, panel responses take time, and the before-and-after beat depends on results landing before your slot.
6. Leave it running. Do not pause the company to build features under it; build against the live/replaying state.

**Exit criteria:** decision log has real entries with real timestamps, growing on its own, before you write another line of application code today.

---

## Phase 2: Day-of build order (bulk of the day)

Follow `LEADVELOCITY_KICKOFF.md` section 7 exactly, in order. Each step should leave the loop demoable, even if shallow. Recap with timeboxes:

| Step | What | Rough budget |
|---|---|---|
| 1 | Customer profile + opportunity detail screen | 45 min |
| 2 | Ingestion live + replay harness feeding real records (should already be running from Phase 1, just wire the UI to it) | 30 min |
| 3 | Shortlist: deterministic filters, then AI interpretation | 45 min |
| 4 | Enrichment: contacts join + CSLB verify, Findings with evidence labels | 60 min |
| 5 | Scoring + evidence display + threshold gate | 45 min |
| 6 | Delivery SMS + Stripe webhook flips account active | 45 min |
| 7 | Sales sample motion end to end to the demo phone, shipping the Terac-tested winner once study results land | 60 min |
| 8 | Decision log UI + kill switch | 30 min |
| - | **CUT LINE CHECKPOINT** - see below | - |
| 9 | Feedback learning (P1) | 30 min |
| 10 | CEO dashboard + one autonomous decision (P1) | 30 min |
| 11 | Terac expert escalation beat (stretch, optional) | 30 min |
| 12 | Linq delivery layer (fenced stretch, only if 1-11 are done and rehearsal time is protected) | 45 min HARD |

**Cut line checkpoint (mid-afternoon, set an actual clock time when the day starts):** if steps 1-8 are not solid, stop and do not open steps 9-11. Spend remaining time hardening 1-8 instead: fix the flakiest part of the loop, make the hero permit fire reliably, clean up the UI you already have. A demo that reliably shows a shallow closed loop beats one that reaches for a deep open one and drops it live.

**Checkpoint discipline:** after every step, actually run the loop end to end once, live, before moving to the next step. Do not stack five unverified changes.

**Linq fence (step 12):** additive only, Twilio stays live. Visible 45-minute timer, single commit, revert on expiry, no extensions. Abandon on sight if keys are not in hand, onboarding needs a conversation, docs are thin, or a new number must be provisioned. Never enters the demo path. Do not start it if doing so would eat into Phase 3 rehearsal: rehearsal outranks every stretch item on this list.

---

## Phase 3: Rehearsal (60-90 min, do not skip this)

Budget real time for this. A team that builds until the last minute and never rehearses is the most common way a good build loses.

1. Run the pitch cold, out loud, against the actual running app, not slides. Time it.
2. Confirm the required order holds under pressure: Buyer, Problem, Painful workaround, Why this company must exist, Product outcome, autonomy revealed last. 45-60 seconds max before "now watch the company operate."
3. Verify the hero permit is still going to be visible in the state you'll show (delivered, not archived, not buried under 200 later entries). If the replay has moved past it, know exactly where to scroll or filter.
4. Trigger the Terac escalation beat once, live if wired, or confirm the canned fallback if not.
5. Test the kill switch on stage: pause, show the log freezing, unpause. This is a strong beat, don't skip rehearsing it.
6. Confirm the closing ask is real: the final screen's QR or number points at a working entry point (public sample page live, or inbound SMS wired). If neither is solid by rehearsal time, the spoken ask becomes "come find us after and we'll run it on a contractor you know." Never show an entry point that dead-ends.
7. Identify and fix the single most likely failure point (usually: wifi at the venue, a live external call that should have been cached, or a demo phone that isn't charged).
8. Assign roles: who talks, who drives the screen, who handles a live question, who watches for a crash and has a backup plan (screen recording of a clean run, if things really go sideways).
9. Re-run the whole thing once more after fixes. Two clean rehearsals beats one plus hope.

**Exit criteria:** the pitch has been said out loud at least twice against the real app, timing confirmed, one identified failure point mitigated.

---

## Phase 4: Pre-pitch buffer (15-20 min before your slot)

1. Confirm the company is still running and the decision log still looks alive, not stalled.
2. Confirm demo phone charged and on the right screen.
3. Confirm venue wifi one more time; have a hotspot fallback ready if the venue network is congested (common at hackathons with many teams demoing simultaneously).
4. Deep breath. You rehearsed this.

---

## Phase 5: The pitch

Structure, from the kickoff doc, compressed for stage time:

1. **0:00-0:45** - Mike, the problem, the painful workaround. No agents, no autonomy, no AI mentioned yet.
2. **0:45-1:00** - reveal the product outcome: show the delivered opportunity card, evidence labels and all. Land the ROI line here: "Mike pays 1,788 dollars a year. The projects on this screen are 100K to 300K jobs. One win pays for the service for decades."
3. **1:00-end** - "now watch the company operate." Live decision log, a delivered lead, the human-input before-and-after (losing drafts, panel numbers, the shipped winner: the company paid real people through Terac to test its own sales copy), the kill switch pause/unpause, and if there's time, the CEO dashboard's one autonomous decision.
4. **Close** on the kill switch and audit log, since that answers "what stops it going rogue" before a judge asks.
5. **The ask, final screen:** a live entry point (QR to the public sample page, or the SMS number once inbound handling is wired). Spoken line: "The company is live right now. If you know a commercial contractor in San Francisco, point them here and it will find them a project."

**Q&A ready answers** (from the kickoff doc, keep these sharp):
- "Isn't this just permit alerts?" → We tell you whether it matters to you: interpretation, research, a customer-specific score, timing, and a path in.
- "How do you stop it from making things up?" → Every claim carries an evidence label; the score is computed in code, not decided by a model.
- "How do you get customers with no salespeople?" → The product is the pitch: one real sample opportunity, sent to a real prospect, before any ask for money.
- "What's actually zero-human here?" → The whole operating loop: acquire, bill, fulfill, learn, reallocate. Humans only appear on demand through an API: panel judgment when the company wants feedback, expert answers when it hits an unknown.
- "How big is this market?" → It is not estimated, it is enumerated: every licensed contractor in California sits in one public database, the same one the company already prospects from. Today one trade in one city; the engine does not change for the next trade or the next city.

---

## Phase 6: After you present

1. Keep the company running. Judges may circle back and poke at the live app after the formal slot.
2. If there's a submission form or repo link requirement, handle it immediately after your slot while it's fresh, don't leave it for the very end of the event.
3. If asked to disclose reused code again in a written submission, reuse the same short factual line from Phase 0.

---

## Definition of done for today

The company was running unattended for hours before you presented. The loop closed live, end to end, on real data, with a real hero lead delivered and evidence-labeled. The kill switch worked on stage. The pitch led with Mike and revealed autonomy last. Everything past that is upside.
