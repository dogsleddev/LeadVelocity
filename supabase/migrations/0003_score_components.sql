-- Component subtotals on a scored opportunity.
--
-- The score has always been five components (fit 30, demand 25, timing 20,
-- value 15, evidence 10) but only two shapes of it were ever stored: the single
-- number, and the flat `drivers` list of signed deltas with their reasons. The
-- grouped middle view, the one a contractor actually reads ("fit 29 of 30"),
-- had to be reconstructed by parsing driver text, which is guesswork dressed as
-- a fact. `lib/calculations/scoring/lead-score.ts` already computes the
-- subtotals; this column is where they stop being discarded.
--
-- Stored, not recomputed at read time, for the same reason `score` is stored:
-- the customer weights and the trade vocabulary both move, so recomputing later
-- would answer "what would this score today", while the opportunity row has to
-- answer "what did we tell them, and why". Those are different questions and a
-- judge is entitled to the second one.
--
-- NULLABLE, WITH NO BACKFILL, ON PURPOSE.
-- Rows scored before this migration genuinely do not have the breakdown. A
-- default of `'{}'::jsonb`, or worse a backfill of zeroes, would render as five
-- empty bars and read as "this lead scored nothing on every component", which
-- is a fabricated fact (CLAUDE.md hard rule 3). NULL means "not recorded for
-- this row", the UI is required to say so, and the value appears the next time
-- the candidate is scored.

alter table opportunities
  -- { "fit": number, "demand": number, "timing": number, "value": number,
  --   "evidence": number }, each the WEIGHTED contribution that reached the
  -- score. A subscriber weight above 1 can carry a component past its
  -- unweighted ceiling, so a renderer clamps the bar rather than trusting the
  -- ratio. Absent components are absent, never zero.
  add column if not exists component_subtotals jsonb
    check (component_subtotals is null or jsonb_typeof(component_subtotals) = 'object');

comment on column opportunities.component_subtotals is
  'Weighted per-component contributions from the deterministic scorer (fit, demand, timing, value, evidence). NULL means the row predates the column and the breakdown was never recorded; it is never zero-filled.';
