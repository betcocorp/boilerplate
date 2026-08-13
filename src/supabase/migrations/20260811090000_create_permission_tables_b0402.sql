-- =============================================================================
-- B0-402 (epic B0-401): port the c360 permissions system into bex-2.0.
--
-- 1:1 Postgres port of c360's Snowflake CRM_APP permission tables
-- (c360/lib/db/migrations/2026-03-17_permissions_tables___NO.sql), plus an
-- `app_user` table standing in for CRM_APP.USER (which that migration assumed
-- already existed). Ids stay `text`: c360 USER_IDs are 18-char Salesforce
-- strings (a handful of legacy rows are uuid-shaped strings), NOT uuids.
--
-- Snowflake -> Postgres type mapping: VARCHAR/STRING -> text,
-- TIMESTAMP_TZ -> timestamptz, BOOLEAN -> boolean, CURRENT_TIMESTAMP() -> now().
-- Snowflake identifiers are UPPERCASE; here they are lowercase snake_case.
-- Soft delete via deleted_at throughout — nothing is hard-deleted.
--
-- RLS is enabled with NO policies on all five tables (deny-all): the only
-- reader is the service role, which bypasses RLS. This matches the posture of
-- every other table in the bex public schema.
--
-- Seed data (permissions, groups, assignments) lands separately in B0-403.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- permission: every permission, keyed by the selector used in code / UI
-- ---------------------------------------------------------------------------
create table if not exists public.permission (
  permission_id text        primary key,
  selector      text        not null unique,
  description   text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

comment on table public.permission is 'B0-402: port of CRM_APP.PERMISSION. One row per permission; `selector` is the dotted string checked in app code (e.g. navigation.sidebar.admin). Soft-deleted via deleted_at.';

-- ---------------------------------------------------------------------------
-- permission_group: named groups of permissions (roles)
-- ---------------------------------------------------------------------------
create table if not exists public.permission_group (
  permission_group_id text        primary key,
  selector            text        not null unique,
  description         text,
  start_at            timestamptz,
  end_at              timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

comment on table public.permission_group is 'B0-402: port of CRM_APP.PERMISSION_GROUP. Role-like grouping of permissions; `selector` is the group name (e.g. it-admin). Soft-deleted via deleted_at.';

-- ---------------------------------------------------------------------------
-- group_permission: pivot — which permissions belong to which group
-- ---------------------------------------------------------------------------
create table if not exists public.group_permission (
  group_permission_id text        primary key,
  permission_id       text        not null references public.permission (permission_id),
  permission_group_id text        not null references public.permission_group (permission_group_id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz,
  constraint group_permission_group_permission_key unique (permission_group_id, permission_id)
);

-- The unique constraint already indexes (permission_group_id, …); the other FK
-- needs its own index so permission-side lookups/deletes are not seq scans.
create index if not exists group_permission_permission_id_idx
  on public.group_permission (permission_id);

comment on table public.group_permission is 'B0-402: port of CRM_APP.GROUP_PERMISSION. Pivot between permission_group and permission. Soft-deleted via deleted_at.';

-- ---------------------------------------------------------------------------
-- app_user: replacement for CRM_APP.USER, keyed on the same c360 USER_IDs
-- ---------------------------------------------------------------------------
create table if not exists public.app_user (
  user_id            text        primary key,
  user_name          text,
  first_name         text,
  last_name          text,
  name               text,
  email              text,
  phone              text,
  title              text,
  department         text,
  division           text,
  betco_company_id   text,
  user_security_role text,
  is_active          boolean     not null default true,
  is_salesperson     boolean     not null default false,
  edit_all           boolean     not null default false,
  has_user_switcher  boolean     not null default false,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  deleted_at         timestamptz
);

-- Email is the login identity coming from Azure AD, so uniqueness is
-- case-insensitive. Null emails stay allowed (nulls are distinct in a unique index).
create unique index if not exists app_user_email_lower_key
  on public.app_user (lower(email));

comment on table public.app_user is 'B0-402: replacement for CRM_APP.USER. user_id is the c360 USER_ID (18-char Salesforce string), the same key user_group_permission.user_id uses. Soft-deleted via deleted_at.';
comment on column public.app_user.has_user_switcher is 'Whether this user may use the global user switcher (mimic another user).';
comment on column public.app_user.edit_all is 'Whether this user may edit records they do not own.';
comment on column public.app_user.user_security_role is 'c360 USER_SECURITY_ROLE, transcribed as stored; not derived from permissions.';

-- ---------------------------------------------------------------------------
-- user_group_permission: user assignments to groups or direct permissions
-- entity_type = 'PERMISSION_GROUP' -> entity_id is a permission_group_id
-- entity_type = 'PERMISSION'       -> entity_id is a permission_id
-- Polymorphic entity_id, so (as in c360) there is no FK on entity_id, and
-- user_id is intentionally unconstrained so assignments can exist for users
-- not yet mirrored into app_user.
-- ---------------------------------------------------------------------------
create table if not exists public.user_group_permission (
  user_group_permission_id text        primary key,
  user_id                  text        not null,
  entity_type              text        not null,
  entity_id                text        not null,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  deleted_at               timestamptz,
  constraint user_group_permission_entity_type_check
    check (entity_type in ('PERMISSION_GROUP', 'PERMISSION')),
  constraint user_group_permission_user_entity_key
    unique (user_id, entity_type, entity_id)
);

-- Hot path: the permission bundle looks up all live assignments for one user.
create index if not exists user_group_permission_user_id_active_idx
  on public.user_group_permission (user_id)
  where deleted_at is null;

comment on table public.user_group_permission is 'B0-402: port of CRM_APP.USER_GROUP_PERMISSION. Polymorphic assignment of a user to a permission_group or directly to a permission (entity_type decides how entity_id is read). Soft-deleted via deleted_at.';

-- ---------------------------------------------------------------------------
-- Deny-all RLS: service-role access only (no policies by design)
-- ---------------------------------------------------------------------------
alter table public.permission             enable row level security;
alter table public.permission_group       enable row level security;
alter table public.group_permission       enable row level security;
alter table public.app_user               enable row level security;
alter table public.user_group_permission  enable row level security;

-- ---------------------------------------------------------------------------
-- get_user_permission_bundle: 1:1 port of the CTE in c360's
-- userController.getPermissionsForUser (`sqlCombinedSelector`). Returns the
-- group-derived ∪ direct permission selectors tagged 'P', plus the user's
-- permission-group membership selectors tagged 'G', in one round trip.
--
-- The controller's second variant (`sqlCombinedIdentifier`) is deliberately NOT
-- ported: it is a Snowflake-legacy fallback for an older IDENTIFIER column and
-- it drops soft-delete guards.
--
-- UNION (dedupes) between group and direct permissions, UNION ALL for the final
-- P/G concatenation — same as the original. CTE columns are named `sel` so they
-- can never be ambiguous with the `selector` OUT parameter.
--
-- security invoker (the project default since B0-284) + explicit search_path.
-- DROP then CREATE, never CREATE OR REPLACE with a changed signature.
-- ---------------------------------------------------------------------------
drop function if exists public.get_user_permission_bundle(text);

create function public.get_user_permission_bundle(p_user_id text)
returns table (row_kind text, selector text)
language sql
stable
set search_path = public
as $$
  with group_perms as (
    select distinct p.selector as sel
    from public.user_group_permission ugp
    join public.group_permission gp on ugp.entity_id = gp.permission_group_id and (gp.deleted_at is null)
    join public.permission p on gp.permission_id = p.permission_id and (p.deleted_at is null)
    where ugp.user_id = p_user_id and ugp.entity_type = 'PERMISSION_GROUP' and (ugp.deleted_at is null)
  ),
  direct_perms as (
    select distinct p.selector as sel
    from public.user_group_permission ugp
    join public.permission p on ugp.entity_id = p.permission_id and (p.deleted_at is null)
    where ugp.user_id = p_user_id and ugp.entity_type = 'PERMISSION' and (ugp.deleted_at is null)
  ),
  all_permission_selectors as (
    select sel from group_perms
    union
    select sel from direct_perms
  ),
  group_membership_selectors as (
    select distinct pgr.selector as sel
    from public.user_group_permission ugp
    join public.permission_group pgr
      on ugp.entity_id = pgr.permission_group_id
      and (pgr.deleted_at is null)
    where ugp.user_id = p_user_id
      and ugp.entity_type = 'PERMISSION_GROUP'
      and (ugp.deleted_at is null)
  )
  select 'P'::text as row_kind, aps.sel as selector from all_permission_selectors aps
  union all
  select 'G'::text as row_kind, gms.sel as selector from group_membership_selectors gms;
$$;

comment on function public.get_user_permission_bundle(text) is 'B0-402: consolidated permission bundle for one c360 USER_ID. Rows are (row_kind, selector): ''P'' = effective permission selector (group-derived ∪ direct), ''G'' = permission-group membership selector. Port of c360 userController.getPermissionsForUser.';

revoke all on function public.get_user_permission_bundle(text) from public, anon, authenticated;
grant execute on function public.get_user_permission_bundle(text) to service_role;
