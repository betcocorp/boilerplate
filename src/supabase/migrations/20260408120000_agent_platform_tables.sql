-- BEX agent platform: durable conversations, workflow runs, audit trail (public schema).
-- Service-role server routes access these tables; enable RLS policies separately if exposing via PostgREST to clients.

create table if not exists public.agent_conversations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid null,
  user_id uuid null,
  title text not null default 'New conversation',
  latest_openai_response_id text null,
  openai_conversation_id text null,
  latest_model text null,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.agent_conversations (id) on delete cascade,
  role text not null,
  content jsonb not null default '{}'::jsonb,
  plain_text text null,
  openai_response_id text null,
  tool_name text null,
  created_at timestamptz not null default now()
);

create index if not exists agent_messages_conversation_id_created_at_idx
  on public.agent_messages (conversation_id, created_at);

create table if not exists public.workflow_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.agent_conversations (id) on delete cascade,
  workflow_name text not null,
  status text not null,
  user_input jsonb not null default '{}'::jsonb,
  final_output jsonb null,
  confidence numeric null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists workflow_runs_conversation_id_created_at_idx
  on public.workflow_runs (conversation_id, created_at desc);

create table if not exists public.workflow_steps (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references public.workflow_runs (id) on delete cascade,
  step_name text not null,
  status text not null,
  input jsonb null,
  output jsonb null,
  error jsonb null,
  started_at timestamptz not null default now(),
  completed_at timestamptz null
);

create index if not exists workflow_steps_run_id_started_at_idx
  on public.workflow_steps (workflow_run_id, started_at);

create table if not exists public.review_tasks (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid not null references public.workflow_runs (id) on delete cascade,
  status text not null default 'open',
  reason text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid null references public.workflow_runs (id) on delete set null,
  conversation_id uuid null references public.agent_conversations (id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_conversation_id_created_at_idx
  on public.audit_logs (conversation_id, created_at desc);

create index if not exists audit_logs_workflow_run_id_created_at_idx
  on public.audit_logs (workflow_run_id, created_at desc);
