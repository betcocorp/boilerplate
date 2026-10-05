-- B0-895 — Enable RLS on the eight public tables that were still exposed (model_pricing, the five
-- *_purged_20260903 backups, test_grading_usage, test_items_concepts_backup_b0953_20260911) and lock
-- down the three cost views (cost_by_model_per_day / _per_month / cost_comparison_yoy).
--
-- Observed live 2026-10-05: all eight tables had relrowsecurity=false with no policies, and all
-- eleven objects carried the default `anon` / `authenticated` grants for ALL privileges; the views
-- had no `security_invoker` (they post-date b0_284_security_invoker_views). test_result_items_purged
-- alone is 41 MB of full Bex answers.
--
-- Posture matches 20260715090200_enable_rls_and_policies / 20260826210000_create_test_result_comparisons:
-- RLS on, one `<table>_service_role` FOR ALL policy, nothing for anon/authenticated. Every reader
-- (`~/lib/observability/cost-metrics.ts`, the grading-usage writers) goes through the service-role
-- client, which bypasses RLS and keeps its grants, so nothing user-facing changes.
--
-- Idempotent and re-runnable: `if exists` guards throughout, `drop policy if exists` before create.
-- Nothing is dropped — the backup tables stay exactly as they are, just no longer world-readable.

do $$
declare
  r record;
begin
  for r in (
    select unnest(array[
      'model_pricing',
      'tests_purged_20260903',
      'test_items_purged_20260903',
      'test_results_purged_20260903',
      'test_result_items_purged_20260903',
      'test_result_comparisons_purged_20260903',
      'test_grading_usage',
      'test_items_concepts_backup_b0953_20260911'
    ]) as tbl
  ) loop
    if to_regclass(format('public.%I', r.tbl)) is null then
      raise notice 'B0-895: public.% does not exist, skipping', r.tbl;
      continue;
    end if;

    execute format('alter table public.%I enable row level security;', r.tbl);
    execute format('drop policy if exists %I on public.%I;', r.tbl || '_service_role', r.tbl);
    execute format(
      'create policy %I on public.%I for all to service_role using (true) with check (true);',
      r.tbl || '_service_role', r.tbl
    );
    execute format('revoke all on table public.%I from anon, authenticated;', r.tbl);
  end loop;
end $$;

-- Cost views: no anon/authenticated access, and evaluate with the caller's privileges so the RLS
-- on workflow_steps / model_pricing underneath actually applies to whoever queries the view.
do $$
declare
  r record;
begin
  for r in (
    select unnest(array['cost_by_model_per_day', 'cost_by_model_per_month', 'cost_comparison_yoy']) as v
  ) loop
    if to_regclass(format('public.%I', r.v)) is null then
      raise notice 'B0-895: view public.% does not exist, skipping', r.v;
      continue;
    end if;

    execute format('revoke all on table public.%I from anon, authenticated;', r.v);
    execute format('alter view public.%I set (security_invoker = true);', r.v);
  end loop;
end $$;
