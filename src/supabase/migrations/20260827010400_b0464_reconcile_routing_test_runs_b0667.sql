-- B0-464 RECONCILIATION BACKFILL — DDL applied live with no checked-in migration file.
-- Transcribed from the live catalog on 2026-08-27, not from memory.
--
-- B0-667 added the routing-test run history (`public.routing_test_runs` + the per-item snapshot
-- `public.routing_test_run_items`) live without a migration file. Only a later ALTER was committed
-- (20260825180000_add_model_to_routing_test_runs_b0671.sql, which adds `model`), so
-- scripts/check-schema-drift.mjs reported `rel-missing` for routing_test_run_items and
-- `col-missing` for nine routing_test_runs columns.
--
-- src/lib/routing-test/repository.ts already documents these two tables as "newer than the
-- checked-in generated types" — this file is the missing DDL half.
--
-- Every statement below is a NO-OP against the current live database.

create table if not exists public.routing_test_runs (
  id uuid primary key default gen_random_uuid(),
  router_type text not null,
  ran_at timestamptz not null,
  total_items integer not null default 0,
  passed_items integer not null default 0,
  degraded_items integer not null default 0,
  duration_ms integer not null default 0,
  avg_item_duration_ms numeric,
  warning text,
  created_at timestamptz not null default now(),
  model text,
  constraint routing_test_runs_router_type_check
    check (router_type = any (array['keyword'::text, 'semantic'::text, 'llm'::text]))
);

alter table public.routing_test_runs add column if not exists total_items integer not null default 0;
alter table public.routing_test_runs add column if not exists passed_items integer not null default 0;
alter table public.routing_test_runs add column if not exists degraded_items integer not null default 0;
alter table public.routing_test_runs add column if not exists duration_ms integer not null default 0;
alter table public.routing_test_runs add column if not exists avg_item_duration_ms numeric;
alter table public.routing_test_runs add column if not exists warning text;
alter table public.routing_test_runs add column if not exists created_at timestamptz not null default now();

create index if not exists routing_test_runs_ran_at_idx
  on public.routing_test_runs using btree (ran_at desc);

-- `expected_agent` duplicates SME_AGENT_IDS (src/lib/agents/agent-registry.ts). Live already
-- includes 'cross_reference' here — the routing_test_items sibling constraint got the same value
-- via 20260825150000_add_cross_reference_to_routing_test_items_check_b0665.sql, but this table's
-- copy was only ever applied live.
create table if not exists public.routing_test_run_items (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.routing_test_runs (id) on delete cascade,
  item_id uuid references public.routing_test_items (id) on delete set null,
  row_index integer not null,
  prompt text not null,
  expected_agent text not null,
  predicted_agent text not null,
  passed boolean not null,
  error text,
  elapsed_ms integer not null,
  detail jsonb,
  created_at timestamptz not null default now(),
  constraint routing_test_run_items_expected_agent_check
    check (expected_agent = any (array[
      'product'::text, 'bathroom'::text, 'dilution'::text, 'floor'::text,
      'recommendations'::text, 'cross_reference'::text]))
);

create index if not exists routing_test_run_items_run_id_idx
  on public.routing_test_run_items using btree (run_id, row_index);
create index if not exists routing_test_run_items_item_id_idx
  on public.routing_test_run_items using btree (item_id) where item_id is not null;

-- Same posture as routing_test_items: RLS on, all access through the service-role client.
alter table public.routing_test_runs enable row level security;
alter table public.routing_test_run_items enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'routing_test_runs'
      and policyname = 'routing_test_runs_service_role'
  ) then
    create policy routing_test_runs_service_role on public.routing_test_runs
      for all to service_role using (true) with check (true);
  end if;
end $$;

-- NOTE: live `routing_test_run_items` has RLS enabled and NO policy at all. Transcribed as-is —
-- the service role bypasses RLS, so the app is unaffected, but anon/authenticated are denied
-- everything. Deliberately not "fixed" here; changing it is a behavioral change, not a backfill.

comment on table public.routing_test_runs is
  'B0-667 — one row per routing test run against routing_test_items. Summary stats only; per-item detail lives in routing_test_run_items.';
comment on table public.routing_test_run_items is
  'B0-667 — one row per item scored in a routing_test_runs run. prompt/expected_agent are snapshots, not live joins.';
comment on column public.routing_test_runs.model is
  'B0-671: resolved OpenAI model id the llm router called for this run (via resolveResponsesModel), null for keyword/semantic runs or an llm run with no explicit model tag chosen.';
