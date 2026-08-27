-- B0-464 RECONCILIATION BACKFILL — DDL applied live with no checked-in migration file.
-- Transcribed from the live catalog on 2026-08-27, not from memory.
--
-- `public.agent_message_feedback` is named by two committed migrations
-- (20260715090200_enable_rls_and_policies.sql, 20260722061000_rag_security_lockdown_…sql) but its
-- CREATE TABLE was never committed, so scripts/check-schema-drift.mjs reported ALL NINE of its
-- columns as `col-missing` — the table's entire shape existed only in the live database.
--
-- Every statement below is a NO-OP against the current live database.

create table if not exists public.agent_message_feedback (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.agent_messages (id) on delete cascade,
  conversation_id uuid not null references public.agent_conversations (id) on delete cascade,
  workflow_run_id uuid references public.workflow_runs (id) on delete set null,
  rating text not null,
  reason_code text,
  comment text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_message_feedback_rating_check check (rating = any (array['up'::text, 'down'::text]))
);

alter table public.agent_message_feedback add column if not exists workflow_run_id uuid;
alter table public.agent_message_feedback add column if not exists reason_code text;
alter table public.agent_message_feedback add column if not exists comment text;
alter table public.agent_message_feedback add column if not exists created_at timestamptz not null default now();
alter table public.agent_message_feedback add column if not exists updated_at timestamptz not null default now();

-- One feedback row per assistant message (live: UNIQUE index, not a table constraint).
create unique index if not exists idx_agent_message_feedback_message_id_unique
  on public.agent_message_feedback using btree (message_id);
create index if not exists idx_agent_message_feedback_conversation_id
  on public.agent_message_feedback using btree (conversation_id, created_at desc);
create index if not exists idx_agent_message_feedback_workflow_run_id
  on public.agent_message_feedback using btree (workflow_run_id);

-- public.set_agent_message_feedback_updated_at() is reconciled by
-- 20260827011000_b0464_reconcile_updated_at_trigger_functions.sql.
-- Guarded rather than DROP+CREATE so this file is a true no-op against live.
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.agent_message_feedback'::regclass
      and tgname = 'trg_agent_message_feedback_updated_at'
      and not tgisinternal
  ) then
    create trigger trg_agent_message_feedback_updated_at
      before update on public.agent_message_feedback
      for each row execute function public.set_agent_message_feedback_updated_at();
  end if;
end $$;

-- RLS + agent_message_feedback_service_role policy already checked in via
-- 20260715090200_enable_rls_and_policies.sql.
alter table public.agent_message_feedback enable row level security;
