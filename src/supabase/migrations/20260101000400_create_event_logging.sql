-- B0-761 — user-behaviour analytics store (port of c360 CRM_APP.EVENT_LOGGING).
--
-- Deliberately NOT folded into `public.audit_logs`: that table is pipeline-scoped
-- (conversation_id / workflow_run_id, no actor columns), already carries ~107k agent-run
-- rows, and its readers (`~/lib/observability/timeline.ts`, `tool-failure-series.ts`,
-- `pipeline-stages.ts`) scan it by `event_type`. Mixing per-user page views into it would
-- both pollute those scans and leave the actor un-indexable.
--
-- `user_id` / `session_id` are real columns rather than `meta` keys for the same reason
-- c360 promoted them out of its META VARIANT (20260811_add_event_logging_user_session_columns):
-- every funnel query groups by them, and a jsonb extraction cannot be indexed as cheaply.
-- The write path fills them from the same meta payload, so the two never disagree.

create table if not exists public.event_logging (
  id uuid primary key default gen_random_uuid(),
  event text not null,
  sentry jsonb not null default '{}'::jsonb,
  meta jsonb not null default '{}'::jsonb,
  user_id text,
  session_id text,
  created_at timestamptz not null default now()
);

comment on table public.event_logging is
  'B0-761: application analytics events (page views, logins, chat + search interactions). Port of c360 CRM_APP.EVENT_LOGGING. Service-role only; written by POST /api/events/log.';
comment on column public.event_logging.event is
  'Dot-notation event name, always `analytics.`-prefixed by normalizeAnalyticsEventName(). Max 512 chars.';
comment on column public.event_logging.sentry is
  'Snapshot of the Sentry scope/SDK/active span plus browser hints at the time of the event.';
comment on column public.event_logging.meta is
  'Arbitrary event context. Actor keys (userId, name, email, permission_groups) are merged server-side by the route; sessionId is injected client-side.';
comment on column public.event_logging.user_id is
  'Denormalized from meta->>''userId'' at insert. NULL for events with no resolvable actor.';
comment on column public.event_logging.session_id is
  'Denormalized from meta->>''sessionId'' at insert. NULL for server-originated events (no sessionStorage).';

create index if not exists event_logging_created_at_idx
  on public.event_logging (created_at desc);

create index if not exists event_logging_event_created_at_idx
  on public.event_logging (event, created_at desc);

create index if not exists event_logging_user_id_created_at_idx
  on public.event_logging (user_id, created_at desc)
  where user_id is not null;

create index if not exists event_logging_session_id_idx
  on public.event_logging (session_id)
  where session_id is not null;

-- Supports the dashboard's permission-group filter (`meta->'permission_groups' ?| $1`).
create index if not exists event_logging_meta_permission_groups_idx
  on public.event_logging using gin ((meta -> 'permission_groups'));

-- No policies: reads and writes go through the service-role client, which bypasses RLS.
-- Enabling RLS with zero policies is what makes anon/authenticated see nothing at all.
alter table public.event_logging enable row level security;
