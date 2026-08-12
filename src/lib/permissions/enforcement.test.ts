import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const writeAuditLog = vi.fn();
vi.mock('~/lib/audit/audit-log', () => ({
  writeAuditLog: (...args: unknown[]) => writeAuditLog(...args),
}));

import {
  isPermissionsEnforced,
  recordPermissionVerdict,
  resetPermissionVerdictDedupe,
} from './enforcement';

function lastLog(spy: ReturnType<typeof vi.spyOn>) {
  const calls = vi.mocked(spy).mock.calls;
  return JSON.parse(calls[calls.length - 1][0] as string);
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  writeAuditLog.mockReset().mockResolvedValue(undefined);
  resetPermissionVerdictDedupe();
  delete process.env.BEX_PERMISSIONS_ENFORCED;
});

afterEach(() => {
  delete process.env.BEX_PERMISSIONS_ENFORCED;
});

describe('isPermissionsEnforced', () => {
  it('defaults to shadow mode when the env var is absent', () => {
    expect(isPermissionsEnforced()).toBe(false);
  });

  it('enforces only on the exact string "true"', () => {
    for (const value of ['', 'false', 'TRUE', 'True', '1', 'yes', ' true']) {
      process.env.BEX_PERMISSIONS_ENFORCED = value;
      expect(isPermissionsEnforced(), value).toBe(false);
    }
    process.env.BEX_PERMISSIONS_ENFORCED = 'true';
    expect(isPermissionsEnforced()).toBe(true);
  });

  it('is read at call time, so a flip takes effect without re-importing', () => {
    expect(isPermissionsEnforced()).toBe(false);
    process.env.BEX_PERMISSIONS_ENFORCED = 'true';
    expect(isPermissionsEnforced()).toBe(true);
    delete process.env.BEX_PERMISSIONS_ENFORCED;
    expect(isPermissionsEnforced()).toBe(false);
  });
});

describe('recordPermissionVerdict', () => {
  it('logs allows at info level and writes no audit row', async () => {
    const log = vi.spyOn(console, 'log');

    await recordPermissionVerdict({
      surface: 'api',
      selector: 'bex.chat.use',
      allowed: true,
      reason: 'granted',
      userId: 'u1',
    });

    expect(lastLog(log)).toMatchObject({
      level: 'info',
      event: 'permission.verdict',
      effect: 'allow',
    });
    expect(writeAuditLog).not.toHaveBeenCalled();
  });

  it('writes one de-duplicated audit row per (mode, surface, user, selector, reason)', async () => {
    const verdict = {
      surface: 'api' as const,
      selector: 'navigation.sidebar.sds',
      allowed: false,
      reason: 'missing-permission' as const,
      userId: 'u1',
    };

    await recordPermissionVerdict(verdict);
    await recordPermissionVerdict(verdict);
    await recordPermissionVerdict(verdict);

    // Every request is logged …
    expect(console.warn).toHaveBeenCalledTimes(3);
    // … but `audit_logs` only gets the fact once.
    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });

  it('keeps distinct users, selectors and modes as separate audit rows', async () => {
    await recordPermissionVerdict({
      surface: 'api',
      selector: 'navigation.sidebar.sds',
      allowed: false,
      reason: 'missing-permission',
      userId: 'u1',
    });
    await recordPermissionVerdict({
      surface: 'api',
      selector: 'navigation.sidebar.sds',
      allowed: false,
      reason: 'missing-permission',
      userId: 'u2',
    });
    await recordPermissionVerdict({
      surface: 'nav',
      selector: 'navigation.sidebar.sds',
      allowed: false,
      reason: 'missing-permission',
      userId: 'u1',
    });
    process.env.BEX_PERMISSIONS_ENFORCED = 'true';
    await recordPermissionVerdict({
      surface: 'api',
      selector: 'navigation.sidebar.sds',
      allowed: false,
      reason: 'missing-permission',
      userId: 'u1',
    });

    expect(writeAuditLog).toHaveBeenCalledTimes(4);
    expect(writeAuditLog.mock.calls.map((call) => call[0])).toEqual([
      'permission.shadow_verdict',
      'permission.shadow_verdict',
      'permission.shadow_verdict',
      'permission.denied',
    ]);
  });

  it('treats a multi-selector verdict as one fact regardless of ordering', async () => {
    await recordPermissionVerdict({
      surface: 'nav',
      selector: ['navigation.sidebar.sds', 'navigation.sidebar.labels'],
      allowed: false,
      reason: 'missing-permission',
      userId: 'u1',
    });
    await recordPermissionVerdict({
      surface: 'nav',
      selector: ['navigation.sidebar.labels', 'navigation.sidebar.sds'],
      allowed: false,
      reason: 'missing-permission',
      userId: 'u1',
    });

    expect(writeAuditLog).toHaveBeenCalledTimes(1);
  });

  it('never throws when the audit write fails', async () => {
    writeAuditLog.mockRejectedValue(new Error('supabase down'));

    await expect(
      recordPermissionVerdict({
        surface: 'auth',
        selector: 'signIn',
        allowed: false,
        reason: 'user-not-found',
        email: 'nobody@betco.com',
      }),
    ).resolves.toBeUndefined();
  });
});
