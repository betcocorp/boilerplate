-- B0-1100 — partial (threshold-filtered) golden runs.
--
-- `run_mode` already carried 'full' | 'search' with no CHECK; a third value 'partial' is added
-- and the set is now enforced at the database so an unknown mode can never be written.
--
-- `partial_score_threshold` — the 0–100 bar the Run Golden dialog was submitted with; set only
-- when run_mode = 'partial'.
-- `item_scope` — the exact `test_items.id`s this run executes (B0-1110's resolver is the only
-- reader). NULL means every item in the test, i.e. today's behaviour, byte for byte.

alter table public.test_results
  add column if not exists partial_score_threshold numeric null,
  add column if not exists item_scope uuid[] null;

comment on column public.test_results.partial_score_threshold is
  'B0-1100 — score threshold (0–100) a partial golden run was filtered by; null for full/search runs.';
comment on column public.test_results.item_scope is
  'B0-1100/B0-1110 — test_items.id[] this run executes; null = every item in the test.';

alter table public.test_results
  add constraint test_results_run_mode_check
  check (run_mode in ('full', 'search', 'partial'));
