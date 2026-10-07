/**
 * B0-409: request validation + envelope->status mapping for `/api/admin/permissions/**`.
 *
 * The repository is mocked throughout — these assert what the handlers do with an envelope, not what
 * the repository puts in one (that is `src/lib/permissions/repository.test.ts`), and nothing here
 * touches the seeded database.
 */

import { NextResponse } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/api/bex-api-auth', () => ({ hasBexSession: vi.fn() }));
vi.mock('~/lib/permissions/route-gate', () => ({ gateRoute: vi.fn() }));
vi.mock('~/lib/permissions/repository', () => ({
  postPermission: vi.fn(),
  putPermission: vi.fn(),
  deletePermission: vi.fn(),
  postPermissionGroup: vi.fn(),
  putGroupAssignments: vi.fn(),
  putPermissionGroupPermissions: vi.fn(),
  mergePermissionGroups: vi.fn(),
  getPermissionGroupMergePreview: vi.fn(),
  deletePermissionGroupWithResources: vi.fn(),
  postPermissionsUser: vi.fn(),
  putPermissionsUser: vi.fn(),
  putPermissionsUserAssignments: vi.fn(),
  postPermissionsBulkAssign: vi.fn(),
}));

import { hasBexSession } from '~/lib/api/bex-api-auth';
import * as repository from '~/lib/permissions/repository';
import { gateRoute } from '~/lib/permissions/route-gate';

import { POST as postPermissionRoute } from './route';
import {
  DELETE as deletePermissionRoute,
  PUT as putPermissionRoute,
} from './[permissionId]/route';
import { POST as postGroupRoute } from './groups/route';
import { DELETE as deleteGroupRoute } from './groups/[groupId]/route';
import { PUT as putGroupAssignmentsRoute } from './groups/[groupId]/assignments/route';
import { PUT as putGroupPermissionsRoute } from './groups/[groupId]/permissions/route';
import { POST as postGroupMergeRoute } from './groups/[groupId]/merge/route';
import { GET as getGroupMergePreviewRoute } from './groups/[groupId]/merge-preview/route';
import { POST as postUserRoute } from './users/route';
import { PUT as putUserRoute } from './users/[userId]/route';
import { PUT as putUserAssignmentsRoute } from './users/[userId]/assignments/route';
import { POST as postBulkAssignRoute } from './users/bulk-assign/route';

const mockedSession = vi.mocked(hasBexSession);
const mockedGateRoute = vi.mocked(gateRoute);
const repo = vi.mocked(repository);

const BASE = 'http://localhost/api/admin/permissions';

function request(
  method: string,
  path: string,
  body?: unknown,
  rawBody?: string,
): Request {
  const init: RequestInit = { method };
  if (rawBody !== undefined) {
    init.body = rawBody;
    init.headers = { 'content-type': 'application/json' };
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'content-type': 'application/json' };
  }
  return new Request(`${BASE}${path}`, init);
}

function params<T extends Record<string, string>>(value: T) {
  return { params: Promise.resolve(value) };
}

/**
 * Signed in and permitted — the state every non-auth assertion below runs in. `gateRoute` returning
 * `null` is also what shadow mode (`BEX_PERMISSIONS_ENFORCED` off) produces for a *denied* verdict,
 * so these assertions hold in both modes.
 */
function allowAdmin() {
  mockedSession.mockResolvedValue(true);
  mockedGateRoute.mockResolvedValue(null);
}

/**
 * Every endpoint, with a valid call for each. Used for the auth matrix so a new route cannot be
 * added without inheriting both gates.
 */
const endpoints: {
  name: string;
  /** The verdict label the handler is expected to pass to `gateRoute`. */
  label: string;
  call: () => Promise<Response>;
}[] = [
  {
    name: 'POST /permissions',
    label: 'POST /api/admin/permissions',
    call: () => postPermissionRoute(request('POST', '', { selector: 'a.b' })),
  },
  {
    name: 'PUT /permissions/:permissionId',
    label: 'PUT /api/admin/permissions/:permissionId',
    call: () =>
      putPermissionRoute(
        request('PUT', '/p1', { selector: 'a.b' }),
        params({ permissionId: 'p1' }),
      ),
  },
  {
    name: 'DELETE /permissions/:permissionId',
    label: 'DELETE /api/admin/permissions/:permissionId',
    call: () =>
      deletePermissionRoute(
        request('DELETE', '/p1'),
        params({ permissionId: 'p1' }),
      ),
  },
  {
    name: 'POST /permissions/groups',
    label: 'POST /api/admin/permissions/groups',
    call: () => postGroupRoute(request('POST', '/groups', { selector: 'g' })),
  },
  {
    name: 'DELETE /permissions/groups/:groupId',
    label: 'DELETE /api/admin/permissions/groups/:groupId',
    call: () =>
      deleteGroupRoute(
        request('DELETE', '/groups/g1'),
        params({ groupId: 'g1' }),
      ),
  },
  {
    name: 'PUT /permissions/groups/:groupId/assignments',
    label: 'PUT /api/admin/permissions/groups/:groupId/assignments',
    call: () =>
      putGroupAssignmentsRoute(
        request('PUT', '/groups/g1/assignments', {
          userIds: [],
          permissionIds: [],
        }),
        params({ groupId: 'g1' }),
      ),
  },
  {
    name: 'PUT /permissions/groups/:groupId/permissions',
    label: 'PUT /api/admin/permissions/groups/:groupId/permissions',
    call: () =>
      putGroupPermissionsRoute(
        request('PUT', '/groups/g1/permissions', { permissionIds: [] }),
        params({ groupId: 'g1' }),
      ),
  },
  {
    name: 'POST /permissions/groups/:groupId/merge',
    label: 'POST /api/admin/permissions/groups/:groupId/merge',
    call: () =>
      postGroupMergeRoute(
        request('POST', '/groups/g1/merge', { sourceGroupId: 'g2' }),
        params({ groupId: 'g1' }),
      ),
  },
  {
    name: 'GET /permissions/groups/:groupId/merge-preview',
    label: 'GET /api/admin/permissions/groups/:groupId/merge-preview',
    call: () =>
      getGroupMergePreviewRoute(
        request('GET', '/groups/g1/merge-preview?sourceGroupId=g2'),
        params({ groupId: 'g1' }),
      ),
  },
  {
    name: 'POST /permissions/users',
    label: 'POST /api/admin/permissions/users',
    call: () =>
      postUserRoute(
        request('POST', '/users', { name: 'A B', email: 'a@b.com' }),
      ),
  },
  {
    name: 'PUT /permissions/users/:userId',
    label: 'PUT /api/admin/permissions/users/:userId',
    call: () =>
      putUserRoute(
        request('PUT', '/users/u1', {
          firstName: 'A',
          lastName: 'B',
          email: 'a@b.com',
        }),
        params({ userId: 'u1' }),
      ),
  },
  {
    name: 'PUT /permissions/users/:userId/assignments',
    label: 'PUT /api/admin/permissions/users/:userId/assignments',
    call: () =>
      putUserAssignmentsRoute(
        request('PUT', '/users/u1/assignments', {
          permissionGroupIds: [],
          permissionIds: [],
        }),
        params({ userId: 'u1' }),
      ),
  },
  {
    name: 'POST /permissions/users/bulk-assign',
    label: 'POST /api/admin/permissions/users/bulk-assign',
    call: () =>
      postBulkAssignRoute(
        request('POST', '/users/bulk-assign', {
          userIds: ['u1'],
          permissionGroupIds: ['g1'],
          permissionIds: [],
        }),
      ),
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('permissions admin route gating', () => {
  it.each(endpoints)('$name returns 401 with no session', async ({ call }) => {
    mockedSession.mockResolvedValue(false);
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'Unauthorized' });
    // The session gate short-circuits before the permission gate and the repository. This half of
    // the AC is flag-independent: `BEX_PERMISSIONS_ENFORCED` never relaxes authentication.
    expect(mockedGateRoute).not.toHaveBeenCalled();
  });

  it.each(endpoints)(
    '$name returns the permission gate response when it refuses',
    async ({ label, call }) => {
      mockedSession.mockResolvedValue(true);
      mockedGateRoute.mockResolvedValue(
        NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
      );
      const res = await call();
      expect(res.status).toBe(403);
      // `gateRoute` only ever returns a response when BEX_PERMISSIONS_ENFORCED is on; in shadow
      // mode it resolves to null and the request proceeds.
      expect(mockedGateRoute).toHaveBeenCalledWith(
        'admin.card.permissions',
        label,
      );
    },
  );

  it('reaches the repository once both gates pass', async () => {
    allowAdmin();
    repo.postPermission.mockResolvedValue({ success: true });
    await postPermissionRoute(request('POST', '', { selector: 'a.b' }));
    expect(repo.postPermission).toHaveBeenCalledTimes(1);
  });
});

describe('body validation', () => {
  beforeEach(allowAdmin);

  it('rejects a malformed JSON body with 400 and no issues', async () => {
    const res = await postPermissionRoute(
      request('POST', '', undefined, '{not json'),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string; issues?: unknown };
    expect(json.error).toBe('Invalid JSON body');
    expect(json.issues).toBeUndefined();
    expect(repo.postPermission).not.toHaveBeenCalled();
  });

  it('rejects a missing selector with 400 and Zod issues', async () => {
    const res = await postPermissionRoute(request('POST', '', {}));
    expect(res.status).toBe(400);
    const json = (await res.json()) as {
      error: string;
      issues: { path: unknown[] }[];
    };
    expect(json.error).toBe('Invalid request body');
    expect(json.issues[0]?.path).toEqual(['selector']);
    expect(repo.postPermission).not.toHaveBeenCalled();
  });

  it('rejects a blank id inside an id list', async () => {
    const res = await putGroupPermissionsRoute(
      request('PUT', '/groups/g1/permissions', { permissionIds: ['p1', '  '] }),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues: { path: unknown[] }[] };
    expect(json.issues[0]?.path).toEqual(['permissionIds', 1]);
    expect(repo.putPermissionGroupPermissions).not.toHaveBeenCalled();
  });

  it('rejects a non-array permissionIds', async () => {
    const res = await putGroupPermissionsRoute(
      request('PUT', '/groups/g1/permissions', { permissionIds: 'p1' }),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(400);
  });

  it('rejects a user update with neither first nor last name', async () => {
    const res = await putUserRoute(
      request('PUT', '/users/u1', { email: 'a@b.com' }),
      params({ userId: 'u1' }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues: { message: string }[] };
    expect(json.issues[0]?.message).toBe('firstName or lastName required');
    expect(repo.putPermissionsUser).not.toHaveBeenCalled();
  });

  it('rejects bulk-assign with no users', async () => {
    const res = await postBulkAssignRoute(
      request('POST', '/users/bulk-assign', {
        userIds: [],
        permissionGroupIds: ['g1'],
      }),
    );
    expect(res.status).toBe(400);
    expect(repo.postPermissionsBulkAssign).not.toHaveBeenCalled();
  });

  it('rejects bulk-assign with no groups and no permissions', async () => {
    const res = await postBulkAssignRoute(
      request('POST', '/users/bulk-assign', {
        userIds: ['u1'],
        permissionGroupIds: [],
        permissionIds: [],
      }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues: { message: string }[] };
    expect(json.issues[0]?.message).toBe(
      'at least one of permissionGroupIds or permissionIds required',
    );
  });

  it('rejects a blank dynamic id segment with 400', async () => {
    const res = await putPermissionRoute(
      request('PUT', '/%20', { selector: 'a.b' }),
      params({ permissionId: '   ' }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: 'permissionId required',
    });
  });

  it('defaults bulk-assign target lists to empty arrays', async () => {
    repo.postPermissionsBulkAssign.mockResolvedValue({
      success: true,
      added: 2,
    });
    const res = await postBulkAssignRoute(
      request('POST', '/users/bulk-assign', {
        userIds: ['u1', 'u2'],
        permissionGroupIds: ['g1'],
      }),
    );
    expect(res.status).toBe(200);
    expect(repo.postPermissionsBulkAssign).toHaveBeenCalledWith(
      ['u1', 'u2'],
      ['g1'],
      [],
    );
  });
});

describe('permissions', () => {
  beforeEach(allowAdmin);

  it('returns 201 with the created permission', async () => {
    repo.postPermission.mockResolvedValue({
      success: true,
      data: {
        PERMISSION_ID: 'p1',
        SELECTOR: 'a.b',
        DESCRIPTION: null,
        CREATED_AT: 'now',
        UPDATED_AT: 'now',
        DELETED_AT: null,
      },
    });
    const res = await postPermissionRoute(
      request('POST', '', { selector: 'a.b', description: null }),
    );
    expect(res.status).toBe(201);
    const json = (await res.json()) as { data: { PERMISSION_ID: string } };
    expect(json.data.PERMISSION_ID).toBe('p1');
    expect(repo.postPermission).toHaveBeenCalledWith({
      selector: 'a.b',
      description: null,
    });
  });

  it('maps a create failure envelope to 500', async () => {
    repo.postPermission.mockResolvedValue({
      success: false,
      error: 'Failed to create permission',
    });
    const res = await postPermissionRoute(
      request('POST', '', { selector: 'a.b' }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Failed to create permission',
    });
  });

  it('updates a permission', async () => {
    repo.putPermission.mockResolvedValue({ success: true });
    const res = await putPermissionRoute(
      request('PUT', '/p1', { selector: 'a.c', description: 'note' }),
      params({ permissionId: ' p1 ' }),
    );
    expect(res.status).toBe(200);
    // The segment is trimmed before it reaches the repository.
    expect(repo.putPermission).toHaveBeenCalledWith('p1', {
      selector: 'a.c',
      description: 'note',
    });
  });

  it('maps an unresolved update target to 404', async () => {
    repo.putPermission.mockResolvedValue({ success: false });
    const res = await putPermissionRoute(
      request('PUT', '/p1', { selector: 'a.c' }),
      params({ permissionId: 'p1' }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Permission not found',
    });
  });

  it('soft deletes a permission without reading a body', async () => {
    repo.deletePermission.mockResolvedValue({ success: true });
    const res = await deletePermissionRoute(
      request('DELETE', '/p1'),
      params({ permissionId: 'p1' }),
    );
    expect(res.status).toBe(200);
    expect(repo.deletePermission).toHaveBeenCalledWith('p1');
  });

  it('maps an unresolved delete target to 404', async () => {
    repo.deletePermission.mockResolvedValue({ success: false });
    const res = await deletePermissionRoute(
      request('DELETE', '/p1'),
      params({ permissionId: 'p1' }),
    );
    expect(res.status).toBe(404);
  });
});

describe('permission groups', () => {
  beforeEach(allowAdmin);

  it('returns 201 with the created group', async () => {
    repo.postPermissionGroup.mockResolvedValue({ success: true });
    const res = await postGroupRoute(
      request('POST', '/groups', {
        selector: 'g',
        description: 'd',
        startAt: '2026-01-01',
      }),
    );
    expect(res.status).toBe(201);
    expect(repo.postPermissionGroup).toHaveBeenCalledWith({
      selector: 'g',
      description: 'd',
      startAt: '2026-01-01',
      endAt: null,
    });
  });

  it('maps a group create failure to 500', async () => {
    repo.postPermissionGroup.mockResolvedValue({
      success: false,
      error: 'Failed to create permission group',
    });
    const res = await postGroupRoute(
      request('POST', '/groups', { selector: 'g' }),
    );
    expect(res.status).toBe(500);
  });

  it('replaces group assignments and echoes the counts', async () => {
    repo.putGroupAssignments.mockResolvedValue({ success: true });
    const res = await putGroupAssignmentsRoute(
      request('PUT', '/groups/g1/assignments', {
        userIds: ['u1', 'u2'],
        permissionIds: ['p1'],
      }),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      message: 'Group assignments updated',
      userIdCount: 2,
      permissionCount: 1,
    });
    expect(repo.putGroupAssignments).toHaveBeenCalledWith(
      'g1',
      ['u1', 'u2'],
      ['p1'],
    );
  });

  it('maps an unresolved group to 404 on assignments', async () => {
    repo.putGroupAssignments.mockResolvedValue({ success: false });
    const res = await putGroupAssignmentsRoute(
      request('PUT', '/groups/g1/assignments', {
        userIds: [],
        permissionIds: [],
      }),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Permission group not found',
    });
  });

  it('replaces group permissions and returns the repository count', async () => {
    repo.putPermissionGroupPermissions.mockResolvedValue({
      success: true,
      count: 3,
    });
    const res = await putGroupPermissionsRoute(
      request('PUT', '/groups/g1/permissions', {
        permissionIds: ['p1', 'p2', 'p3'],
      }),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { count: number };
    expect(json.count).toBe(3);
  });

  it('maps an unresolved group to 404 on permissions', async () => {
    repo.putPermissionGroupPermissions.mockResolvedValue({ success: false });
    const res = await putGroupPermissionsRoute(
      request('PUT', '/groups/g1/permissions', { permissionIds: [] }),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(404);
  });

  it('deletes a group with its resources', async () => {
    repo.deletePermissionGroupWithResources.mockResolvedValue({
      success: true,
      selector: 'it-admin',
      membersRemoved: 4,
      permissionsRemoved: 2,
    });
    const res = await deleteGroupRoute(
      request('DELETE', '/groups/g1'),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      message: 'Group deleted',
      selector: 'it-admin',
      membersRemoved: 4,
      permissionsRemoved: 2,
    });
  });

  it('rejects a blank group id on delete with 400', async () => {
    const res = await deleteGroupRoute(
      request('DELETE', '/groups/%20'),
      params({ groupId: ' ' }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: 'groupId required',
    });
    expect(repo.deletePermissionGroupWithResources).not.toHaveBeenCalled();
  });

  it('maps a not-found delete message to 404', async () => {
    repo.deletePermissionGroupWithResources.mockResolvedValue({
      success: false,
      error: 'Permission group not found',
    });
    const res = await deleteGroupRoute(
      request('DELETE', '/groups/g1'),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(404);
  });

  it('maps any other delete failure to 500', async () => {
    repo.deletePermissionGroupWithResources.mockResolvedValue({
      success: false,
      error: 'Failed to delete group',
    });
    const res = await deleteGroupRoute(
      request('DELETE', '/groups/g1'),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(500);
  });
});

describe('group merge', () => {
  beforeEach(allowAdmin);

  it('merges a source into the target', async () => {
    repo.mergePermissionGroups.mockResolvedValue({
      success: true,
      usersMerged: 3,
      permissionsMerged: 1,
      deletedSource: true,
      sourceSelector: 'old',
      targetSelector: 'new',
    });
    const res = await postGroupMergeRoute(
      request('POST', '/groups/g1/merge', { sourceGroupId: 'g2' }),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { usersMerged: number };
    expect(json.usersMerged).toBe(3);
    expect(repo.mergePermissionGroups).toHaveBeenCalledWith({
      targetGroupId: 'g1',
      sourceGroupId: 'g2',
      deleteSource: undefined,
    });
  });

  it('passes deleteSource: false through', async () => {
    repo.mergePermissionGroups.mockResolvedValue({ success: true });
    await postGroupMergeRoute(
      request('POST', '/groups/g1/merge', {
        sourceGroupId: 'g2',
        deleteSource: false,
      }),
      params({ groupId: 'g1' }),
    );
    expect(repo.mergePermissionGroups).toHaveBeenCalledWith({
      targetGroupId: 'g1',
      sourceGroupId: 'g2',
      deleteSource: false,
    });
  });

  it('rejects a self-merge with 400 before touching the repository', async () => {
    const res = await postGroupMergeRoute(
      request('POST', '/groups/g1/merge', { sourceGroupId: 'g1' }),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: string };
    expect(json.error).toContain('cannot be merged into itself');
    expect(repo.mergePermissionGroups).not.toHaveBeenCalled();
  });

  it('rejects a missing sourceGroupId with Zod issues', async () => {
    const res = await postGroupMergeRoute(
      request('POST', '/groups/g1/merge', {}),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues: unknown[] };
    expect(json.issues.length).toBeGreaterThan(0);
  });

  it('maps a not-found merge message to 404', async () => {
    repo.mergePermissionGroups.mockResolvedValue({
      success: false,
      error: 'Source permission group not found',
    });
    const res = await postGroupMergeRoute(
      request('POST', '/groups/g1/merge', { sourceGroupId: 'g2' }),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(404);
  });

  it('maps any other merge failure to 500', async () => {
    repo.mergePermissionGroups.mockResolvedValue({
      success: false,
      error: 'Merge failed',
    });
    const res = await postGroupMergeRoute(
      request('POST', '/groups/g1/merge', { sourceGroupId: 'g2' }),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(500);
  });

  it('previews a merge from the sourceGroupId query param', async () => {
    repo.getPermissionGroupMergePreview.mockResolvedValue({
      success: true,
      usersToAdd: 2,
      permissionsToAdd: 0,
      sourceSelector: 'old',
      targetSelector: 'new',
    });
    const res = await getGroupMergePreviewRoute(
      request('GET', '/groups/g1/merge-preview?sourceGroupId=g2'),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      usersToAdd: 2,
      permissionsToAdd: 0,
      sourceSelector: 'old',
      targetSelector: 'new',
    });
    expect(repo.getPermissionGroupMergePreview).toHaveBeenCalledWith('g1', 'g2');
  });

  it('rejects a preview with no sourceGroupId', async () => {
    const res = await getGroupMergePreviewRoute(
      request('GET', '/groups/g1/merge-preview'),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: 'sourceGroupId required',
    });
    expect(repo.getPermissionGroupMergePreview).not.toHaveBeenCalled();
  });

  it('maps a not-found preview to 404', async () => {
    repo.getPermissionGroupMergePreview.mockResolvedValue({
      success: false,
      usersToAdd: 0,
      permissionsToAdd: 0,
      sourceSelector: null,
      targetSelector: null,
      error: 'Target permission group not found',
    });
    const res = await getGroupMergePreviewRoute(
      request('GET', '/groups/g1/merge-preview?sourceGroupId=g2'),
      params({ groupId: 'g1' }),
    );
    expect(res.status).toBe(404);
  });
});

describe('permission users', () => {
  beforeEach(allowAdmin);

  it('returns 201 with the created user', async () => {
    repo.postPermissionsUser.mockResolvedValue({ success: true });
    const res = await postUserRoute(
      request('POST', '/users', { name: ' Ada Lovelace ', email: 'a@b.com' }),
    );
    expect(res.status).toBe(201);
    expect(repo.postPermissionsUser).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      email: 'a@b.com',
    });
  });

  it('maps a user create failure to 500', async () => {
    repo.postPermissionsUser.mockResolvedValue({
      success: false,
      error: 'Failed to create user',
    });
    const res = await postUserRoute(
      request('POST', '/users', { name: 'A B', email: 'a@b.com' }),
    );
    expect(res.status).toBe(500);
  });

  it('updates a user', async () => {
    repo.putPermissionsUser.mockResolvedValue({ success: true });
    const res = await putUserRoute(
      request('PUT', '/users/u1', {
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'a@b.com',
        isActive: true,
        userSecurityRole: 'VIEW_ALL',
      }),
      params({ userId: 'u1' }),
    );
    expect(res.status).toBe(200);
    expect(repo.putPermissionsUser).toHaveBeenCalledWith(
      'u1',
      expect.objectContaining({
        firstName: 'Ada',
        lastName: 'Lovelace',
        email: 'a@b.com',
        isActive: true,
        userSecurityRole: 'VIEW_ALL',
      }),
    );
  });

  it('maps a not-found user update to 404', async () => {
    repo.putPermissionsUser.mockResolvedValue({
      success: false,
      error: 'User not found',
    });
    const res = await putUserRoute(
      request('PUT', '/users/u1', {
        firstName: 'Ada',
        email: 'a@b.com',
      }),
      params({ userId: 'u1' }),
    );
    expect(res.status).toBe(404);
  });

  it('maps any other user update failure to 500', async () => {
    repo.putPermissionsUser.mockResolvedValue({
      success: false,
      error: 'Failed to update user',
    });
    const res = await putUserRoute(
      request('PUT', '/users/u1', { firstName: 'Ada', email: 'a@b.com' }),
      params({ userId: 'u1' }),
    );
    expect(res.status).toBe(500);
  });

  it('replaces user assignments', async () => {
    repo.putPermissionsUserAssignments.mockResolvedValue({ success: true });
    const res = await putUserAssignmentsRoute(
      request('PUT', '/users/u1/assignments', {
        permissionGroupIds: ['g1'],
        permissionIds: ['p1', 'p2'],
      }),
      params({ userId: 'u1' }),
    );
    expect(res.status).toBe(200);
    expect(repo.putPermissionsUserAssignments).toHaveBeenCalledWith(
      'u1',
      ['g1'],
      ['p1', 'p2'],
    );
  });

  it('maps an unresolved user to 404 on assignments', async () => {
    repo.putPermissionsUserAssignments.mockResolvedValue({ success: false });
    const res = await putUserAssignmentsRoute(
      request('PUT', '/users/u1/assignments', {
        permissionGroupIds: [],
        permissionIds: [],
      }),
      params({ userId: 'u1' }),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      success: false,
      error: 'User not found',
    });
  });

  it('bulk assigns and returns the added count', async () => {
    repo.postPermissionsBulkAssign.mockResolvedValue({
      success: true,
      added: 5,
    });
    const res = await postBulkAssignRoute(
      request('POST', '/users/bulk-assign', {
        userIds: ['u1', 'u2'],
        permissionGroupIds: ['g1'],
        permissionIds: [],
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      success: true,
      message: 'Bulk assign complete',
      added: 5,
    });
  });

  it('maps a bulk-assign failure to 500 (validation is already excluded by Zod)', async () => {
    repo.postPermissionsBulkAssign.mockResolvedValue({ success: false });
    const res = await postBulkAssignRoute(
      request('POST', '/users/bulk-assign', {
        userIds: ['u1'],
        permissionIds: ['p1'],
      }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      success: false,
      error: 'Failed to bulk assign',
    });
  });
});
