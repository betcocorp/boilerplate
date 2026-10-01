-- B0-1106 — manual and partial Run Golden fan-outs are recorded in the sweep ledger.
--
-- `run_mode` splits full sweeps from partial (threshold-filtered) sweeps so the two never share a
-- list; the existing `sweep_name` stays the trigger source ('golden_test_sweep' = nightly cron,
-- 'manual_golden_sweep' = the Run Golden dialog). `partial_score_threshold` mirrors the same-named
-- column on test_results (B0-1100) so the two ledgers read alike.

alter table public.scheduled_test_runs
  add column if not exists run_mode text not null default 'full',
  add column if not exists partial_score_threshold numeric null;

alter table public.scheduled_test_runs
  add constraint scheduled_test_runs_run_mode_check
  check (run_mode in ('full', 'partial'));

comment on column public.scheduled_test_runs.run_mode is
  'B0-1106 — full | partial; partial sweeps are display-only and never feed golden-set metrics.';
comment on column public.scheduled_test_runs.partial_score_threshold is
  'B0-1106 — threshold (0–100) a partial sweep was filtered by; null for full sweeps.';
