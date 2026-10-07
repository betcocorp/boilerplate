import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `/api/auth/rebuild-user` (B0-406): mid-session cookie loss must self-heal, and in shadow mode a
 * failed rebuild must forward the user on rather than sign them out.
 */

const getServerSession = vi.fn();
vi.mock('next-auth', () => ({
  getServerSession: (...args: unknown[]) => getServerSession(...args),
}));

vi.mock('~/lib/auth', () => ({ authOptions: {} }));

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

vi.mock('~/lib/settings/settings-service', () => ({
  getBooleanSetting: vi.fn().mockResolvedValue(false),
}));

import { NextRequest } from 'next/server';

import {
  AUTH_USER_DETAILS_COOKIE,
  AUTH_USER_REBUILD_FAILED_COOKIE,
} from '~/lib/cookies-config';
import { getBooleanSetting } from '~/lib/settings/settings-service';

import { GET } from './route';

const APP_USER = {
  USER_ID: '0055A000008pbpVQAQ',
  EMAIL: 'sales.rep@betco.com',
  NAME: 'Sales Rep',
  IS_ACTIVE: true,
};

function request(callbackUrl: string | null): NextRequest {
  const url = new URL('http://localhost:3000/api/auth/rebuild-user');
  if (callbackUrl !== null) url.searchParams.set('callbackUrl', callbackUrl);
  return new NextRequest(url);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  getServerSession
    .mockReset()
    .mockResolvedValue({ user: { email: 'sales.rep@betco.com' } });
  getUser
    .mockReset()
    .mockResolvedValue({ success: true, data: [APP_USER], rowcount: 1 });
  getPermissionsForUser
    .mockReset()
    .mockResolvedValue({ permissions: ['*'], permission_groups: ['it-admin'] });
  setCachedPermissions.mockReset();
  vi.mocked(getBooleanSetting).mockReset().mockResolvedValue(false);
});

describe('rebuild-user — happy path', () => {
  it('re-sets the auth-user cookie with GROUPS, warms Redis, and forwards to callbackUrl', async () => {
    const response = await GET(request('/admin/analytics?tab=history'));

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/admin/analytics?tab=history',
    );
    expect(setCachedPermissions).toHaveBeenCalledWith(
      APP_USER.USER_ID,
      ['*'],
      ['it-admin'],
    );

    const cookie = response.cookies.get(AUTH_USER_DETAILS_COOKIE);
    expect(cookie?.value).toBeTruthy();
    expect(JSON.parse(cookie!.value)).toEqual({
      ...APP_USER,
      GROUPS: ['it-admin'],
    });
    expect(cookie?.maxAge).toBe(604800);
    expect(cookie?.httpOnly).toBe(false);
  });

  it.each([
    ['/api/example', 'an /api target'],
    ['//evil.example.com', 'a protocol-relative target'],
    ['https://evil.example.com/x', 'an absolute target'],
    [null, 'a missing param'],
  ])('falls back to /admin for %s (%s)', async (callbackUrl) => {
    const response = await GET(request(callbackUrl));
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/admin',
    );
  });
});

describe('rebuild-user — user missing from app_user', () => {
  beforeEach(() => {
    getUser.mockResolvedValue({ success: true, data: [], rowcount: 0 });
  });

  it('shadow mode forwards to the destination with a loop breaker and no sign-out', async () => {
    const response = await GET(request('/admin/tests'));

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/admin/tests',
    );
    expect(response.cookies.get(AUTH_USER_REBUILD_FAILED_COOKIE)?.value).toBe(
      '1',
    );
    // Nothing cleared: the NextAuth session survives.
    expect(response.cookies.get(AUTH_USER_DETAILS_COOKIE)?.value).toBeFalsy();
    const setCookies = response.headers.getSetCookie().join(';');
    expect(setCookies).not.toContain('next-auth.session-token=;');
  });

  it('enforced mode signs the user out back to the sign-in page', async () => {
    vi.mocked(getBooleanSetting).mockResolvedValue(true);

    const response = await GET(request('/admin/tests'));

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/?callbackUrl=%2Fadmin%2Ftests',
    );
    const setCookies = response.headers.getSetCookie().join(';');
    expect(setCookies).toContain('next-auth.session-token=;');
    expect(setCookies).toContain(`${AUTH_USER_DETAILS_COOKIE}=;`);
  });
});

describe('rebuild-user — lookup failure', () => {
  beforeEach(() => {
    getUser.mockRejectedValue(new Error('supabase down'));
  });

  it('shadow mode still forwards the user', async () => {
    const response = await GET(request('/admin'));
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/admin',
    );
    expect(response.cookies.get(AUTH_USER_REBUILD_FAILED_COOKIE)?.value).toBe(
      '1',
    );
  });

  it('enforced mode signs the user out', async () => {
    vi.mocked(getBooleanSetting).mockResolvedValue(true);
    const response = await GET(request('/admin'));
    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/?callbackUrl=%2Fadmin',
    );
  });
});

describe('rebuild-user — no session', () => {
  it('sends the user to sign in regardless of the flag', async () => {
    getServerSession.mockResolvedValue(null);

    const response = await GET(request('/admin'));

    expect(response.headers.get('location')).toBe(
      'http://localhost:3000/?callbackUrl=%2Fadmin',
    );
    expect(getUser).not.toHaveBeenCalled();
  });
});
