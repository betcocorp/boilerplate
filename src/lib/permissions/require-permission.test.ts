import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The single most important behaviour in epic B0-401: with `PERMISSIONS_ENFORCED` off, a user
 * who lacks the selector is allowed through and the would-be denial is recorded; with it on, the
 * same user gets a 403. Everything below the flag (session, cookie, Redis, repository) is mocked —
 * what is under test is the verdict + flag wiring.
 */

const getServerSession = vi.fn();
vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

vi.mock('~/lib/auth', () => ({ authOptions: {} }));

const getUserOrDefault = vi.fn();
vi.mock('~/lib/cookies-server', () => ({
  getUserOrDefault: () => getUserOrDefault(),
}));

const getCachedPermissions = vi.fn();
const setCachedPermissions = vi.fn();
vi.mock('~/lib/permissions/redis', () => ({
  getCachedPermissions: (...args: unknown[]) => getCachedPermissions(...args),
  setCachedPermissions: (...args: unknown[]) => setCachedPermissions(...args),
}));

const getPermissionsForUser = vi.fn();
vi.mock('~/lib/permissions/repository', () => ({
  getPermissionsForUser: (...args: unknown[]) => getPermissionsForUser(...args),
}));

const writeAuditLog = vi.fn();
vi.mock('~/lib/audit/audit-log', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

vi.mock('~/lib/settings/settings-service', () => ({
  getBooleanSetting: vi.fn().mockResolvedValue(false),
}));

import { getBooleanSetting } from '~/lib/settings/settings-service';
import { PERMISSIONS } from './constants';
import { resetPermissionVerdictDedupe } from './enforcement';
import { requireAnyPermission, requirePermission } from './require-permission';

const SIGNED_IN = { user: { email: 'Sales.Rep@betco.com' } };

function enforce(on: boolean) {
  vi.mocked(getBooleanSetting).mockResolvedValue(on);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  getServerSession.mockReset().mockResolvedValue(SIGNED_IN);
  getUserOrDefault.mockReset().mockResolvedValue({ USER_ID: 'user-1' });
  getCachedPermissions.mockReset().mockResolvedValue(['navigation.sidebar.example']);
  setCachedPermissions.mockReset();
  getPermissionsForUser
    .mockReset()
    .mockResolvedValue({ permissions: [], permission_groups: [] });
  writeAuditLog.mockReset().mockResolvedValue(undefined);
  vi.mocked(getBooleanSetting).mockReset();
  resetPermissionVerdictDedupe();
  enforce(false);
});

describe('requirePermission — shadow mode (PERMISSIONS_ENFORCED unset)', () => {
  it('allows a user who lacks the selector, and records the would-be denial', async () => {
    const result = await requirePermission(PERMISSIONS.ADMIN_CARD_PERMISSIONS, {
      route: 'GET /api/admin/sds',
    });

    expect(result.allowed).toBe(true);
    expect(result.shadowAllowed).toBe(true);
    expect(result.errorResponse).toBeUndefined();

    // Structured log …
    expect(console.warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(vi.mocked(console.warn).mock.calls[0][0] as string);
    expect(logged).toMatchObject({
      level: 'warn',
      event: 'permission.verdict',
      surface: 'api',
      selector: PERMISSIONS.ADMIN_CARD_PERMISSIONS,
      allowed: false,
      reason: 'missing-permission',
      route: 'GET /api/admin/sds',
      userId: 'user-1',
      email: 'Sales.Rep@betco.com',
      mode: 'shadow',
      enforced: false,
      effect: 'shadow-allow',
    });

    // … plus one audit row, tagged as a shadow verdict.
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    const [eventType, payload, ctx] = writeAuditLog.mock.calls[0];
    expect(eventType).toBe('permission.shadow_verdict');
    expect(payload).toMatchObject({
      selector: PERMISSIONS.ADMIN_CARD_PERMISSIONS,
      route: 'GET /api/admin/sds',
      userId: 'user-1',
      allowed: false,
      mode: 'shadow',
    });
    expect(ctx).toMatchObject({ traceId: expect.any(String) });
  });

  it('allows when the user record is missing (unseeded this app user)', async () => {
    getUserOrDefault.mockResolvedValue(null);

    const result = await requirePermission(PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS);

    expect(result.allowed).toBe(true);
    expect(result.shadowAllowed).toBe(true);
    expect(result.errorResponse).toBeUndefined();
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0][1]).toMatchObject({
      reason: 'user-not-found',
    });
  });

  it('reports no-permissions-granted when the lookup succeeds and the user holds nothing', async () => {
    getCachedPermissions.mockResolvedValue(null);
    // Default mock already resolves { permissions: [] } — a successful read of an empty grant set.

    const result = await requirePermission(PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS);

    expect(result.allowed).toBe(true);
    expect(result.shadowAllowed).toBe(true);
    expect(result.permissions).toEqual([]);
    expect(writeAuditLog.mock.calls[0][1]).toMatchObject({
      reason: 'no-permissions-granted',
    });
  });

  /**
   * B0-413 — the two used to collapse into one verdict, which told every user holding no grants
   * to "try signing in again" for a condition signing in cannot change. Under enforcement that
   * is 90 of 96 active users, so the split has to survive.
   */
  it('reports permissions-unavailable only when the lookup itself throws', async () => {
    getCachedPermissions.mockResolvedValue(null);
    getPermissionsForUser.mockRejectedValue(new Error('redis down'));

    const result = await requirePermission(PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS);

    expect(result.permissions).toEqual([]);
    expect(writeAuditLog.mock.calls[0][1]).toMatchObject({
      reason: 'permissions-unavailable',
    });
  });

  it('still refuses an unauthenticated caller with 401 — shadow mode relaxes authorization, not authentication', async () => {
    getServerSession.mockResolvedValue(null);

    const result = await requirePermission(PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS);

    expect(result.allowed).toBe(false);
    expect(result.errorResponse?.status).toBe(401);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it('allows a signed-in session that carries no email (the NoIdentity case), rather than 401-ing', async () => {
    getServerSession.mockResolvedValue({ user: { name: 'No Email' } });
    getCachedPermissions.mockResolvedValue([PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS]);

    const result = await requirePermission(PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS);

    expect(result.allowed).toBe(true);
    expect(result.errorResponse).toBeUndefined();
  });

  it('shadow-allows while the `settings` row resolves to not-enforced', async () => {
    enforce(false);
    resetPermissionVerdictDedupe();
    const result = await requirePermission(PERMISSIONS.ADMIN_CARD_PERMISSIONS);
    expect(result.allowed).toBe(true);
    expect(result.shadowAllowed).toBe(true);
  });
});

describe('requirePermission — enforced mode (PERMISSIONS_ENFORCED=true)', () => {
  beforeEach(() => enforce(true));

  it('denies a user who lacks the selector with a 403', async () => {
    const result = await requirePermission(PERMISSIONS.ADMIN_CARD_PERMISSIONS, {
      route: 'GET /api/admin/sds',
    });

    expect(result.allowed).toBe(false);
    expect(result.shadowAllowed).toBeUndefined();
    expect(result.errorResponse?.status).toBe(403);
    await expect(result.errorResponse?.json()).resolves.toEqual({
      error: 'Forbidden',
    });

    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0][0]).toBe('permission.denied');
    expect(writeAuditLog.mock.calls[0][1]).toMatchObject({
      mode: 'enforced',
      enforced: true,
      effect: 'deny',
    });
  });

  it('denies with 403 "User not found" when the user record is missing', async () => {
    getUserOrDefault.mockResolvedValue(null);

    const result = await requirePermission(PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS);

    expect(result.allowed).toBe(false);
    expect(result.errorResponse?.status).toBe(403);
    await expect(result.errorResponse?.json()).resolves.toEqual({
      error: 'User not found',
    });
  });

  it('allows a user who holds the selector, with no audit row', async () => {
    getCachedPermissions.mockResolvedValue([PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS]);

    const result = await requirePermission(PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS);

    expect(result.allowed).toBe(true);
    expect(result.errorResponse).toBeUndefined();
    expect(writeAuditLog).not.toHaveBeenCalled();
    const logged = JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string);
    expect(logged).toMatchObject({ allowed: true, reason: 'granted' });
  });

  it('honours the grant-side wildcard (it-admin `*`)', async () => {
    getCachedPermissions.mockResolvedValue(['*']);

    const result = await requirePermission(PERMISSIONS.ADMIN_CARD_PERMISSIONS);

    expect(result.allowed).toBe(true);
    expect(writeAuditLog).not.toHaveBeenCalled();
  });
});

describe('requireAnyPermission', () => {
  it('shadow-allows when none of the selectors are held', async () => {
    const result = await requireAnyPermission(
      [
        PERMISSIONS.ADMIN_CARD_PERMISSIONS,
        PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS,
      ],
      { route: 'GET /api/admin/labels' },
    );

    expect(result.allowed).toBe(true);
    expect(result.shadowAllowed).toBe(true);
    expect(writeAuditLog.mock.calls[0][1]).toMatchObject({
      selector: [
        PERMISSIONS.ADMIN_CARD_PERMISSIONS,
        PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS,
      ],
    });
  });

  it('denies when enforced and none of the selectors are held', async () => {
    enforce(true);

    const result = await requireAnyPermission([
      PERMISSIONS.ADMIN_CARD_PERMISSIONS,
      PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS,
    ]);

    expect(result.allowed).toBe(false);
    expect(result.errorResponse?.status).toBe(403);
  });

  it('allows when one of the selectors is held', async () => {
    enforce(true);
    getCachedPermissions.mockResolvedValue([
      PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS,
    ]);

    const result = await requireAnyPermission([
      PERMISSIONS.ADMIN_CARD_PERMISSIONS,
      PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS,
    ]);

    expect(result.allowed).toBe(true);
    expect(result.errorResponse).toBeUndefined();
  });
});
