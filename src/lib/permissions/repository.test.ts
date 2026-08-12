import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-404: port of c360's `requests.getPermissionsForUser.test.ts`, plus coverage for the
 * snake_case -> UPPERCASE wire mapping this module owns and the empty/error envelopes the ported
 * helpers depend on (they must never see a throw).
 *
 * The Supabase service-role client is the only seam. `makeBuilder` stands in for a postgrest query
 * builder: every filter method is chainable and the builder itself is the thenable that resolves to
 * a queued `{ data, error }`.
 */

type QueryResult = { data: unknown; error: unknown };

const CHAINABLE = [
  'select',
  'insert',
  'update',
  'delete',
  'upsert',
  'eq',
  'neq',
  'in',
  'is',
  'not',
  'ilike',
  'order',
  'limit',
  'maybeSingle',
  'single',
] as const;

function makeBuilder(result: QueryResult) {
  const builder: Record<string, unknown> = {
    then: (
      onFulfilled?: (value: QueryResult) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(result).then(onFulfilled, onRejected),
  };
  for (const method of CHAINABLE) {
    builder[method] = () => builder;
  }
  return builder;
}

/** Queued results per table, consumed in call order. */
const tableQueue = new Map<string, QueryResult[]>();
const rpc = vi.fn();
const from = vi.fn((table: string) => {
  const queued = tableQueue.get(table);
  const next = queued?.shift();
  return makeBuilder(next ?? { data: [], error: null });
});

function queueTable(table: string, ...results: QueryResult[]) {
  tableQueue.set(table, [...(tableQueue.get(table) ?? []), ...results]);
}

vi.mock('~/supabase/clients/service-role', () => ({
  getSupabaseServiceRoleClient: () => ({ from, rpc }),
}));

const revalidatePath = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => revalidatePath(...args),
}));

/** The auth cookie is the actor seam for the merge/delete audit payload. */
const cookieGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: (name: string) => cookieGet(name) }),
}));

import {
  deletePermissionGroupWithResources,
  getPermissionGroupMergePreview,
  getPermissionGroupsList,
  getPermissionsForUser,
  getPermissionsList,
  getPermissionsUsersList,
  getUser,
  mergePermissionGroups,
} from './repository';

beforeEach(() => {
  tableQueue.clear();
  rpc.mockReset();
  from.mockClear();
  revalidatePath.mockClear();
  cookieGet.mockReset();
  cookieGet.mockReturnValue(undefined);
});

describe('getPermissionsForUser', () => {
  it('splits the get_user_permission_bundle rows on row_kind into permissions and groups', async () => {
    rpc.mockResolvedValue({
      data: [
        { row_kind: 'P', selector: 'leads.view.executive' },
        { row_kind: 'P', selector: 'accounts.*' },
        { row_kind: 'G', selector: 'sales' },
        { row_kind: 'G', selector: 'sales-lead-pilot' },
      ],
      error: null,
    });

    const result = await getPermissionsForUser('user-1');

    expect(rpc).toHaveBeenCalledWith('get_user_permission_bundle', {
      p_user_id: 'user-1',
    });
    expect(result.permissions).toEqual(['leads.view.executive', 'accounts.*']);
    expect(result.permission_groups).toEqual(['sales', 'sales-lead-pilot']);
  });

  it('returns empty arrays when the user has no assignments', async () => {
    rpc.mockResolvedValue({ data: [], error: null });

    expect(await getPermissionsForUser('user-1')).toEqual({
      permissions: [],
      permission_groups: [],
    });
  });

  it('ignores unknown row_kind values', async () => {
    rpc.mockResolvedValue({
      data: [
        { row_kind: 'P', selector: 'accounts.*' },
        { row_kind: 'X', selector: 'nonsense' },
      ],
      error: null,
    });

    expect(await getPermissionsForUser('user-1')).toEqual({
      permissions: ['accounts.*'],
      permission_groups: [],
    });
  });

  it('returns empty arrays when the RPC reports an error', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'boom' } });

    expect(await getPermissionsForUser('user-1')).toEqual({
      permissions: [],
      permission_groups: [],
    });
  });

  it('returns empty arrays when the RPC call rejects', async () => {
    rpc.mockRejectedValue(new Error('boom'));

    expect(await getPermissionsForUser('user-1')).toEqual({
      permissions: [],
      permission_groups: [],
    });
  });

  it('returns empty arrays when the bundle shape is unexpected', async () => {
    rpc.mockResolvedValue({ data: [{ row_kind: 'P' }], error: null });

    expect(await getPermissionsForUser('user-1')).toEqual({
      permissions: [],
      permission_groups: [],
    });
  });
});

describe('getUser', () => {
  it('maps the app_user row onto the UPPERCASE wire shape', async () => {
    queueTable('app_user', {
      data: [
        {
          user_id: '0053k00000AbCdEfGh',
          user_name: 'Dana Admin',
          name: 'ignored when user_name is set',
          email: 'dana@betco.com',
          phone: null,
          title: 'IT Manager',
          department: 'IT',
          division: null,
          is_active: true,
          is_salesperson: false,
          betco_company_id: '1',
          edit_all: true,
          has_user_switcher: true,
          user_security_role: 'VIEW_ALL',
        },
      ],
      error: null,
    });

    const result = await getUser('dana@betco.com');

    expect(result).toEqual({
      success: true,
      rowcount: 1,
      data: [
        {
          USER_ID: '0053k00000AbCdEfGh',
          NAME: 'Dana Admin',
          EMAIL: 'dana@betco.com',
          PHONE: null,
          TITLE: 'IT Manager',
          DEPARTMENT: 'IT',
          DIVISION: null,
          IS_ACTIVE: true,
          BETCO_COMPANY_ID: '1',
          IS_SALESPERSON: false,
          EDIT_ALL: true,
          HAS_USER_SWITCHER: true,
          USER_SECURITY_ROLE: 'VIEW_ALL',
        },
      ],
    });
  });

  it('does not hit the database for a blank email', async () => {
    expect(await getUser('   ')).toEqual({
      success: false,
      data: [],
      rowcount: 0,
    });
    expect(from).not.toHaveBeenCalled();
  });

  it('returns an empty envelope when the query errors', async () => {
    queueTable('app_user', { data: null, error: { message: 'boom' } });

    expect(await getUser('dana@betco.com')).toEqual({
      success: false,
      data: [],
      rowcount: 0,
    });
  });
});

describe('getPermissionsList', () => {
  it('maps permission rows onto the UPPERCASE wire shape', async () => {
    queueTable('permission', {
      data: [
        {
          permission_id: 'p1',
          selector: 'navigation.sidebar.bex',
          description: 'See the Bex nav item',
          created_at: '2026-08-01T00:00:00Z',
          updated_at: '2026-08-02T00:00:00Z',
          deleted_at: null,
        },
      ],
      error: null,
    });

    expect(await getPermissionsList()).toEqual({
      success: true,
      data: [
        {
          PERMISSION_ID: 'p1',
          SELECTOR: 'navigation.sidebar.bex',
          DESCRIPTION: 'See the Bex nav item',
          CREATED_AT: '2026-08-01T00:00:00Z',
          UPDATED_AT: '2026-08-02T00:00:00Z',
          DELETED_AT: null,
        },
      ],
    });
  });

  it('returns an empty envelope when the query errors', async () => {
    queueTable('permission', { data: null, error: { message: 'boom' } });

    expect(await getPermissionsList()).toEqual({ success: false, data: [] });
  });
});

describe('getPermissionGroupsList', () => {
  it('maps permission_group rows onto the UPPERCASE wire shape', async () => {
    queueTable('permission_group', {
      data: [
        {
          permission_group_id: 'g1',
          selector: 'it-admin',
          description: null,
          start_at: null,
          end_at: null,
          created_at: '2026-08-01T00:00:00Z',
          updated_at: '2026-08-01T00:00:00Z',
          deleted_at: null,
        },
      ],
      error: null,
    });

    expect(await getPermissionGroupsList()).toEqual({
      success: true,
      data: [
        {
          PERMISSION_GROUP_ID: 'g1',
          SELECTOR: 'it-admin',
          DESCRIPTION: null,
          START_AT: null,
          END_AT: null,
          CREATED_AT: '2026-08-01T00:00:00Z',
          UPDATED_AT: '2026-08-01T00:00:00Z',
          DELETED_AT: null,
        },
      ],
    });
  });
});

describe('getPermissionsUsersList', () => {
  it('falls back to app_user.name when user_name is null and coalesces the booleans', async () => {
    queueTable('app_user', {
      data: [
        {
          user_id: 'u1',
          user_name: null,
          name: 'Fallback Name',
          email: null,
          phone: null,
          title: null,
          department: null,
          division: null,
          is_active: null,
          is_salesperson: null,
          betco_company_id: null,
          edit_all: null,
          has_user_switcher: null,
          user_security_role: null,
        },
      ],
      error: null,
    });

    const result = await getPermissionsUsersList();

    expect(result.success).toBe(true);
    expect(result.data[0]).toEqual({
      USER_ID: 'u1',
      NAME: 'Fallback Name',
      EMAIL: '',
      PHONE: null,
      TITLE: null,
      DEPARTMENT: null,
      DIVISION: null,
      IS_ACTIVE: false,
      BETCO_COMPANY_ID: undefined,
      IS_SALESPERSON: false,
      EDIT_ALL: false,
      HAS_USER_SWITCHER: false,
      USER_SECURITY_ROLE: null,
    });
  });
});

describe('mergePermissionGroups (B0-411)', () => {
  it('rejects a self-merge with the c360 message before calling the RPC', async () => {
    const result = await mergePermissionGroups({
      targetGroupId: 'g1',
      sourceGroupId: ' g1 ',
    });

    expect(result).toEqual({
      success: false,
      error:
        'A group cannot be merged into itself. Choose a different source and target group.',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('calls merge_permission_groups with the trimmed ids and the cookie actor, then revalidates', async () => {
    cookieGet.mockReturnValue({
      value: JSON.stringify({
        USER_ID: 'actor-1',
        EMAIL: 'admin@betco.com',
        NAME: 'Admin User',
      }),
    });
    rpc.mockResolvedValue({
      data: [
        {
          users_merged: 2,
          permissions_merged: 3,
          deleted_source: true,
          source_selector: 'temp-onboarding',
          target_selector: 'sales',
          prior_target_user_count: 1,
          prior_target_permission_count: 2,
          prior_source_user_count: 3,
          prior_source_permission_count: 4,
        },
      ],
      error: null,
    });

    const result = await mergePermissionGroups({
      targetGroupId: ' target-1 ',
      sourceGroupId: 'source-1',
    });

    expect(result).toEqual({
      success: true,
      usersMerged: 2,
      permissionsMerged: 3,
      deletedSource: true,
      sourceSelector: 'temp-onboarding',
      targetSelector: 'sales',
    });

    const [fnName, args] = rpc.mock.calls[0];
    expect(fnName).toBe('merge_permission_groups');
    expect(args).toMatchObject({
      p_target_group_id: 'target-1',
      p_source_group_id: 'source-1',
      p_delete_source: true,
      p_actor_user_id: 'actor-1',
      p_actor_email: 'admin@betco.com',
      p_actor_name: 'Admin User',
    });
    expect(typeof args.p_trace_id).toBe('string');

    expect(revalidatePath).toHaveBeenCalledWith('/admin/permissions');
    expect(revalidatePath).toHaveBeenCalledWith(
      '/admin/permissions/groups/target-1',
    );
    expect(revalidatePath).toHaveBeenCalledWith(
      '/admin/permissions/groups/source-1',
    );
  });

  it('passes deleteSource: false through and reports it back', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          users_merged: 0,
          permissions_merged: 0,
          deleted_source: false,
          source_selector: 'src',
          target_selector: 'tgt',
        },
      ],
      error: null,
    });

    const result = await mergePermissionGroups({
      targetGroupId: 'target-1',
      sourceGroupId: 'source-1',
      deleteSource: false,
    });

    expect(rpc.mock.calls[0][1]).toMatchObject({ p_delete_source: false });
    expect(result.deletedSource).toBe(false);
  });

  it('nulls the actor fields when there is no auth cookie', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          users_merged: 0,
          permissions_merged: 0,
          deleted_source: true,
          source_selector: 'src',
          target_selector: 'tgt',
        },
      ],
      error: null,
    });

    await mergePermissionGroups({
      targetGroupId: 'target-1',
      sourceGroupId: 'source-1',
    });

    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_actor_user_id: null,
      p_actor_email: null,
      p_actor_name: null,
    });
  });

  it('surfaces the Postgres raise message and does not revalidate', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'Source permission group not found' },
    });

    expect(
      await mergePermissionGroups({
        targetGroupId: 'target-1',
        sourceGroupId: 'source-1',
      }),
    ).toEqual({
      success: false,
      error: 'Source permission group not found',
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});

describe('deletePermissionGroupWithResources (B0-411)', () => {
  it('requires a group id before calling the RPC', async () => {
    expect(await deletePermissionGroupWithResources('  ')).toEqual({
      success: false,
      error: 'groupId required',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('maps the RPC row onto the c360 envelope and revalidates', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          deleted_selector: 'temp-onboarding',
          members_removed: 4,
          permissions_removed: 7,
          group_removed: true,
        },
      ],
      error: null,
    });

    expect(await deletePermissionGroupWithResources(' group-1 ')).toEqual({
      success: true,
      selector: 'temp-onboarding',
      membersRemoved: 4,
      permissionsRemoved: 7,
    });

    const [fnName, args] = rpc.mock.calls[0];
    expect(fnName).toBe('delete_permission_group_with_resources');
    expect(args).toMatchObject({ p_group_id: 'group-1' });
    expect(revalidatePath).toHaveBeenCalledWith('/admin/permissions');
    expect(revalidatePath).toHaveBeenCalledWith(
      '/admin/permissions/groups/group-1',
    );
  });

  it('surfaces the Postgres raise message for a missing group', async () => {
    rpc.mockResolvedValue({
      data: null,
      error: { message: 'Permission group not found' },
    });

    expect(await deletePermissionGroupWithResources('group-1')).toEqual({
      success: false,
      error: 'Permission group not found',
    });
  });
});

describe('getPermissionGroupMergePreview (B0-411)', () => {
  it('requires both ids before calling the RPC', async () => {
    expect(await getPermissionGroupMergePreview('g1', '')).toEqual({
      success: false,
      usersToAdd: 0,
      permissionsToAdd: 0,
      sourceSelector: null,
      targetSelector: null,
      error: 'sourceGroupId required',
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('returns the add counts and both selectors', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          users_to_add: 2,
          permissions_to_add: 5,
          source_selector: 'temp-onboarding',
          target_selector: 'sales',
        },
      ],
      error: null,
    });

    expect(
      await getPermissionGroupMergePreview('target-1', 'source-1'),
    ).toEqual({
      success: true,
      usersToAdd: 2,
      permissionsToAdd: 5,
      sourceSelector: 'temp-onboarding',
      targetSelector: 'sales',
    });
    expect(rpc).toHaveBeenCalledWith('preview_permission_group_merge', {
      p_target_group_id: 'target-1',
      p_source_group_id: 'source-1',
    });
  });

  it('reports a null target selector as target-not-found', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          users_to_add: 0,
          permissions_to_add: 0,
          source_selector: 'src',
          target_selector: null,
        },
      ],
      error: null,
    });

    expect(
      await getPermissionGroupMergePreview('target-1', 'source-1'),
    ).toMatchObject({
      success: false,
      error: 'Target permission group not found',
    });
  });

  it('reports a null source selector as source-not-found', async () => {
    rpc.mockResolvedValue({
      data: [
        {
          users_to_add: 0,
          permissions_to_add: 0,
          source_selector: null,
          target_selector: 'tgt',
        },
      ],
      error: null,
    });

    expect(
      await getPermissionGroupMergePreview('target-1', 'source-1'),
    ).toMatchObject({
      success: false,
      error: 'Source permission group not found',
    });
  });
});
