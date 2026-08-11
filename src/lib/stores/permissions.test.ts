import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The server helper lives behind server-only seams (cookies, Redis, Supabase repository).
// Only its pure hasPermission() is under test here, so stub the seams out so importing the
// module never reaches next/headers or Supabase.
vi.mock('~/lib/cookies-server', () => ({
  getUserOrDefault: vi.fn(),
}));
vi.mock('~/lib/permissions/redis', () => ({
  getCachedPermissions: vi.fn(),
  getCachedPermissionGroups: vi.fn(),
  setCachedPermissions: vi.fn(),
}));
vi.mock('~/lib/permissions/repository', () => ({
  getPermissionsForUser: vi.fn(),
}));

import { hasPermission as serverHasPermission } from '~/lib/permissions/permissions-server';
import { usePermissionsStore } from '~/lib/stores/permissions';

/**
 * Shared cases for the client store and the server helper. Both implementations must agree —
 * the store gates UI, the server helper gates RSC/route access, and a divergence would show
 * a user a nav item they cannot use (or hide one they can).
 */
const PARITY_CASES: Array<{
  name: string;
  permissions: string[];
  permission: string;
  expected: boolean;
}> = [
  {
    name: 'exact match',
    permissions: ['navigation.sidebar.bex', 'admin.products.view'],
    permission: 'navigation.sidebar.bex',
    expected: true,
  },
  {
    name: 'no match',
    permissions: ['navigation.sidebar.bex'],
    permission: 'admin.products.view',
    expected: false,
  },
  {
    name: 'dot wildcard one level up',
    permissions: ['navigation.sidebar.*'],
    permission: 'navigation.sidebar.bex',
    expected: true,
  },
  {
    name: 'dot wildcard several levels up',
    permissions: ['navigation.*'],
    permission: 'navigation.sidebar.bex',
    expected: true,
  },
  {
    name: 'dot wildcard on a different branch does not match',
    permissions: ['navigation.*'],
    permission: 'admin.products.view',
    expected: false,
  },
  {
    name: 'bare * matches a nested selector',
    permissions: ['*'],
    permission: 'navigation.sidebar.bex',
    expected: true,
  },
  {
    name: 'bare * matches a single-segment selector',
    permissions: ['*'],
    permission: 'admin',
    expected: true,
  },
  {
    name: 'single-segment selector is not matched by a child wildcard',
    permissions: ['navigation.*'],
    permission: 'navigation',
    expected: false,
  },
  {
    name: 'empty permission set matches nothing',
    permissions: [],
    permission: 'navigation.sidebar.bex',
    expected: false,
  },
];

function storeHasPermission(
  permissions: string[],
  permission: string,
): boolean {
  usePermissionsStore.setState({ permissions });
  return usePermissionsStore.getState().hasPermission(permission);
}

beforeEach(() => {
  usePermissionsStore.getState().clear();
});

describe('usePermissionsStore.hasPermission / server hasPermission parity', () => {
  it.each(PARITY_CASES)(
    '$name',
    ({ permissions, permission, expected }) => {
      const client = storeHasPermission(permissions, permission);
      const server = serverHasPermission(permissions, permission);

      expect(client).toBe(expected);
      expect(server).toBe(expected);
      expect(client).toBe(server);
    },
  );
});

describe('usePermissionsStore', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('load() populates user and permissions from /api/me', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        user: { USER_ID: 'u1', EMAIL: 'tbird@betco.com', NAME: 'Tom Bird' },
        permissions: ['navigation.sidebar.bex'],
        permission_groups: ['it-admin'],
      }),
    });
    global.fetch = fetchMock as unknown as typeof global.fetch;

    await usePermissionsStore.getState().load();

    expect(fetchMock).toHaveBeenCalledWith('/api/me', {
      credentials: 'include',
    });
    const state = usePermissionsStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.user).toEqual({
      USER_ID: 'u1',
      EMAIL: 'tbird@betco.com',
      NAME: 'Tom Bird',
    });
    expect(state.permissions).toEqual(['navigation.sidebar.bex']);
    expect(state.hasPermission('navigation.sidebar.bex')).toBe(true);
  });

  it('load() marks itself loaded with no permissions when /api/me fails', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false }) as unknown as typeof global.fetch;

    await usePermissionsStore.getState().load();

    const state = usePermissionsStore.getState();
    expect(state.loaded).toBe(true);
    expect(state.permissions).toEqual([]);
    expect(state.hasPermission('navigation.sidebar.bex')).toBe(false);
  });

  it('clear() resets the store', () => {
    usePermissionsStore.setState({
      permissions: ['*'],
      user: { USER_ID: 'u1' },
      loaded: true,
    });

    usePermissionsStore.getState().clear();

    const state = usePermissionsStore.getState();
    expect(state).toMatchObject({ permissions: [], user: null, loaded: false });
  });
});
