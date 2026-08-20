-- B0-353 — split recommendation `pending` into `pending` + `escalated` so HITL is its own state.
--
-- `pending` used to do two unrelated jobs: the default value on insert (nothing decided yet) AND
-- the status the validator-forced-review path (`recommend-cross-reference.ts`) sets when a human
-- must look at a run the engine could not safely surface on its own. Those are different states —
-- the review queue could not tell "nothing has happened yet" from "a human needs to look at this"
-- — so `escalated` now covers the second case; `pending` keeps meaning only the first.
--
-- Per this team's migration convention, a check constraint cannot be `CREATE OR REPLACE`d — it must
-- be dropped and recreated to add the new allowed value.

alter table rag.cross_reference_recommendations
  drop constraint cross_reference_recommendations_status_check;

alter table rag.cross_reference_recommendations
  add constraint cross_reference_recommendations_status_check
  check (status in ('pending', 'escalated', 'answered', 'declined', 'verified', 'rejected'));

-- Backfill: rows already forced into human review by the validator gate are indistinguishable from
-- a fresh row today, both stored as `status = 'pending'`. `evidence.validation.gatePassed` is set
-- (to `false`) exactly when the validator ran and rejected — see the `validation = { ... gatePassed:
-- verdict.pass, ... }` assignment in `recommend-cross-reference.ts` — so it is a reliable signal to
-- reclassify those rows as `escalated` after the fact. Everything else (including rows with no
-- `evidence.validation` block at all, e.g. legacy-path or pre-validator rows) is left as `pending`.
--
-- Scoped to `status = 'pending'` on purpose: `evidence.validation.gatePassed = false` only ever
-- co-occurs with `status = 'pending'` in today's code (see the `if (!verdict.pass)` block), so this
-- guard is redundant with the data as it stands, but it keeps the backfill from ever touching an
-- `answered`/`declined`/`verified`/`rejected` row even if that invariant is violated some other way.
--
-- Read-only check performed before writing this migration (2026-08-20, live `rag` schema):
--   - table has 124 rows total: 1 `answered`, 122 `declined`, 1 `verified`, 0 `pending`, 0 `rejected`.
--   - 0 rows match `status = 'pending' AND evidence->'validation'->>'gatePassed' = 'false'` (there are
--     currently no `pending` rows at all), so this backfill is a documented no-op today and only
--     matters for `pending` rows written before this migration lands.
update rag.cross_reference_recommendations
set status = 'escalated'
where status = 'pending'
  and evidence -> 'validation' ->> 'gatePassed' = 'false';
