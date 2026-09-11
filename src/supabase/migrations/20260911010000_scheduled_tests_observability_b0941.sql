-- B0-941 — SCHEDULED TEST OBSERVABILITY
--
-- Defines two tables for tracking scheduled test runs and their constituent items:
--
-- `scheduled_test_runs` — parent record per sweep execution
--   Stores metadata about the entire test sweep including status, timing, and aggregate metrics.
--   Each row represents one invocation of the scheduled test harness.
--
-- `scheduled_test_items` — child records per test within a sweep
--   Stores per-test status, outcomes, and diagnostic data.
--   Links to scheduled_test_runs via scheduled_run_id (cascade delete).
--   Denormalizes test_id + test_name for readability without maintaining strict FK.
--   Tracks per-item timing, pass rates, grades, confidence, and error details.
--   Supports retry tracking and claiming workflow for distributed execution.

create table if not exists public.scheduled_test_runs (
  id uuid primary key default gen_random_uuid(),
  sweep_name text not null default 'golden_test_sweep',
  sweep_triggered_at timestamptz not null,
  status text not null default 'queued',
  error_message text,
  started_at timestamptz,
  completed_at timestamptz,
  elapsed_ms integer,
  total_tests integer not null default 0,
  successful_tests integer not null default 0,
  failed_tests integer not null default 0,
  timed_out_tests integer not null default 0,
  success_rate numeric,
  avg_elapsed_ms numeric,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_test_runs_status_check check (status = any (array['queued'::text, 'in_progress'::text, 'completed'::text, 'failed'::text]))
);

create index if not exists idx_scheduled_test_runs_sweep_triggered_at
  on public.scheduled_test_runs using btree (sweep_triggered_at desc);
create index if not exists idx_scheduled_test_runs_status_incomplete
  on public.scheduled_test_runs using btree (status) where status != 'completed'::text;

alter table public.scheduled_test_runs enable row level security;

create table if not exists public.scheduled_test_items (
  id uuid primary key default gen_random_uuid(),
  scheduled_run_id uuid not null references public.scheduled_test_runs (id) on delete cascade,
  test_id uuid not null,
  test_name text not null,
  test_run_id uuid,
  status text not null default 'queued',
  started_at timestamptz,
  completed_at timestamptz,
  elapsed_ms integer,
  items_total integer,
  items_passed integer,
  items_failed integer,
  pass_rate numeric,
  grade text,
  confidence numeric,
  error_code text,
  error_message text,
  error_details jsonb,
  retry_count integer not null default 0,
  last_retry_at timestamptz,
  claimed_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint scheduled_test_items_status_check check (status = any (array['queued'::text, 'claimed'::text, 'running'::text, 'completed'::text, 'failed'::text, 'timed_out'::text, 'skipped'::text]))
);

create index if not exists idx_scheduled_test_items_scheduled_run_id
  on public.scheduled_test_items using btree (scheduled_run_id);
create index if not exists idx_scheduled_test_items_test_id
  on public.scheduled_test_items using btree (test_id);
create index if not exists idx_scheduled_test_items_status_active
  on public.scheduled_test_items using btree (status) where status = any (array['queued'::text, 'running'::text]);
create index if not exists idx_scheduled_test_items_run_and_created
  on public.scheduled_test_items using btree (scheduled_run_id, created_at);

alter table public.scheduled_test_items enable row level security;

-- Trigger to update updated_at on scheduled_test_runs
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.scheduled_test_runs'::regclass
      and tgname = 'trg_scheduled_test_runs_updated_at'
      and not tgisinternal
  ) then
    create trigger trg_scheduled_test_runs_updated_at
      before update on public.scheduled_test_runs
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- Trigger to update updated_at on scheduled_test_items
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.scheduled_test_items'::regclass
      and tgname = 'trg_scheduled_test_items_updated_at'
      and not tgisinternal
  ) then
    create trigger trg_scheduled_test_items_updated_at
      before update on public.scheduled_test_items
      for each row execute function public.set_updated_at();
  end if;
end $$;
