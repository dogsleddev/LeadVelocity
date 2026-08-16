# LeadVelocity — Kickoff Bundle (Event Day)

Everything the hackathon repo and the day itself need. Drop the docs into the fresh repo root, keep the SOPs open on a second screen, use the diagrams in the pitch and README.

## What's here

- `CLAUDE.md` — lean operating rules Claude Code reads every session. Put this in the repo root. Hard rules, conventions, the command contract, and the merge-critical vocabulary.
- `LEADVELOCITY_KICKOFF.md` — the full build spec. Scope (P0/P1), the revision table vs the original handoff, architecture rules, territory + data sources with the real DataSF dataset IDs, the SiteVelocity reuse map, build order with a hard cut line, and the pitch anchor. Supersedes the original handoff on scope; the handoff stays the source for long-term vision.
- `SOP_BUILD_PRELIMINARY.md` — the build execution playbook for Claude Code, step-by-step checklists with exit criteria for P0 steps 1-8, the cut line, then P1 steps 9-11. Marked preliminary on purpose: step 0 tells Claude Code to inventory the actual repo state and correct this document before writing code. Put this in the repo root too.
- `SOP_EVENT_DAY.md` — the human playbook for the day, arrival to pitch. Phase 0 check-in questions, Phase 1 (start the company before building anything), timeboxed build order, a non-skippable rehearsal block, the pitch structure in stage seconds, and the Q&A answers.
- `diagrams/` — the two visuals:
  - `leadvelocity-company-loop.(png|jpg)` — the "watch the company operate" view for the pitch (Act 4). Five functions, four agents, money path solid, learning loops green, Terac in orange, governance across the bottom.
  - `leadvelocity-lead-agent-pipeline.(png|jpg)` — the production engine, permit to delivered opportunity, color-coded deterministic / AI / human / gate.
  - `*.mermaid` — editable source for both, renders natively in GitHub markdown.

## First moves tomorrow

1. Follow `SOP_EVENT_DAY.md` Phase 0 (check-in, disclosure, Terac access) and Phase 1 (start the company running before writing any code).
2. Carry the four sandbox outputs into the repo: `mappings.md`, the `/data` extracts, `hero-permits.md`, `cslb-c10-sf.csv`.
3. Point Claude Code at `SOP_BUILD_PRELIMINARY.md` step 0: inventory the repo, correct the SOP against reality, then build in order.

## Pitch north star

"AI is the engine, not the pitch." Buyer first, autonomy last. The 30-second script and the required order are in kickoff section 8, and the same rule is enforced on all agent-generated copy in CLAUDE.md.
