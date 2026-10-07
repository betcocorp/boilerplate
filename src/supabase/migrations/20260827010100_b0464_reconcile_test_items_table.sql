-- B0-464 RECONCILIATION BACKFILL — DDL applied live with no checked-in migration file.
-- Transcribed from the live catalog on 2026-08-27, not from memory.
--
-- `public.test_items` CREATE TABLE was never committed. scripts/check-schema-drift.mjs reported
-- `col-missing` for expected_should_answer, expected_canonical_product and expected_tool.
--
-- expected_tool is the freshest instance of the exact bug B0-464 is about: commit 3dff47f4
-- (fix(B0-694), 2026-08-26) states "migration + backfill of 92 existing rows already applied via
-- Supabase MCP" and shipped the TypeScript half only — the DDL never entered git.
--
-- Every statement below is a NO-OP against the current live database.

create table if not exists public.test_items (
  id uuid primary key default gen_random_uuid(),
  test_id uuid not null references public.tests (id) on delete cascade,
  row_index integer not null,
  prompt text not null,
  expected_should_answer boolean,
  expected_result_type text,
  expected_canonical_product text,
  expected_reason_code text,
  input_payload jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  prompt_category text,
  priority smallint,
  ideal_response text,
  expected_concepts text,
  minimum_concepts text,
  expected_sources text,
  should_cite boolean,
  source text,
  intended_agent_item text,
  expected_criteria jsonb not null default '[]'::jsonb,
  expected_tool text
);

alter table public.test_items add column if not exists expected_should_answer boolean;
alter table public.test_items add column if not exists expected_result_type text;
alter table public.test_items add column if not exists expected_canonical_product text;
alter table public.test_items add column if not exists expected_reason_code text;
alter table public.test_items add column if not exists input_payload jsonb not null default '{}'::jsonb;
alter table public.test_items add column if not exists metadata jsonb not null default '{}'::jsonb;
alter table public.test_items add column if not exists created_at timestamptz not null default now();
-- B0-694 — the column commit 3dff47f4 applied live via MCP without a migration file.
alter table public.test_items add column if not exists expected_tool text;

create index if not exists idx_test_items_test_id on public.test_items using btree (test_id);
create index if not exists idx_test_items_row_index on public.test_items using btree (test_id, row_index);

-- public.test_items_auto_classify() is defined by 20260527120000_prompt_category_on_test_items.sql.
-- Guarded rather than DROP+CREATE so this file is a true no-op against live.
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.test_items'::regclass
      and tgname = 'test_items_classify_prompt'
      and not tgisinternal
  ) then
    create trigger test_items_classify_prompt
      before insert or update of prompt on public.test_items
      for each row execute function public.test_items_auto_classify();
  end if;
end $$;

-- RLS + test_items_service_role policy already checked in via 20260715090200_enable_rls_and_policies.sql.
alter table public.test_items enable row level security;
