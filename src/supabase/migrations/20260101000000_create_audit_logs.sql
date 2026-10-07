-- Append-only audit trail. Written by `~/lib/audit/audit-log` (permission verdicts, sign-in
-- rejections) and by the permission-group merge/delete functions.
--
-- `workflow_run_id` / `conversation_id` are plain nullable uuids with no foreign key: the base
-- boilerplate has no workflow or conversation tables. Add the references in your own migration if
-- your app grows them.

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  workflow_run_id uuid null,
  conversation_id uuid null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists audit_logs_event_type_created_at_idx
  on public.audit_logs (event_type, created_at desc);

create index if not exists audit_logs_conversation_id_created_at_idx
  on public.audit_logs (conversation_id, created_at desc);

create index if not exists audit_logs_workflow_run_id_created_at_idx
  on public.audit_logs (workflow_run_id, created_at desc);

-- No policies: reads and writes go through the service-role client, which bypasses RLS.
alter table public.audit_logs enable row level security;
