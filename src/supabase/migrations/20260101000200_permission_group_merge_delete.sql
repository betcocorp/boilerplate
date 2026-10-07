-- =============================================================================
-- B0-411 (epic B0-401): permission-group merge & delete as transactional
-- Postgres functions.
--
-- Port of c360's snowflake-api `lib/permissionGroupMerge.ts` +
-- `lib/permissionGroupDelete.ts`, which build SQL statement lists that the
-- Express controller feeds to `snowflakeConnection.executeTransaction()`.
-- supabase-js has no client-side transaction, so each operation becomes ONE
-- Postgres function invoked via `rpc()`: a function body runs inside a single
-- implicit transaction, so copy-members + copy-permissions + optional source
-- soft-delete (merge), and the cascading pivot cleanup (delete-with-resources),
-- either all commit or all roll back.
--
-- The audit row is written INSIDE these functions, into bex's existing
-- `public.audit_logs` (event_type `permission_group.merged` /
-- `permission_group.deleted`), rather than through `~/lib/audit/audit-log`
-- afterwards. That is deliberate and matches c360, where the EVENT_LOGGING
-- insert was the last statement of the same transaction: it makes a committed
-- merge/delete without an audit row impossible. `writeAuditLog` swallows its
-- own errors, so calling it after the rpc could silently lose the record of a
-- privilege change. Trade-off: audit payload construction lives in SQL here
-- instead of in the one TypeScript helper, and an audit-insert failure aborts
-- the whole mutation.
--
-- Conventions follow the B0-402 migration: `security invoker` (project default
-- since B0-284) + explicit `set search_path = public`, and DROP-then-CREATE
-- rather than CREATE OR REPLACE so a changed parameter list can never leave a
-- second overload behind (which makes `rpc()` fail with "could not choose the
-- best candidate function").
--
-- Ids: like every other insert path against these tables, the `text` primary
-- keys have no database default, so they are generated here with
-- `gen_random_uuid()::text` — the same shape c360 produced with
-- `UUID_STRING()` / `crypto.randomUUID()`.
--
-- DE-DUPLICATION / REVIVE (deliberate divergence from the literal c360 SQL):
-- c360's merge de-dups with `NOT EXISTS (... AND tgt.DELETED_AT IS NULL)`,
-- i.e. it only skips members/permissions that are *live* in the target, and
-- relies on Snowflake not enforcing UNIQUE. Here the soft-deleted target row
-- still occupies the `user_group_permission (user_id, entity_type, entity_id)`
-- / `group_permission (permission_group_id, permission_id)` unique slot, so a
-- plain insert would raise, and `on conflict do nothing` would silently drop a
-- member the merge is supposed to grant. Such a row is therefore REVIVED
-- (`deleted_at` cleared) instead of inserted. The observable outcome is
-- identical to c360 (the member/permission ends up live on the target) and the
-- reported counts still mean "rows the merge added to the target".
-- =============================================================================

-- ---------------------------------------------------------------------------
-- preview_permission_group_merge: read-only dry run. Port of
-- buildMemberMergePreviewStatement / buildPermissionMergePreviewStatement.
-- Counts live source members/permissions that have no LIVE target row — which
-- is exactly the set merge_permission_groups revives or inserts, so preview
-- and merge can never disagree.
-- Selectors come back null when a group is missing or soft-deleted, so the
-- caller can tell target-not-found from source-not-found.
-- ---------------------------------------------------------------------------
drop function if exists public.preview_permission_group_merge(text, text);

create function public.preview_permission_group_merge(
  p_target_group_id text,
  p_source_group_id text
)
returns table (
  users_to_add integer,
  permissions_to_add integer,
  source_selector text,
  target_selector text
)
language sql
stable
set search_path = public
as $$
  select
    (
      select count(*)::integer
      from (
        select distinct ugp.user_id
        from public.user_group_permission ugp
        where ugp.entity_type = 'PERMISSION_GROUP'
          and ugp.entity_id = p_source_group_id
          and ugp.deleted_at is null
      ) src
      where not exists (
        select 1
        from public.user_group_permission tgt
        where tgt.entity_type = 'PERMISSION_GROUP'
          and tgt.entity_id = p_target_group_id
          and tgt.user_id = src.user_id
          and tgt.deleted_at is null
      )
    ),
    (
      select count(*)::integer
      from (
        select distinct gp.permission_id
        from public.group_permission gp
        where gp.permission_group_id = p_source_group_id
          and gp.deleted_at is null
      ) src
      where not exists (
        select 1
        from public.group_permission tgt
        where tgt.permission_group_id = p_target_group_id
          and tgt.permission_id = src.permission_id
          and tgt.deleted_at is null
      )
    ),
    (
      select pg.selector
      from public.permission_group pg
      where pg.permission_group_id = p_source_group_id and pg.deleted_at is null
    ),
    (
      select pg.selector
      from public.permission_group pg
      where pg.permission_group_id = p_target_group_id and pg.deleted_at is null
    );
$$;

comment on function public.preview_permission_group_merge(text, text) is 'B0-411: read-only merge dry run. Returns how many members/permissions would be added to the target after de-dup, plus both selectors (null when the group is missing or soft-deleted). Port of c360 permissionGroupMerge preview statements.';

revoke all on function public.preview_permission_group_merge(text, text) from public, anon, authenticated;
grant execute on function public.preview_permission_group_merge(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- merge_permission_groups: copy the source group's members and permissions
-- into the target (de-duplicated), optionally soft-delete the source, and
-- write the audit row — atomically. Port of
-- permissionController.postMergePermissionGroup.
--
-- Validation errors and not-found raise, so PostgREST reports them and nothing
-- is committed. Messages are the c360 strings verbatim; the repository passes
-- them straight through to its `error` field.
-- ---------------------------------------------------------------------------
drop function if exists public.merge_permission_groups(text, text, boolean, text, text, text, text);

create function public.merge_permission_groups(
  p_target_group_id text,
  p_source_group_id text,
  p_delete_source boolean,
  p_actor_user_id text,
  p_actor_email text,
  p_actor_name text,
  p_trace_id text
)
returns table (
  users_merged integer,
  permissions_merged integer,
  deleted_source boolean,
  source_selector text,
  target_selector text,
  prior_target_user_count integer,
  prior_target_permission_count integer,
  prior_source_user_count integer,
  prior_source_permission_count integer
)
language plpgsql
volatile
set search_path = public
as $$
declare
  v_target_id text := btrim(coalesce(p_target_group_id, ''));
  v_source_id text := btrim(coalesce(p_source_group_id, ''));
  v_delete_source boolean := coalesce(p_delete_source, true);
  v_target_selector text;
  v_source_selector text;
  v_users_merged integer := 0;
  v_permissions_merged integer := 0;
  v_prior_target_users integer := 0;
  v_prior_target_perms integer := 0;
  v_prior_source_users integer := 0;
  v_prior_source_perms integer := 0;
begin
  -- Defensive re-check of what the repository already validated (invalid_parameter_value).
  if v_target_id = '' then
    raise exception 'targetGroupId required' using errcode = '22023';
  end if;
  if v_source_id = '' then
    raise exception 'sourceGroupId required' using errcode = '22023';
  end if;
  if v_target_id = v_source_id then
    raise exception 'A group cannot be merged into itself. Choose a different source and target group.'
      using errcode = '22023';
  end if;

  select pg.selector into v_target_selector
  from public.permission_group pg
  where pg.permission_group_id = v_target_id and pg.deleted_at is null;
  if v_target_selector is null then
    raise exception 'Target permission group not found' using errcode = 'P0002';
  end if;

  select pg.selector into v_source_selector
  from public.permission_group pg
  where pg.permission_group_id = v_source_id and pg.deleted_at is null;
  if v_source_selector is null then
    raise exception 'Source permission group not found' using errcode = 'P0002';
  end if;

  -- Prior (live) counts, captured before anything changes, for the audit payload.
  select count(distinct ugp.user_id)::integer into v_prior_target_users
  from public.user_group_permission ugp
  where ugp.entity_type = 'PERMISSION_GROUP'
    and ugp.entity_id = v_target_id
    and ugp.deleted_at is null;

  select count(distinct gp.permission_id)::integer into v_prior_target_perms
  from public.group_permission gp
  where gp.permission_group_id = v_target_id and gp.deleted_at is null;

  select count(distinct ugp.user_id)::integer into v_prior_source_users
  from public.user_group_permission ugp
  where ugp.entity_type = 'PERMISSION_GROUP'
    and ugp.entity_id = v_source_id
    and ugp.deleted_at is null;

  select count(distinct gp.permission_id)::integer into v_prior_source_perms
  from public.group_permission gp
  where gp.permission_group_id = v_source_id and gp.deleted_at is null;

  -- Members. `revived` and `inserted` are data-modifying CTEs of one statement:
  -- they share a snapshot, so `inserted`'s NOT EXISTS cannot see the revival —
  -- which is correct, because a revived row already exists (any deleted_at) and
  -- is therefore excluded from the insert. The two sets are disjoint.
  with source_members as (
    select distinct ugp.user_id
    from public.user_group_permission ugp
    where ugp.entity_type = 'PERMISSION_GROUP'
      and ugp.entity_id = v_source_id
      and ugp.deleted_at is null
  ),
  revived as (
    update public.user_group_permission tgt
    set deleted_at = null, updated_at = now()
    where tgt.entity_type = 'PERMISSION_GROUP'
      and tgt.entity_id = v_target_id
      and tgt.deleted_at is not null
      and tgt.user_id in (select sm.user_id from source_members sm)
    returning 1
  ),
  inserted as (
    insert into public.user_group_permission
      (user_group_permission_id, user_id, entity_type, entity_id)
    select gen_random_uuid()::text, sm.user_id, 'PERMISSION_GROUP', v_target_id
    from source_members sm
    where not exists (
      select 1
      from public.user_group_permission tgt
      where tgt.entity_type = 'PERMISSION_GROUP'
        and tgt.entity_id = v_target_id
        and tgt.user_id = sm.user_id
    )
    returning 1
  )
  select ((select count(*) from revived) + (select count(*) from inserted))::integer
  into v_users_merged;

  -- Permissions, same shape on group_permission (permission_group_id, permission_id).
  with source_perms as (
    select distinct gp.permission_id
    from public.group_permission gp
    where gp.permission_group_id = v_source_id
      and gp.deleted_at is null
  ),
  revived as (
    update public.group_permission tgt
    set deleted_at = null, updated_at = now()
    where tgt.permission_group_id = v_target_id
      and tgt.deleted_at is not null
      and tgt.permission_id in (select sp.permission_id from source_perms sp)
    returning 1
  ),
  inserted as (
    insert into public.group_permission
      (group_permission_id, permission_id, permission_group_id)
    select gen_random_uuid()::text, sp.permission_id, v_target_id
    from source_perms sp
    where not exists (
      select 1
      from public.group_permission tgt
      where tgt.permission_group_id = v_target_id
        and tgt.permission_id = sp.permission_id
    )
    returning 1
  )
  select ((select count(*) from revived) + (select count(*) from inserted))::integer
  into v_permissions_merged;

  -- Port of buildSoftDeleteSourceStatements: member links, permission links,
  -- then the group row. Recoverable (deleted_at), not a hard delete.
  if v_delete_source then
    update public.user_group_permission
    set deleted_at = now(), updated_at = now()
    where entity_type = 'PERMISSION_GROUP'
      and entity_id = v_source_id
      and deleted_at is null;

    update public.group_permission
    set deleted_at = now(), updated_at = now()
    where permission_group_id = v_source_id
      and deleted_at is null;

    update public.permission_group
    set deleted_at = now(), updated_at = now()
    where permission_group_id = v_source_id
      and deleted_at is null;
  end if;

  insert into public.audit_logs (event_type, payload)
  values (
    'permission_group.merged',
    jsonb_build_object(
      'action', 'permission_group.merge',
      'trace_id', p_trace_id,
      'actor_user_id', p_actor_user_id,
      'actor_email', p_actor_email,
      'actor_name', p_actor_name,
      'source_group_id', v_source_id,
      'source_selector', v_source_selector,
      'target_group_id', v_target_id,
      'target_selector', v_target_selector,
      'users_merged', v_users_merged,
      'permissions_merged', v_permissions_merged,
      'deleted_source', v_delete_source,
      'source_delete_mode', case when v_delete_source then 'soft' else null end,
      'prior_target_user_count', v_prior_target_users,
      'prior_target_permission_count', v_prior_target_perms,
      'prior_source_user_count', v_prior_source_users,
      'prior_source_permission_count', v_prior_source_perms
    )
  );

  return query
  select
    v_users_merged,
    v_permissions_merged,
    v_delete_source,
    v_source_selector,
    v_target_selector,
    v_prior_target_users,
    v_prior_target_perms,
    v_prior_source_users,
    v_prior_source_perms;
end;
$$;

comment on function public.merge_permission_groups(text, text, boolean, text, text, text, text) is 'B0-411: atomically merge one permission group into another — copy members + permissions (de-duplicated, reviving soft-deleted target rows), optionally soft-delete the source, and insert the permission_group.merged audit_logs row. Port of c360 permissionController.postMergePermissionGroup + permissionGroupMerge.ts.';

revoke all on function public.merge_permission_groups(text, text, boolean, text, text, text, text) from public, anon, authenticated;
grant execute on function public.merge_permission_groups(text, text, boolean, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- delete_permission_group_with_resources: hard-delete a group and every pivot
-- row that references it, plus the audit row — atomically. Port of
-- permissionController.deletePermissionGroup + buildHardDeleteGroupStatements.
--
-- The group lookup ignores soft-delete state on purpose, so a group already
-- soft-deleted by a merge can still be purged. Children go first (the
-- group_permission FK to permission_group makes that order required here,
-- unlike Snowflake where FKs are informational).
-- ---------------------------------------------------------------------------
drop function if exists public.delete_permission_group_with_resources(text, text, text, text, text);

create function public.delete_permission_group_with_resources(
  p_group_id text,
  p_actor_user_id text,
  p_actor_email text,
  p_actor_name text,
  p_trace_id text
)
returns table (
  deleted_selector text,
  members_removed integer,
  permissions_removed integer,
  group_removed boolean
)
language plpgsql
volatile
set search_path = public
as $$
declare
  v_group_id text := btrim(coalesce(p_group_id, ''));
  v_selector text;
  v_found boolean := false;
  v_members_removed integer := 0;
  v_permissions_removed integer := 0;
  v_group_removed integer := 0;
begin
  if v_group_id = '' then
    raise exception 'groupId required' using errcode = '22023';
  end if;

  select pg.selector, true into v_selector, v_found
  from public.permission_group pg
  where pg.permission_group_id = v_group_id;
  if not coalesce(v_found, false) then
    raise exception 'Permission group not found' using errcode = 'P0002';
  end if;

  with removed as (
    delete from public.user_group_permission
    where entity_type = 'PERMISSION_GROUP' and entity_id = v_group_id
    returning 1
  )
  select count(*)::integer into v_members_removed from removed;

  with removed as (
    delete from public.group_permission
    where permission_group_id = v_group_id
    returning 1
  )
  select count(*)::integer into v_permissions_removed from removed;

  with removed as (
    delete from public.permission_group
    where permission_group_id = v_group_id
    returning 1
  )
  select count(*)::integer into v_group_removed from removed;

  insert into public.audit_logs (event_type, payload)
  values (
    'permission_group.deleted',
    jsonb_build_object(
      'action', 'permission_group.delete',
      'trace_id', p_trace_id,
      'actor_user_id', p_actor_user_id,
      'actor_email', p_actor_email,
      'actor_name', p_actor_name,
      'group_id', v_group_id,
      'selector', v_selector,
      'members_removed', v_members_removed,
      'permissions_removed', v_permissions_removed,
      'delete_mode', 'hard'
    )
  );

  return query
  select v_selector, v_members_removed, v_permissions_removed, v_group_removed > 0;
end;
$$;

comment on function public.delete_permission_group_with_resources(text, text, text, text, text) is 'B0-411: atomically hard-delete a permission group, its member links and its permission links, and insert the permission_group.deleted audit_logs row. Port of c360 permissionController.deletePermissionGroup + permissionGroupDelete.ts.';

revoke all on function public.delete_permission_group_with_resources(text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.delete_permission_group_with_resources(text, text, text, text, text) to service_role;
