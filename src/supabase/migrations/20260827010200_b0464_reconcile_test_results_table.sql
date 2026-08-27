-- B0-464 RECONCILIATION BACKFILL — DDL applied live with no checked-in migration file.
-- Transcribed from the live catalog on 2026-08-27, not from memory.
--
-- `public.test_results` CREATE TABLE was never committed. scripts/check-schema-drift.mjs reported
-- `col-missing` for total_items, passed_items, failed_items, started_at, completed_at, notes,
-- run_mode, avg_similarity, avg_confidence, run_options, retrieval_strategy and triggered_by
-- (B0-687). Later columns (insights, report_state, report, app_version) do have migrations.
--
-- Every statement below is a NO-OP against the current live database.

create table if not exists public.test_results (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests (id) on delete cascade,
  status text not null default 'running'::text,
  total_items integer not null default 0,
  passed_items integer not null default 0,
  failed_items integer not null default 0,
  started_at timestamptz not null default now(),
  completed_at timestamptz,
  elapsed_ms integer,
  summary jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  notes text,
  run_mode text not null default 'full'::text,
  avg_similarity numeric,
  avg_confidence numeric,
  run_options jsonb not null default '{}'::jsonb,
  retrieval_strategy text,
  insights jsonb,
  insights_generated_at timestamptz,
  report_state jsonb,
  report text,
  report_generated_at timestamptz,
  app_version text,
  triggered_by text
);

alter table public.test_results add column if not exists total_items integer not null default 0;
alter table public.test_results add column if not exists passed_items integer not null default 0;
alter table public.test_results add column if not exists failed_items integer not null default 0;
alter table public.test_results add column if not exists started_at timestamptz not null default now();
alter table public.test_results add column if not exists completed_at timestamptz;
alter table public.test_results add column if not exists elapsed_ms integer;
alter table public.test_results add column if not exists summary jsonb not null default '{}'::jsonb;
alter table public.test_results add column if not exists notes text;
alter table public.test_results add column if not exists run_mode text not null default 'full'::text;
alter table public.test_results add column if not exists avg_similarity numeric;
alter table public.test_results add column if not exists avg_confidence numeric;
alter table public.test_results add column if not exists run_options jsonb not null default '{}'::jsonb;
alter table public.test_results add column if not exists retrieval_strategy text;
alter table public.test_results add column if not exists triggered_by text;

create index if not exists idx_test_results_test_id
  on public.test_results using btree (test_id, created_at desc);

-- RLS + test_results_service_role policy already checked in via 20260715090200_enable_rls_and_policies.sql.
alter table public.test_results enable row level security;

comment on column public.test_results.notes is
  'Human-entered context for this run (dataset changes, similarity tweaks, etc.).';
comment on column public.test_results.triggered_by is
  'B0-687 — actor who created this run: session email for a UI run, ''api-client'' for a service-token run, NULL for runs created before this column existed.';
