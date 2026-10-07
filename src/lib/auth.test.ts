import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The sign-in gate (B0-406) under both states of `PERMISSIONS_ENFORCED` (B0-408). Shadow mode
 * must never keep an Azure-AD-authenticated user out of this app, because the `app_user` seed only
 * covers 130 CRM users.
 */

const getUser = vi.fn();
const getPermissionsForUser = vi.fn();
vi.mock('~/lib/permissions/repository', () => ({
  getUser: (...args: unknown[]) => getUser(...args),
  getPermissionsForUser: (...args: unknown[]) => getPermissionsForUser(...args),
}));

const setCachedPermissions = vi.fn();
vi.mock('~/lib/permissions/redis', () => ({
  setCachedPermissions: (...args: unknown[]) => setCachedPermissions(...args),
}));

const setAuthUserDetails = vi.fn();
vi.mock('~/lib/actions/cookies', () => ({
  setAuthUserDetails: (...args: unknown[]) => setAuthUserDetails(...args),
}));

const captureException = vi.fn();
const captureMessage = vi.fn();
vi.mock('@sentry/nextjs', () => ({
  captureException: (...args: unknown[]) => captureException(...args),
  captureMessage: (...args: unknown[]) => captureMessage(...args),
}));

const writeAuditLog = vi.fn();
vi.mock('~/lib/audit/audit-log', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

vi.mock('~/lib/settings/settings-service', () => ({
  getBooleanSetting: vi.fn().mockResolvedValue(false),
}));

import { getBooleanSetting } from '~/lib/settings/settings-service';
import { authOptions } from './auth';
import { resetPermissionVerdictDedupe } from './permissions/enforcement';

type SignInCallback = NonNullable<
  NonNullable<typeof authOptions.callbacks>['signIn']
>;
type SignInEvent = NonNullable<NonNullable<typeof authOptions.events>['signIn']>;

const signIn = authOptions.callbacks?.signIn as SignInCallback;
const signInEvent = authOptions.events?.signIn as SignInEvent;

// The callback only reads `user.email` / `account.provider`; the rest of the NextAuth payload is
// irrelevant here, so cast a minimal object rather than fabricate a full OAuth profile.
function signInArgs(email: string | null) {
  return {
    user: { id: 'azure-oid', email, name: 'Sales Rep' },
    account: { provider: 'azure-ad', type: 'oauth', providerAccountId: 'oid' },
  } as unknown as Parameters<SignInCallback>[0];
}

const ACTIVE_USER = {
  USER_ID: '0055A000008pbpVQAQ',
  EMAIL: 'sales.rep@betco.com',
  NAME: 'Sales Rep',
  IS_ACTIVE: true,
};

function found(user: Record<string, unknown> = ACTIVE_USER) {
  return { success: true, data: [user], rowcount: 1 };
}

const NOT_FOUND = { success: true, data: [], rowcount: 0 };

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  getUser.mockReset().mockResolvedValue(found());
  getPermissionsForUser
    .mockReset()
    .mockResolvedValue({ permissions: ['*'], permission_groups: ['it-admin'] });
  setCachedPermissions.mockReset();
  setAuthUserDetails.mockReset();
  captureException.mockReset();
  captureMessage.mockReset();
  writeAuditLog.mockReset().mockResolvedValue(undefined);
  vi.mocked(getBooleanSetting).mockReset().mockResolvedValue(false);
  resetPermissionVerdictDedupe();
});

describe('session lifetime', () => {
  it('aligns the NextAuth session and JWT with the auth cookies (7 days by default)', () => {
    expect(authOptions.session?.maxAge).toBe(604800);
    expect(authOptions.jwt?.maxAge).toBe(604800);
  });
});

describe('signIn callback — shadow mode', () => {
  it('lets a known active user in', async () => {
    await expect(signIn(signInArgs('sales.rep@betco.com'))).resolves.toBe(true);
    expect(getUser).toHaveBeenCalledWith('sales.rep@betco.com');
    expect(captureMessage).not.toHaveBeenCalled();
  });

  it('lets an unknown user in with a warning instead of rejecting', async () => {
    getUser.mockResolvedValue(NOT_FOUND);

    await expect(signIn(signInArgs('stranger@betco.com'))).resolves.toBe(true);

    expect(console.warn).toHaveBeenCalled();
    expect(captureMessage).toHaveBeenCalledTimes(1);
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0][0]).toBe('permission.shadow_verdict');
    expect(writeAuditLog.mock.calls[0][1]).toMatchObject({
      surface: 'auth',
      reason: 'user-not-found',
      email: 'stranger@betco.com',
      rejection: '/?error=UserNotFound',
      mode: 'shadow',
      effect: 'shadow-allow',
    });
  });

  it('lets an inactive user in', async () => {
    getUser.mockResolvedValue(found({ ...ACTIVE_USER, IS_ACTIVE: false }));

    await expect(signIn(signInArgs('sales.rep@betco.com'))).resolves.toBe(true);
    expect(writeAuditLog.mock.calls[0][1]).toMatchObject({
      reason: 'account-inactive',
    });
  });

  it('lets an identity with no email in', async () => {
    await expect(signIn(signInArgs(null))).resolves.toBe(true);
    expect(getUser).not.toHaveBeenCalled();
    expect(writeAuditLog.mock.calls[0][1]).toMatchObject({
      reason: 'no-identity',
    });
  });

  it('lets a user in when the lookup itself blows up, and reports to Sentry', async () => {
    getUser.mockRejectedValue(new Error('supabase down'));

    await expect(signIn(signInArgs('sales.rep@betco.com'))).resolves.toBe(true);
    expect(captureException).toHaveBeenCalledTimes(1);
    expect(writeAuditLog.mock.calls[0][1]).toMatchObject({
      reason: 'lookup-failed',
    });
  });
});

describe('signIn callback — enforced mode', () => {
  beforeEach(() => {
    vi.mocked(getBooleanSetting).mockResolvedValue(true);
  });

  it('still lets a known active user in', async () => {
    await expect(signIn(signInArgs('sales.rep@betco.com'))).resolves.toBe(true);
  });

  it('rejects an unknown user to /?error=UserNotFound', async () => {
    getUser.mockResolvedValue(NOT_FOUND);
    await expect(signIn(signInArgs('stranger@betco.com'))).resolves.toBe(
      '/?error=UserNotFound',
    );
    expect(writeAuditLog.mock.calls[0][0]).toBe('permission.denied');
  });

  it('rejects an inactive user to /?error=AccountInactive', async () => {
    getUser.mockResolvedValue(found({ ...ACTIVE_USER, IS_ACTIVE: false }));
    await expect(signIn(signInArgs('sales.rep@betco.com'))).resolves.toBe(
      '/?error=AccountInactive',
    );
  });

  it('rejects a missing email to /?error=NoIdentity', async () => {
    await expect(signIn(signInArgs(null))).resolves.toBe('/?error=NoIdentity');
  });

  it('rejects a failed lookup to /?error=AccessDenied', async () => {
    getUser.mockRejectedValue(new Error('supabase down'));
    await expect(signIn(signInArgs('sales.rep@betco.com'))).resolves.toBe(
      '/?error=AccessDenied',
    );
  });
});

describe('events.signIn — permission prefetch', () => {
  it('caches the bundle and stamps the auth-user cookie with GROUPS', async () => {
    await signInEvent({
      user: { id: 'azure-oid', email: ' Sales.Rep@betco.com ' },
    } as unknown as Parameters<SignInEvent>[0]);

    expect(getUser).toHaveBeenCalledWith('Sales.Rep@betco.com');
    expect(setCachedPermissions).toHaveBeenCalledWith(
      ACTIVE_USER.USER_ID,
      ['*'],
      ['it-admin'],
    );
    expect(setAuthUserDetails).toHaveBeenCalledWith({
      ...ACTIVE_USER,
      GROUPS: ['it-admin'],
    });
  });

  it('runs in shadow mode too — an unknown user just skips the prefetch', async () => {
    getUser.mockResolvedValue(NOT_FOUND);

    await expect(
      signInEvent({
        user: { id: 'azure-oid', email: 'stranger@betco.com' },
      } as unknown as Parameters<SignInEvent>[0]),
    ).resolves.toBeUndefined();

    expect(setCachedPermissions).not.toHaveBeenCalled();
    expect(setAuthUserDetails).not.toHaveBeenCalled();
  });

  it('never throws when the prefetch fails', async () => {
    getPermissionsForUser.mockRejectedValue(new Error('redis down'));

    await expect(
      signInEvent({
        user: { id: 'azure-oid', email: 'sales.rep@betco.com' },
      } as unknown as Parameters<SignInEvent>[0]),
    ).resolves.toBeUndefined();

    expect(captureException).toHaveBeenCalledTimes(1);
  });
});
