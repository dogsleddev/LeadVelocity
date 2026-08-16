# CLAUDE.md - LeadVelocity

Autonomous subscription lead company for commercial contractors. Zero-Human Company Hackathon MVP. Full spec: `LEADVELOCITY_KICKOFF.md` (read it before large changes; it supersedes this file on scope questions, with one recorded exception: the delivery channel, see below).

## What this codebase is

Four agent workers (CEO, Sales, Lead, Customer) coordinating through Supabase state, turning real San Francisco permit records into scored, evidence-labeled opportunities for one contractor subscriber, with Stripe subscription state and an append-only decision log. Next.js + TypeScript + Zod + Supabase + Render + Linq (iMessage, RCS or SMS) + Stripe test mode + Anthropic API + Terac MCP.

Delivery channel: **Linq is the channel and the demo path. Twilio is the fallback, still implemented, not deleted.** Both sit behind `lib/delivery/channel.ts`; pick with `DELIVERY_CHANNEL=linq|twilio` (default `linq`). This reverses kickoff section 10 decision 2, deliberately; see `SOP_BUILD_PRELIMINARY.md` for what that traded away.

## Hard rules

1. A permit record starts every fulfillment workflow. Never generate leads from generic web roaming.
2. Deterministic code for filters, dedupe, thresholds, scoring arithmetic, billing state. AI only for interpretation, research, contact-path reasoning, and drafting. An LLM never produces an overall score.
3. Every stored fact is a Finding with an evidence label: `verified | corroborated | inferred | unknown`. Never fabricate. Unknowns stay visible.
4. Exactly four agents. Do not add agents. Do not rename ordinary software (cron, Stripe, webhooks) as agents.
5. No mock data in the demo path. Real records only, live or replayed from the committed real extract, and replay is labeled in the UI.
6. Every agent decision writes to the `events` log: timestamp, agent, decision, summary, refs.
7. All workers check the kill switch at tick start.
8. Never assume external field names. Inspect live schemas (or the committed extract) before writing or changing a field mapping, and record the endpoint + dataset identity in the source registry entry.
9. AI is the engine, not the pitch. Customer-facing copy generated anywhere in the system (Sales outbound, message templates, landing page, opportunity summaries) sells the contractor's problem and the outcome, never the technology. The words AI, agent, autonomous, and LLM do not appear in customer-facing output.
10. **Inbound first.** Linq's sandbox only allows messaging a handle that has texted the Linq number first. So the Sales Agent composes, and if the handle is not reachable it **queues** the message and logs "sample prepared, waiting for first contact". The inbound webhook releases it when that handle texts in. A queued message is never reported as sent. Do not "fix" this by removing the queue, by cold sending, or by flipping `LINQ_ALLOW_COLD_OUTBOUND` (that escape hatch is for a production number without the restriction, not for making the demo look better). Gate on `requiresInboundFirst()` from `lib/delivery/channel.ts`, never on a caught 403.

## Conventions

- TypeScript strict. Zod schemas at every boundary (source records, agent outputs, API routes). No `any`.
- Scoring returns `{score: 0-100, drivers: [{delta, reason}], warnings: []}`. Fatal flags are separate outputs, never averaged away.
- Calculation and normalizer modules are pure: no network, clock, file, or random access. Side effects live in workers and routes.
- Files copied from SiteVelocity keep their original doc-comment headers plus a one-line origin note. Do not modify copied adapter interfaces; extend via new registry entries.
- The copied SiteVelocity files are the house style. New modules match their structure, rigor, typing discipline, and doc-comment quality. When unsure how to build something, read how the copied lib/ files do it first; for missing files or deeper context, the source repo is https://github.com/samshanmukh/SiteVelocity.
- Secrets: env only, `.env.example` documents keys, `render.yaml` uses `sync: false`. Never commit a credential or a real extract containing one.
- Vocabulary (merge-critical, do not rename): `SourceDescriptor`, `Finding`, `ScoreOutput`, snapshot `added | changed | not_observed`, evidence labels as above.
- **Sending** goes through `lib/delivery/channel.ts` only. No agent, worker, or script imports `lib/integrations/linq.ts` or `lib/integrations/twilio.ts` directly, or the fallback stops being a config flip. The one carve-out is a provider's own **inbound webhook route** (`app/api/linq/inbound`, `app/api/twilio/inbound`): signature verification is provider-specific by nature and has no channel-neutral form, so those routes import their provider's verifier and nothing else from it. Everything they do afterwards, including releasing queued messages, goes back through the seam.
- No em dashes in any customer-facing or judge-facing copy, message templates included.

## Commands

- `npm run dev` - local app
- `npm run typecheck` / `npm run lint` / `npm test` - keep green; scoring and normalizer require unit tests before wiring into workers
- `npm run ingest` - one ingestion pass (live SODA)
- `npm run replay` - feed the committed real extract on the accelerated clock
- `npm run workers` - start agent tick loops locally
- `npm run db:migrate` - Supabase migrations (also runs as Render preDeploy)

(If a command does not exist yet, create it to match this contract rather than inventing a new name.)

## Scope discipline

P0 list and build order live in `LEADVELOCITY_KICKOFF.md` sections 3 and 7. Do not start a P1 item while any P0 is broken. Do not add data sources, trades, territories, agents, or screens that are not in the kickoff doc. When in doubt, make the loop close shallower rather than deeper.
