-- Runtime feature toggles, read through `~/lib/settings/settings-service` (30s cache, falls back to
-- the caller's default when a row is missing). Service-role only: there are no policies, so anon and
-- authenticated roles see nothing.

create table if not exists public.settings (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  value text,
  default_value text,
  value_type text not null check (value_type in ('boolean', 'string', 'number')),
  description text,
  allowed_values text[] default null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on column public.settings.default_value is
  'What readers fall back to when value is null (and what a "reset to default" restores).';

alter table public.settings enable row level security;

-- Permission enforcement switch. false = shadow mode: verdicts are logged and would-be denials are
-- recorded in audit_logs, but nobody is denied. Flip to true to enforce.
insert into public.settings (key, value, default_value, value_type, description)
values (
  'PERMISSIONS_ENFORCED',
  'false',
  'false',
  'boolean',
  'Enforce permission checks. false = shadow mode (log and audit, never deny).'
)
on conflict (key) do nothing;
