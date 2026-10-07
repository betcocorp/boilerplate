-- B0-464 RECONCILIATION BACKFILL — DDL that was applied to the live database with no checked-in
-- migration file. Transcribed from the live catalog (pg_attribute/pg_attrdef, pg_constraint,
-- pg_indexes, pg_trigger, pg_description) on 2026-08-27, never from memory or inference.
--
-- `public.tests` has existed live since the eval harness was built, but its CREATE TABLE was never
-- committed — only later ALTERs were (20260527120000_prompt_category_on_test_items.sql,
-- 20260814190000_add_app_version_to_test_results_and_items_b0472.sql, …). Originating ledger row
-- unknown: the live supabase_migrations ledger and this directory are not reconcilable by name.
--
-- scripts/check-schema-drift.mjs reported these as `col-missing`: uploaded_at, suite_version,
-- similarity_floor, confidence_floor, is_golden (B0-572), is_archived.
--
-- Every statement below is a NO-OP against the current live database.

create table if not exists public.tests (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  source_file_name text not null,
  source_bucket text not null,
  source_key text not null,
  row_count integer not null default 0,
  status text not null default 'ready'::text,
  uploaded_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  intended_agent text,
  suite_version text not null default 'v1'::text,
  similarity_floor numeric not null default 0.78,
  confidence_floor numeric not null default 0.80,
  is_golden boolean not null default false,
  is_archived boolean not null default false
);

-- Idempotent per-column convergence: the table already exists live, so the CREATE above is skipped
-- and these are what actually record the drifted columns in git.
alter table public.tests add column if not exists name text not null;
alter table public.tests add column if not exists source_file_name text not null;
alter table public.tests add column if not exists source_bucket text not null;
alter table public.tests add column if not exists source_key text not null;
alter table public.tests add column if not exists row_count integer not null default 0;
alter table public.tests add column if not exists status text not null default 'ready'::text;
alter table public.tests add column if not exists uploaded_at timestamptz not null default now();
alter table public.tests add column if not exists updated_at timestamptz not null default now();
alter table public.tests add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.tests add column if not exists intended_agent text;
alter table public.tests add column if not exists suite_version text not null default 'v1'::text;
alter table public.tests add column if not exists similarity_floor numeric not null default 0.78;
alter table public.tests add column if not exists confidence_floor numeric not null default 0.80;
alter table public.tests add column if not exists is_golden boolean not null default false;
alter table public.tests add column if not exists is_archived boolean not null default false;

create index if not exists idx_tests_is_archived on public.tests using btree (is_archived);
create index if not exists tests_is_golden_idx on public.tests using btree (is_golden) where is_golden;

-- public.set_updated_at() is reconciled by 20260827011000_b0464_reconcile_updated_at_trigger_functions.sql.
-- Guarded rather than DROP+CREATE so this file is a true no-op against live.
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.tests'::regclass
      and tgname = 'trg_tests_updated_at'
      and not tgisinternal
  ) then
    create trigger trg_tests_updated_at
      before update on public.tests
      for each row execute function public.set_updated_at();
  end if;
end $$;

-- RLS + the tests_service_role policy are already checked in via
-- 20260715090200_enable_rls_and_policies.sql; re-enabling is a no-op and keeps this file
-- self-describing about the live posture (service-role only, no anon read).
alter table public.tests enable row level security;

comment on column public.tests.intended_agent is
  'Target SME agent id (e.g. product, bathroom) from the v1 agent registry; null if unset.';
comment on column public.tests.is_golden is
  'B0-572: marks this test set as part of the gating golden set. Every item in a golden set must carry a priority; items with NULL priority are reported as data errors by the golden-set reader.';
