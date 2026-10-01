'use server';

/**
 * B0-404 (epic B0-401): Supabase-backed data access for the ported permissions system.
 *
 * This module replaces c360's `lib/api/requests.ts` permission/user functions, which `fetch` the
 * Express `node-api` and get Snowflake `CRM_APP.*` rows back. Every exported signature and wire
 * shape is preserved so RSC pages, the ported helpers, and the admin UI (B0-410) consume it
 * unchanged. Server-side semantics are ports of c360's `permissionController.ts` /
 * `userController.ts`.
 *
 * Two rules hold everywhere in here:
 *
 * 1. **This is the only place snake_case becomes UPPERCASE.** Supabase columns are lowercase
 *    (`permission_id`, `selector`, …); the wire shape the helpers/UI expect is UPPERCASE
 *    (`PERMISSION_ID`, `SELECTOR`, …). The mappers below are the single boundary. `~/types/
 *    permissions.ts` and `~/types/User.ts` intentionally hold the UPPERCASE shape.
 *
 * 2. **Errors are swallowed, not thrown.** c360's client wrappers log and return an
 *    empty-but-valid envelope so a permissions outage degrades to "no access" instead of a crash;
 *    `getPermissionsForUser` in particular is called from cookie/session paths that must not throw.
 *
 * Ids: the five permission tables have `text primary key` with **no database default** (a faithful
 * port of Snowflake, which has none either), so every insert path generates its id here — matching
 * c360's controllers, which call `crypto.randomUUID()`.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { z } from 'zod';

import { AUTH_USER_DETAILS_COOKIE } from '~/lib/cookies-config';
import {
  validateGroupId,
  validateMergeIds,
} from '~/lib/permissions/group-merge';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { Permission, PermissionGroup } from '~/types/permissions';
import type User from '~/types/User';

// ---------------------------------------------------------------------------
// Row shapes (Supabase, lowercase) -> wire shapes (UPPERCASE)
// ---------------------------------------------------------------------------

type PermissionRow = {
  permission_id: string;
  selector: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
};

type PermissionGroupRow = {
  permission_group_id: string;
  selector: string;
  description: string | null;
  start_at?: string | null;
  end_at?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
};

type AppUserRow = {
  user_id: string;
  user_name?: string | null;
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  title?: string | null;
  department?: string | null;
  division?: string | null;
  is_active?: boolean | null;
  is_salesperson?: boolean | null;
  betco_company_id?: string | null;
  edit_all?: boolean | null;
  has_user_switcher?: boolean | null;
  user_security_role?: string | null;
};

const PERMISSION_COLUMNS =
  'permission_id, selector, description, created_at, updated_at, deleted_at';
const PERMISSION_GROUP_COLUMNS =
  'permission_group_id, selector, description, start_at, end_at, created_at, updated_at, deleted_at';
/**
 * c360's `listUsers` selects `USER_NAME AS NAME` and coalesces the two booleans; `app_user` carries
 * both `user_name` and `name`, so the mapper prefers `user_name` (the CRM_APP.USER column being
 * ported) and falls back to `name`.
 */
const APP_USER_COLUMNS =
  'user_id, user_name, name, email, phone, title, department, division, is_active, is_salesperson, betco_company_id, edit_all, has_user_switcher, user_security_role';

function toPermission(row: PermissionRow): Permission {
  return {
    PERMISSION_ID: row.permission_id,
    SELECTOR: row.selector,
    DESCRIPTION: row.description,
    CREATED_AT: row.created_at,
    UPDATED_AT: row.updated_at,
    DELETED_AT: row.deleted_at ?? null,
  };
}

function toPermissionGroup(row: PermissionGroupRow): PermissionGroup {
  return {
    PERMISSION_GROUP_ID: row.permission_group_id,
    SELECTOR: row.selector,
    DESCRIPTION: row.description,
    START_AT: row.start_at ?? null,
    END_AT: row.end_at ?? null,
    CREATED_AT: row.created_at,
    UPDATED_AT: row.updated_at,
    DELETED_AT: row.deleted_at ?? null,
  };
}

/**
 * `User.NAME` / `User.EMAIL` are non-nullable in the wire type but the columns are nullable, so a
 * missing value becomes '' rather than null (both are falsy to every consumer).
 */
function toUser(row: AppUserRow): User {
  return {
    USER_ID: row.user_id,
    NAME: row.user_name ?? row.name ?? '',
    EMAIL: row.email ?? '',
    PHONE: row.phone ?? null,
    TITLE: row.title ?? null,
    DEPARTMENT: row.department ?? null,
    DIVISION: row.division ?? null,
    IS_ACTIVE: row.is_active ?? false,
    BETCO_COMPANY_ID: row.betco_company_id ?? undefined,
    IS_SALESPERSON: row.is_salesperson ?? false,
    EDIT_ALL: row.edit_all ?? false,
    HAS_USER_SWITCHER: row.has_user_switcher ?? false,
    USER_SECURITY_ROLE: row.user_security_role ?? null,
  };
}

/** Trim, drop blanks, de-duplicate — the id-list hygiene c360's controllers do inline. */
function normalizeIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const trimmed = ids
    .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
    .map((id) => id.trim());
  return [...new Set(trimmed)];
}

function optionalText(value: unknown): string | null {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed === '' ? null : trimmed;
}

// ---------------------------------------------------------------------------
// Users
// ---------------------------------------------------------------------------

/**
 * All users, for dropdowns. Port of c360 `getUsers()` (GET /dropdown/allusers ->
 * `userController.getUsers`). c360 derives IS_SALESPERSON from a join on CRM_APP.USER_SLSPERID;
 * bex stores it directly on `app_user`.
 */
export async function getUsers(): Promise<{ data: User[] }> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('app_user')
      .select(APP_USER_COLUMNS)
      .is('deleted_at', null)
      .order('user_name', { ascending: true });
    if (error) throw error;
    return { data: (data ?? []).map((row) => toUser(row as AppUserRow)) };
  } catch (error) {
    console.error('Error fetching users:', error);
    return { data: [] };
  }
}

/**
 * One user by email. Port of c360 `getUser(email)` (GET /users/:email ->
 * `userController.getUserByEmail`): case-insensitive email match, active users first, at most one
 * row. `ilike` with no wildcards is Postgres case-insensitive equality, which is what the
 * `LOWER(TRIM(EMAIL)) = LOWER(TRIM(?))` predicate resolves to (and `app_user` has a unique index on
 * `lower(email)`).
 */
export async function getUser(
  email: string,
): Promise<{ success: boolean; data: User[]; rowcount: number }> {
  try {
    const trimmed = String(email ?? '').trim();
    if (!trimmed) return { success: false, data: [], rowcount: 0 };
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('app_user')
      .select(APP_USER_COLUMNS)
      .is('deleted_at', null)
      .ilike('email', trimmed)
      .order('is_active', { ascending: false })
      .order('user_id', { ascending: true })
      .limit(1);
    if (error) throw error;
    const users = (data ?? []).map((row) => toUser(row as AppUserRow));
    return { success: true, data: users, rowcount: users.length };
  } catch (error) {
    console.error('Error fetching user:', error);
    return { success: false, data: [], rowcount: 0 };
  }
}

/** Rows returned by `public.get_user_permission_bundle`. */
const permissionBundleRowsSchema = z.array(
  z.object({ row_kind: z.string(), selector: z.string() }),
);

/**
 * Consolidated permissions for a user. Port of c360 `getPermissionsForUser(userId)` (GET
 * /users/permissions -> `userController.getPermissionsForUser`).
 *
 * One `get_user_permission_bundle` round trip; rows tagged `'P'` are effective permission selectors
 * (group-derived ∪ direct), rows tagged `'G'` are permission-group membership selectors — the same
 * ROW_KIND split the Snowflake CTE produced. Never throws: this runs on cookie/session paths.
 */
export async function getPermissionsForUser(
  userId: string,
): Promise<{ permissions: string[]; permission_groups: string[] }> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase.rpc('get_user_permission_bundle', {
      p_user_id: userId,
    });
    if (error) throw error;
    const rows = permissionBundleRowsSchema.safeParse(data ?? []);
    if (!rows.success) {
      console.error(
        'Error fetching permissions for user: unexpected bundle shape',
        rows.error.issues,
      );
      return { permissions: [], permission_groups: [] };
    }
    const permissions: string[] = [];
    const permission_groups: string[] = [];
    for (const row of rows.data) {
      if (row.row_kind === 'P') permissions.push(row.selector);
      else if (row.row_kind === 'G') permission_groups.push(row.selector);
    }
    return { permissions, permission_groups };
  } catch (error) {
    console.error('Error fetching permissions for user:', error);
    return { permissions: [], permission_groups: [] };
  }
}

// ---------------------------------------------------------------------------
// Permissions (admin)
// ---------------------------------------------------------------------------

/** Port of c360 `getPermissionsList()` / `permissionController.listPermissions`. */
export async function getPermissionsList(): Promise<{
  success: boolean;
  data: Permission[];
}> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('permission')
      .select(PERMISSION_COLUMNS)
      .is('deleted_at', null)
      .order('selector', { ascending: true });
    if (error) throw error;
    return {
      success: true,
      data: (data ?? []).map((row) => toPermission(row as PermissionRow)),
    };
  } catch (error) {
    console.error('Error fetching permissions list:', error);
    return { success: false, data: [] };
  }
}

/**
 * One permission plus the groups that contain it and the users who hold it. Port of c360
 * `getPermission(permissionId)` / `permissionController.getPermissionById`.
 *
 * `user_group_permission.user_id` has no FK (`entity_id` is polymorphic), so the user lookups are a
 * two-step id fetch + `app_user` query rather than an embedded select. As in c360, only active
 * users are returned.
 */
export async function getPermission(permissionId: string): Promise<{
  success: boolean;
  data: Permission | null;
  groups: PermissionGroup[];
  usersDirect: User[];
  usersViaGroups: User[];
}> {
  const empty = {
    success: false,
    data: null,
    groups: [] as PermissionGroup[],
    usersDirect: [] as User[],
    usersViaGroups: [] as User[],
  };
  try {
    const id = String(permissionId ?? '').trim();
    if (!id) return empty;
    const supabase = getSupabaseServiceRoleClient();

    const [permissionRes, groupLinkRes, directLinkRes] = await Promise.all([
      supabase
        .from('permission')
        .select(PERMISSION_COLUMNS)
        .eq('permission_id', id)
        .is('deleted_at', null)
        .maybeSingle(),
      supabase
        .from('group_permission')
        .select(`permission_group:permission_group!inner(${PERMISSION_GROUP_COLUMNS})`)
        .eq('permission_id', id)
        .is('deleted_at', null)
        .is('permission_group.deleted_at', null),
      supabase
        .from('user_group_permission')
        .select('user_id')
        .eq('entity_type', 'PERMISSION')
        .eq('entity_id', id)
        .is('deleted_at', null),
    ]);
    if (permissionRes.error) throw permissionRes.error;
    if (groupLinkRes.error) throw groupLinkRes.error;
    if (directLinkRes.error) throw directLinkRes.error;

    const permissionRow = permissionRes.data as PermissionRow | null;
    if (!permissionRow) return empty;

    const groups = ((groupLinkRes.data ?? []) as unknown as {
      permission_group: PermissionGroupRow | null;
    }[])
      .map((link) => link.permission_group)
      .filter((row): row is PermissionGroupRow => row != null)
      .map(toPermissionGroup)
      .sort((a, b) => a.SELECTOR.localeCompare(b.SELECTOR));

    const groupIds = groups.map((group) => group.PERMISSION_GROUP_ID);
    const viaGroupLinks = groupIds.length
      ? await supabase
          .from('user_group_permission')
          .select('user_id')
          .eq('entity_type', 'PERMISSION_GROUP')
          .in('entity_id', groupIds)
          .is('deleted_at', null)
      : { data: [] as { user_id: string }[], error: null };
    if (viaGroupLinks.error) throw viaGroupLinks.error;

    const [usersDirect, usersViaGroups] = await Promise.all([
      fetchActiveUsersByIds(
        supabase,
        (directLinkRes.data ?? []).map((row) => row.user_id),
      ),
      fetchActiveUsersByIds(
        supabase,
        (viaGroupLinks.data ?? []).map((row) => row.user_id),
      ),
    ]);

    return {
      success: true,
      data: toPermission(permissionRow),
      groups,
      usersDirect,
      usersViaGroups,
    };
  } catch (error) {
    console.error('Error fetching permission:', error);
    return empty;
  }
}

/**
 * Active users for a set of ids, ordered by name. De-duplicates ids (the c360 `usersViaGroups`
 * query used SELECT DISTINCT because one user can reach a permission through several groups).
 */
async function fetchActiveUsersByIds(
  supabase: ReturnType<typeof getSupabaseServiceRoleClient>,
  userIds: string[],
): Promise<User[]> {
  const ids = normalizeIds(userIds);
  if (!ids.length) return [];
  const { data, error } = await supabase
    .from('app_user')
    .select(APP_USER_COLUMNS)
    .in('user_id', ids)
    .eq('is_active', true)
    .is('deleted_at', null)
    .order('user_name', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => toUser(row as AppUserRow));
}

/** Port of c360 `permissionController.postPermission` (POST /permissions). */
export async function postPermission(payload: {
  selector: string;
  description?: string | null;
}): Promise<{ success: boolean; data?: Permission; error?: string }> {
  try {
    const selector = String(payload?.selector ?? '').trim();
    if (!selector) return { success: false, error: 'selector required' };
    const description = optionalText(payload?.description);
    const permissionId = randomUUID();
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('permission')
      .insert({
        permission_id: permissionId,
        selector,
        description,
      })
      .select(PERMISSION_COLUMNS)
      .single();
    if (error) throw error;
    return { success: true, data: toPermission(data as PermissionRow) };
  } catch (error) {
    console.error('Error creating permission:', error);
    return { success: false, error: 'Failed to create permission' };
  }
}

/** Port of c360 `putPermission(permissionId, payload)` / `permissionController.putPermission`. */
export async function putPermission(
  permissionId: string,
  payload: { selector: string; description?: string | null },
): Promise<{ success: boolean }> {
  try {
    const id = String(permissionId ?? '').trim();
    const selector = String(payload?.selector ?? '').trim();
    if (!id || !selector) return { success: false };
    const supabase = getSupabaseServiceRoleClient();
    // Scoped to live rows, so a soft-deleted permission 404s here as it does in c360.
    const { data, error } = await supabase
      .from('permission')
      .update({
        selector,
        description: optionalText(payload?.description),
        updated_at: new Date().toISOString(),
      })
      .eq('permission_id', id)
      .is('deleted_at', null)
      .select('permission_id');
    if (error) throw error;
    return { success: (data ?? []).length > 0 };
  } catch (error) {
    console.error('Error updating permission:', error);
    return { success: false };
  }
}

/** Port of c360 `deletePermission(permissionId)` — soft delete only. */
export async function deletePermission(
  permissionId: string,
): Promise<{ success: boolean }> {
  try {
    const id = String(permissionId ?? '').trim();
    if (!id) return { success: false };
    const now = new Date().toISOString();
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('permission')
      .update({ deleted_at: now, updated_at: now })
      .eq('permission_id', id)
      .is('deleted_at', null)
      .select('permission_id');
    if (error) throw error;
    return { success: (data ?? []).length > 0 };
  } catch (error) {
    console.error('Error deleting permission:', error);
    return { success: false };
  }
}

// ---------------------------------------------------------------------------
// Permission groups (admin)
// ---------------------------------------------------------------------------

/** Port of c360 `getPermissionGroupsList()` / `permissionController.listPermissionGroups`. */
export async function getPermissionGroupsList(): Promise<{
  success: boolean;
  data: PermissionGroup[];
}> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('permission_group')
      .select(PERMISSION_GROUP_COLUMNS)
      .is('deleted_at', null)
      .order('selector', { ascending: true });
    if (error) throw error;
    return {
      success: true,
      data: (data ?? []).map((row) => toPermissionGroup(row as PermissionGroupRow)),
    };
  } catch (error) {
    console.error('Error fetching permission groups list:', error);
    return { success: false, data: [] };
  }
}

/**
 * One group with its permissions and members. Port of c360 `getPermissionGroup(groupId)` /
 * `permissionController.getPermissionGroupById`.
 */
export async function getPermissionGroup(groupId: string): Promise<{
  success: boolean;
  data: PermissionGroup | null;
  permissions: Permission[];
  users: User[];
}> {
  const empty = {
    success: false,
    data: null,
    permissions: [] as Permission[],
    users: [] as User[],
  };
  try {
    const id = String(groupId ?? '').trim();
    if (!id) return empty;
    const supabase = getSupabaseServiceRoleClient();

    const [groupRes, permLinkRes, memberRes] = await Promise.all([
      supabase
        .from('permission_group')
        .select(PERMISSION_GROUP_COLUMNS)
        .eq('permission_group_id', id)
        .is('deleted_at', null)
        .maybeSingle(),
      supabase
        .from('group_permission')
        .select(`permission:permission!inner(${PERMISSION_COLUMNS})`)
        .eq('permission_group_id', id)
        .is('deleted_at', null)
        .is('permission.deleted_at', null),
      supabase
        .from('user_group_permission')
        .select('user_id')
        .eq('entity_type', 'PERMISSION_GROUP')
        .eq('entity_id', id)
        .is('deleted_at', null),
    ]);
    if (groupRes.error) throw groupRes.error;
    if (permLinkRes.error) throw permLinkRes.error;
    if (memberRes.error) throw memberRes.error;

    const groupRow = groupRes.data as PermissionGroupRow | null;
    if (!groupRow) return empty;

    const permissions = ((permLinkRes.data ?? []) as unknown as {
      permission: PermissionRow | null;
    }[])
      .map((link) => link.permission)
      .filter((row): row is PermissionRow => row != null)
      .map(toPermission)
      .sort((a, b) => a.SELECTOR.localeCompare(b.SELECTOR));

    const users = await fetchActiveUsersByIds(
      supabase,
      (memberRes.data ?? []).map((row) => row.user_id),
    );

    return {
      success: true,
      data: toPermissionGroup(groupRow),
      permissions,
      users,
    };
  } catch (error) {
    console.error('Error fetching permission group:', error);
    return empty;
  }
}

/** Port of c360 `permissionController.postPermissionGroup` (POST /permissions/groups). */
export async function postPermissionGroup(payload: {
  selector: string;
  description?: string | null;
  startAt?: string | null;
  endAt?: string | null;
}): Promise<{ success: boolean; data?: PermissionGroup; error?: string }> {
  try {
    const selector = String(payload?.selector ?? '').trim();
    if (!selector) return { success: false, error: 'selector required' };
    const groupId = randomUUID();
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('permission_group')
      .insert({
        permission_group_id: groupId,
        selector,
        description: optionalText(payload?.description),
        start_at: optionalText(payload?.startAt),
        end_at: optionalText(payload?.endAt),
      })
      .select(PERMISSION_GROUP_COLUMNS)
      .single();
    if (error) throw error;
    return { success: true, data: toPermissionGroup(data as PermissionGroupRow) };
  } catch (error) {
    console.error('Error creating permission group:', error);
    return { success: false, error: 'Failed to create permission group' };
  }
}

/**
 * Replace a group's members and permissions. Port of c360
 * `putGroupAssignments(groupId, userIds, permissionIds)` / `permissionController.putGroupAssignments`.
 *
 * c360 hard-deletes the group's pivot rows and re-inserts, which is what is done here: a soft delete
 * would leave the (user_id, entity_type, entity_id) / (permission_group_id, permission_id) unique
 * slots occupied and the re-insert would conflict.
 */
export async function putGroupAssignments(
  groupId: string,
  userIds: string[],
  permissionIds: string[],
): Promise<{ success: boolean }> {
  try {
    const id = String(groupId ?? '').trim();
    if (!id) return { success: false };
    const users = normalizeIds(userIds);
    const permissions = normalizeIds(permissionIds);
    const supabase = getSupabaseServiceRoleClient();

    const { data: group, error: groupError } = await supabase
      .from('permission_group')
      .select('permission_group_id')
      .eq('permission_group_id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (groupError) throw groupError;
    if (!group) return { success: false };

    const { error: deleteMembersError } = await supabase
      .from('user_group_permission')
      .delete()
      .eq('entity_type', 'PERMISSION_GROUP')
      .eq('entity_id', id);
    if (deleteMembersError) throw deleteMembersError;

    if (users.length) {
      const { error } = await supabase.from('user_group_permission').insert(
        users.map((userId) => ({
          user_group_permission_id: randomUUID(),
          user_id: userId,
          entity_type: 'PERMISSION_GROUP',
          entity_id: id,
        })),
      );
      if (error) throw error;
    }

    const { error: deletePermsError } = await supabase
      .from('group_permission')
      .delete()
      .eq('permission_group_id', id);
    if (deletePermsError) throw deletePermsError;

    if (permissions.length) {
      const { error } = await supabase.from('group_permission').insert(
        permissions.map((permissionId) => ({
          group_permission_id: randomUUID(),
          permission_id: permissionId,
          permission_group_id: id,
        })),
      );
      if (error) throw error;
    }

    return { success: true };
  } catch (error) {
    console.error('Error updating group assignments:', error);
    return { success: false };
  }
}

/**
 * Replace only a group's permissions. Port of
 * `permissionController.putPermissionGroupPermissions` (PUT /permissions/groups/:groupId/permissions).
 */
export async function putPermissionGroupPermissions(
  groupId: string,
  permissionIds: string[],
): Promise<{ success: boolean; count?: number }> {
  try {
    const id = String(groupId ?? '').trim();
    if (!id) return { success: false };
    const permissions = normalizeIds(permissionIds);
    const supabase = getSupabaseServiceRoleClient();

    const { data: group, error: groupError } = await supabase
      .from('permission_group')
      .select('permission_group_id')
      .eq('permission_group_id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (groupError) throw groupError;
    if (!group) return { success: false };

    const { error: deleteError } = await supabase
      .from('group_permission')
      .delete()
      .eq('permission_group_id', id);
    if (deleteError) throw deleteError;

    if (permissions.length) {
      const { error } = await supabase.from('group_permission').insert(
        permissions.map((permissionId) => ({
          group_permission_id: randomUUID(),
          permission_id: permissionId,
          permission_group_id: id,
        })),
      );
      if (error) throw error;
    }

    return { success: true, count: permissions.length };
  } catch (error) {
    console.error('Error updating group permissions:', error);
    return { success: false };
  }
}

// ---------------------------------------------------------------------------
// Group merge / delete (B0-411)
//
// Both mutations are single `rpc()` calls into Postgres functions, because
// supabase-js has no client-side transaction and the work spans three tables.
// The function body is one transaction, so copy-members + copy-permissions +
// optional source soft-delete (merge) and the cascading pivot cleanup (delete)
// either all commit or all roll back — including the `audit_logs` row, which is
// written inside the function for that reason (see the migration header).
//
// The functions raise with c360's exact messages for validation / not-found, so
// those come back through PostgREST as `error.message` and are passed straight
// into the `error` field of the envelope.
// ---------------------------------------------------------------------------

const mergePreviewRowSchema = z.object({
  users_to_add: z.number(),
  permissions_to_add: z.number(),
  source_selector: z.string().nullable(),
  target_selector: z.string().nullable(),
});

const mergeResultRowSchema = z.object({
  users_merged: z.number(),
  permissions_merged: z.number(),
  deleted_source: z.boolean(),
  source_selector: z.string().nullable(),
  target_selector: z.string().nullable(),
});

const deleteResultRowSchema = z.object({
  deleted_selector: z.string().nullable(),
  members_removed: z.number(),
  permissions_removed: z.number(),
  group_removed: z.boolean(),
});

function firstRow(data: unknown): unknown {
  return Array.isArray(data) ? data[0] : data;
}

/** PostgREST surfaces the `raise exception` message; fall back for transport-level failures. */
function rpcErrorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim() !== '') return message;
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The acting admin, for the audit payload — resolved server-side from the auth cookie, never taken
 * from the caller (same posture as c360's `mergePermissionGroups`, which reads cookies rather than
 * trusting the client). Read directly instead of via `~/lib/cookies-server`, which imports
 * `~/lib/actions/cookies`, which imports this module.
 */
async function resolveAuditActor(): Promise<{
  userId: string | null;
  email: string | null;
  name: string | null;
}> {
  try {
    const cookieStore = await cookies();
    const raw = cookieStore.get(AUTH_USER_DETAILS_COOKIE)?.value;
    if (!raw) return { userId: null, email: null, name: null };
    const parsed = JSON.parse(raw);
    const user = (Array.isArray(parsed) ? parsed[0] : parsed) as {
      USER_ID?: unknown;
      EMAIL?: unknown;
      NAME?: unknown;
    } | null;
    return {
      userId: typeof user?.USER_ID === 'string' ? user.USER_ID : null,
      email: typeof user?.EMAIL === 'string' ? user.EMAIL : null,
      name: typeof user?.NAME === 'string' ? user.NAME : null,
    };
  } catch {
    // No request scope (or an unparseable cookie): audit the mutation anonymously
    // rather than blocking it.
    return { userId: null, email: null, name: null };
  }
}

/**
 * The types generator emits a non-nullable `string` for these nullable `text` parameters, so a null
 * actor field needs one documented cast rather than eight inline ones. Null is valid on the wire and
 * is what the audit payload records for an unknown actor (as c360 did).
 */
function nullableArg(value: string | null): string {
  return value as unknown as string;
}

/**
 * Dry run of a merge: how many members and permissions would be ADDED to the target after de-dup.
 * Port of c360 `getPermissionGroupMergePreview` / `permissionController.getMergePreview`. Read-only,
 * and it counts exactly the set `merge_permission_groups` would revive or insert, so the preview can
 * never disagree with the merge.
 */
export async function getPermissionGroupMergePreview(
  targetGroupId: string,
  sourceGroupId: string,
): Promise<{
  success: boolean;
  usersToAdd: number;
  permissionsToAdd: number;
  sourceSelector: string | null;
  targetSelector: string | null;
  error?: string;
}> {
  const failure = (error: string) => ({
    success: false,
    usersToAdd: 0,
    permissionsToAdd: 0,
    sourceSelector: null,
    targetSelector: null,
    error,
  });
  try {
    const validation = validateMergeIds(targetGroupId, sourceGroupId);
    if (!validation.ok) return failure(validation.error);
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase.rpc(
      'preview_permission_group_merge',
      {
        p_target_group_id: validation.targetGroupId,
        p_source_group_id: validation.sourceGroupId,
      },
    );
    if (error) throw error;
    const parsed = mergePreviewRowSchema.safeParse(firstRow(data));
    if (!parsed.success) return failure('Failed to preview merge');
    // A null selector means the group is missing or soft-deleted.
    if (!parsed.data.target_selector) {
      return failure('Target permission group not found');
    }
    if (!parsed.data.source_selector) {
      return failure('Source permission group not found');
    }
    return {
      success: true,
      usersToAdd: parsed.data.users_to_add,
      permissionsToAdd: parsed.data.permissions_to_add,
      sourceSelector: parsed.data.source_selector,
      targetSelector: parsed.data.target_selector,
    };
  } catch (error) {
    console.error('Error previewing group merge:', error);
    return failure('Failed to preview merge');
  }
}

/**
 * Merge `sourceGroupId` into `targetGroupId`: copy members + permissions (de-duplicated against the
 * target) and, when `deleteSource` (default true), soft-delete the source group and its pivot rows.
 * Port of c360 `mergePermissionGroups(params)` / `permissionController.postMergePermissionGroup`.
 *
 * `revalidatePath` targets the admin permissions routes. Those pages are not ported yet (B0-410), so
 * the calls are currently no-ops against paths that do not render.
 */
export async function mergePermissionGroups(params: {
  targetGroupId: string;
  sourceGroupId: string;
  deleteSource?: boolean;
}): Promise<{
  success: boolean;
  usersMerged?: number;
  permissionsMerged?: number;
  deletedSource?: boolean;
  sourceSelector?: string | null;
  targetSelector?: string | null;
  error?: string;
}> {
  const { targetGroupId, sourceGroupId, deleteSource = true } = params ?? {};
  try {
    const validation = validateMergeIds(targetGroupId, sourceGroupId);
    if (!validation.ok) return { success: false, error: validation.error };

    const actor = await resolveAuditActor();
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase.rpc('merge_permission_groups', {
      p_target_group_id: validation.targetGroupId,
      p_source_group_id: validation.sourceGroupId,
      p_delete_source: deleteSource,
      p_actor_user_id: nullableArg(actor.userId),
      p_actor_email: nullableArg(actor.email),
      p_actor_name: nullableArg(actor.name),
      p_trace_id: randomUUID(),
    });
    if (error) throw error;
    const parsed = mergeResultRowSchema.safeParse(firstRow(data));
    if (!parsed.success) return { success: false, error: 'Merge failed' };

    revalidatePath('/admin/permissions');
    revalidatePath(`/admin/permissions/groups/${validation.targetGroupId}`);
    revalidatePath(`/admin/permissions/groups/${validation.sourceGroupId}`);

    return {
      success: true,
      usersMerged: parsed.data.users_merged,
      permissionsMerged: parsed.data.permissions_merged,
      deletedSource: parsed.data.deleted_source,
      sourceSelector: parsed.data.source_selector,
      targetSelector: parsed.data.target_selector,
    };
  } catch (error) {
    console.error('Error merging permission groups:', error);
    return {
      success: false,
      error: rpcErrorMessage(error, 'Failed to merge groups'),
    };
  }
}

/**
 * Hard-delete a permission group and every pivot row that references it. Port of c360
 * `deletePermissionGroupWithResources(groupId)` / `permissionController.deletePermissionGroup`. Not
 * recoverable; users keep access via other groups or direct permissions. The lookup inside the
 * function ignores soft-delete state, so a group already soft-deleted by a merge can still be purged.
 *
 * `revalidatePath` targets the admin permissions routes, which are not ported yet (B0-410).
 */
export async function deletePermissionGroupWithResources(
  groupId: string,
): Promise<{
  success: boolean;
  selector?: string | null;
  membersRemoved?: number;
  permissionsRemoved?: number;
  error?: string;
}> {
  try {
    const validation = validateGroupId(groupId);
    if (!validation.ok) return { success: false, error: validation.error };

    const actor = await resolveAuditActor();
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase.rpc(
      'delete_permission_group_with_resources',
      {
        p_group_id: validation.groupId,
        p_actor_user_id: nullableArg(actor.userId),
        p_actor_email: nullableArg(actor.email),
        p_actor_name: nullableArg(actor.name),
        p_trace_id: randomUUID(),
      },
    );
    if (error) throw error;
    const parsed = deleteResultRowSchema.safeParse(firstRow(data));
    if (!parsed.success) return { success: false, error: 'Delete failed' };

    revalidatePath('/admin/permissions');
    revalidatePath(`/admin/permissions/groups/${validation.groupId}`);

    return {
      success: true,
      selector: parsed.data.deleted_selector,
      membersRemoved: parsed.data.members_removed,
      permissionsRemoved: parsed.data.permissions_removed,
    };
  } catch (error) {
    console.error('Error deleting permission group:', error);
    return {
      success: false,
      error: rpcErrorMessage(error, 'Failed to delete group'),
    };
  }
}

// ---------------------------------------------------------------------------
// Permission users (admin)
// ---------------------------------------------------------------------------

/** Port of c360 `getPermissionsUsersList()` / `permissionController.listUsers`. */
export async function getPermissionsUsersList(): Promise<{
  success: boolean;
  data: User[];
}> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('app_user')
      .select(APP_USER_COLUMNS)
      .is('deleted_at', null)
      .order('user_name', { ascending: true });
    if (error) throw error;
    return {
      success: true,
      data: (data ?? []).map((row) => toUser(row as AppUserRow)),
    };
  } catch (error) {
    console.error('Error fetching permissions users list:', error);
    return { success: false, data: [] };
  }
}

/**
 * One user with their assigned group and permission ids. Port of c360
 * `getPermissionsUser(userId)` / `permissionController.getUserByIdWithAssignments`.
 */
export async function getPermissionsUser(userId: string): Promise<{
  success: boolean;
  data: User | null;
  permissionGroupIds: string[];
  permissionIds: string[];
}> {
  const empty = {
    success: false,
    data: null,
    permissionGroupIds: [] as string[],
    permissionIds: [] as string[],
  };
  try {
    const id = String(userId ?? '').trim();
    if (!id) return empty;
    const supabase = getSupabaseServiceRoleClient();

    const [userRes, assignRes] = await Promise.all([
      supabase
        .from('app_user')
        .select(APP_USER_COLUMNS)
        .eq('user_id', id)
        .is('deleted_at', null)
        .maybeSingle(),
      supabase
        .from('user_group_permission')
        .select('entity_type, entity_id')
        .eq('user_id', id)
        .is('deleted_at', null),
    ]);
    if (userRes.error) throw userRes.error;
    if (assignRes.error) throw assignRes.error;

    const userRow = userRes.data as AppUserRow | null;
    if (!userRow) return empty;

    const rows = assignRes.data ?? [];
    return {
      success: true,
      data: toUser(userRow),
      permissionGroupIds: rows
        .filter((row) => row.entity_type === 'PERMISSION_GROUP')
        .map((row) => row.entity_id),
      permissionIds: rows
        .filter((row) => row.entity_type === 'PERMISSION')
        .map((row) => row.entity_id),
    };
  } catch (error) {
    console.error('Error fetching permissions user:', error);
    return empty;
  }
}

/** Port of c360 `permissionController.postUser` (POST /permissions/users). */
export async function postPermissionsUser(payload: {
  name: string;
  email: string;
}): Promise<{ success: boolean; data?: User; error?: string }> {
  try {
    const name = String(payload?.name ?? '').trim();
    const email = String(payload?.email ?? '').trim();
    if (!name || !email) {
      return { success: false, error: 'name and email are required' };
    }
    // c360 splits on the first space: `name.split(' ')[0]` / `[1]`.
    const parts = name.split(' ');
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('app_user')
      .insert({
        user_id: randomUUID(),
        user_name: name,
        name,
        first_name: parts[0] ?? null,
        last_name: parts[1] ?? null,
        email,
        is_active: true,
      })
      .select(APP_USER_COLUMNS)
      .single();
    if (error) throw error;
    return { success: true, data: toUser(data as AppUserRow) };
  } catch (error) {
    console.error('Error creating user:', error);
    return { success: false, error: 'Failed to create user' };
  }
}

/**
 * Port of c360 `permissionController.putUser` (PUT /permissions/users/:userId). `user_name` is
 * recomposed from first + last name, and `user_security_role` is 'VIEW_ALL' or null — nothing else.
 */
export async function putPermissionsUser(
  userId: string,
  payload: {
    firstName?: string | null;
    lastName?: string | null;
    email: string;
    phone?: string | null;
    title?: string | null;
    department?: string | null;
    division?: string | null;
    isActive?: boolean;
    betcoCompanyId?: string | null;
    isSalesperson?: boolean;
    editAll?: boolean;
    hasUserSwitcher?: boolean;
    userSecurityRole?: string | null;
  },
): Promise<{ success: boolean; error?: string }> {
  try {
    const id = String(userId ?? '').trim();
    if (!id) return { success: false, error: 'userId required' };
    const firstName = optionalText(payload?.firstName);
    const lastName = optionalText(payload?.lastName);
    const email = optionalText(payload?.email);
    const name = [firstName, lastName].filter(Boolean).join(' ');
    if (!name || !email) {
      return { success: false, error: 'name and email are required' };
    }
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('app_user')
      .update({
        first_name: firstName,
        last_name: lastName,
        user_name: name,
        name,
        email,
        phone: optionalText(payload?.phone),
        title: optionalText(payload?.title),
        department: optionalText(payload?.department),
        division: optionalText(payload?.division),
        is_active: payload?.isActive !== undefined ? Boolean(payload.isActive) : true,
        betco_company_id: optionalText(payload?.betcoCompanyId),
        is_salesperson: Boolean(payload?.isSalesperson),
        edit_all: Boolean(payload?.editAll),
        has_user_switcher: Boolean(payload?.hasUserSwitcher),
        user_security_role:
          payload?.userSecurityRole === 'VIEW_ALL' ? 'VIEW_ALL' : null,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', id)
      .is('deleted_at', null)
      .select('user_id');
    if (error) throw error;
    if (!(data ?? []).length) return { success: false, error: 'User not found' };
    return { success: true };
  } catch (error) {
    console.error('Error updating user:', error);
    return { success: false, error: 'Failed to update user' };
  }
}

/**
 * Replace a user's group and permission assignments. Port of c360
 * `putPermissionsUserAssignments` / `permissionController.putUserAssignments`. Hard-deletes the
 * user's pivot rows first (see `putGroupAssignments` for why a soft delete cannot work here).
 */
export async function putPermissionsUserAssignments(
  userId: string,
  permissionGroupIds: string[],
  permissionIds: string[],
): Promise<{ success: boolean }> {
  try {
    const id = String(userId ?? '').trim();
    if (!id) return { success: false };
    const groups = normalizeIds(permissionGroupIds);
    const permissions = normalizeIds(permissionIds);
    const supabase = getSupabaseServiceRoleClient();

    const { data: user, error: userError } = await supabase
      .from('app_user')
      .select('user_id')
      .eq('user_id', id)
      .is('deleted_at', null)
      .maybeSingle();
    if (userError) throw userError;
    if (!user) return { success: false };

    const { error: deleteError } = await supabase
      .from('user_group_permission')
      .delete()
      .eq('user_id', id);
    if (deleteError) throw deleteError;

    const rows = [
      ...groups.map((entityId) => ({
        user_group_permission_id: randomUUID(),
        user_id: id,
        entity_type: 'PERMISSION_GROUP',
        entity_id: entityId,
      })),
      ...permissions.map((entityId) => ({
        user_group_permission_id: randomUUID(),
        user_id: id,
        entity_type: 'PERMISSION',
        entity_id: entityId,
      })),
    ];
    if (rows.length) {
      const { error } = await supabase
        .from('user_group_permission')
        .insert(rows);
      if (error) throw error;
    }

    return { success: true };
  } catch (error) {
    console.error('Error updating user assignments:', error);
    return { success: false };
  }
}

/**
 * Add groups/permissions to several users at once, skipping assignments they already have. Port of
 * c360 `postPermissionsBulkAssign` / `permissionController.postBulkAssign` (which counts one `added`
 * per row it actually inserted).
 *
 * c360 only checks for a *live* row before inserting; Snowflake has no unique constraints, so a
 * soft-deleted duplicate there just gets a second row. In Postgres the soft-deleted row still holds
 * the (user_id, entity_type, entity_id) unique slot, so it is **revived** (deleted_at cleared)
 * instead — same observable outcome (the user ends up holding the assignment) without a conflict.
 */
export async function postPermissionsBulkAssign(
  userIds: string[],
  permissionGroupIds: string[],
  permissionIds: string[],
): Promise<{ success: boolean; added?: number }> {
  try {
    const users = normalizeIds(userIds);
    const groups = normalizeIds(permissionGroupIds);
    const permissions = normalizeIds(permissionIds);
    if (!users.length || (!groups.length && !permissions.length)) {
      return { success: false };
    }
    const supabase = getSupabaseServiceRoleClient();

    const targets: { entityType: 'PERMISSION_GROUP' | 'PERMISSION'; entityId: string }[] = [
      ...groups.map((entityId) => ({
        entityType: 'PERMISSION_GROUP' as const,
        entityId,
      })),
      ...permissions.map((entityId) => ({
        entityType: 'PERMISSION' as const,
        entityId,
      })),
    ];

    // One read of every existing row (live or soft-deleted) for the users/entities in play.
    const { data: existingRows, error: existingError } = await supabase
      .from('user_group_permission')
      .select('user_group_permission_id, user_id, entity_type, entity_id, deleted_at')
      .in('user_id', users)
      .in(
        'entity_id',
        targets.map((target) => target.entityId),
      );
    if (existingError) throw existingError;

    const existing = new Map(
      (existingRows ?? []).map((row) => [
        `${row.user_id}\u0000${row.entity_type}\u0000${row.entity_id}`,
        row,
      ]),
    );

    const inserts: {
      user_group_permission_id: string;
      user_id: string;
      entity_type: string;
      entity_id: string;
    }[] = [];
    const reviveIds: string[] = [];

    for (const userId of users) {
      for (const target of targets) {
        const match = existing.get(
          `${userId}\u0000${target.entityType}\u0000${target.entityId}`,
        );
        if (!match) {
          inserts.push({
            user_group_permission_id: randomUUID(),
            user_id: userId,
            entity_type: target.entityType,
            entity_id: target.entityId,
          });
        } else if (match.deleted_at != null) {
          reviveIds.push(match.user_group_permission_id);
        }
      }
    }

    if (inserts.length) {
      const { error } = await supabase
        .from('user_group_permission')
        .insert(inserts);
      if (error) throw error;
    }
    if (reviveIds.length) {
      const { error } = await supabase
        .from('user_group_permission')
        .update({ deleted_at: null, updated_at: new Date().toISOString() })
        .in('user_group_permission_id', reviveIds);
      if (error) throw error;
    }

    return { success: true, added: inserts.length + reviveIds.length };
  } catch (error) {
    console.error('Error bulk assigning:', error);
    return { success: false };
  }
}
