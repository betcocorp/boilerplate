import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the server-only seams (cookies, Redis, permissions repository) — the helper's contract
// is the resolution order across them, observable through its return value.
const getUserOrDefault = vi.fn();
vi.mock('~/lib/cookies-server', () => ({
  getUserOrDefault: () => getUserOrDefault(),
}));

const getCachedPermissions = vi.fn();
const getCachedPermissionGroups = vi.fn();
const setCachedPermissions = vi.fn();
vi.mock('~/lib/permissions/redis', () => ({
  getCachedPermissions: (...args: unknown[]) => getCachedPermissions(...args),
  getCachedPermissionGroups: (...args: unknown[]) =>
    getCachedPermissionGroups(...args),
  setCachedPermissions: (...args: unknown[]) => setCachedPermissions(...args),
}));

const getPermissionsForUser = vi.fn();
vi.mock('~/lib/permissions/repository', () => ({
  getPermissionsForUser: (...args: unknown[]) => getPermissionsForUser(...args),
}));

import { getCurrentUserPermissionGroups } from './permissions-server';

beforeEach(() => {
  getUserOrDefault.mockReset();
  getCachedPermissions.mockReset();
  getCachedPermissionGroups.mockReset();
  setCachedPermissions.mockReset();
  getPermissionsForUser.mockReset();
});

describe('getCurrentUserPermissionGroups', () => {
  it('returns the effective user cookie GROUPS when present', async () => {
    getUserOrDefault.mockResolvedValue({
      USER_ID: 'u1',
      GROUPS: ['sales', 'customer-service'],
    });

    const groups = await getCurrentUserPermissionGroups();

    expect(groups).toEqual(['sales', 'customer-service']);
    expect(getCachedPermissionGroups).not.toHaveBeenCalled();
    expect(getPermissionsForUser).not.toHaveBeenCalled();
  });

  it('falls back to the Redis bundle when the cookie has no groups (e.g. impersonation)', async () => {
    getUserOrDefault.mockResolvedValue({ USER_ID: 'u2' });
    getCachedPermissionGroups.mockResolvedValue(['sales']);

    const groups = await getCurrentUserPermissionGroups();

    expect(groups).toEqual(['sales']);
    expect(getCachedPermissionGroups).toHaveBeenCalledWith('u2');
    expect(getPermissionsForUser).not.toHaveBeenCalled();
  });

  it('refetches from the repository and re-caches when Redis has no groups (stale pre-fix bundle)', async () => {
    getUserOrDefault.mockResolvedValue({ USER_ID: 'u3' });
    getCachedPermissionGroups.mockResolvedValue([]);
    getPermissionsForUser.mockResolvedValue({
      permissions: ['navigation.sidebar.example'],
      permission_groups: ['sales'],
    });

    const groups = await getCurrentUserPermissionGroups();

    expect(groups).toEqual(['sales']);
    expect(setCachedPermissions).toHaveBeenCalledWith(
      'u3',
      ['navigation.sidebar.example'],
      ['sales'],
    );
  });

  it('returns [] when there is no effective user or the repository errors', async () => {
    getUserOrDefault.mockResolvedValue(null);
    expect(await getCurrentUserPermissionGroups()).toEqual([]);

    getUserOrDefault.mockResolvedValue({ USER_ID: 'u4' });
    getCachedPermissionGroups.mockResolvedValue(null);
    getPermissionsForUser.mockRejectedValue(new Error('repository down'));
    expect(await getCurrentUserPermissionGroups()).toEqual([]);
  });
});
