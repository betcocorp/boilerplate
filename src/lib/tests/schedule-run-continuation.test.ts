import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_RUN_HOPS,
  canScheduleRunContinuation,
  scheduleRunContinuation,
} from './schedule-run-continuation';

/**
 * B0-990 — same contract as `scheduleReportGeneration` (B0-943): never throws, no-ops without a
 * service token, refuses to chain forever, and carries the Deployment Protection bypass when the
 * deployment has one. `next/headers` is mocked to throw, as it does outside a request scope.
 */
vi.mock('next/headers', () => ({
  headers: () => {
    throw new Error('no request scope');
  },
}));

const ORIGINAL = {
  CRON_SECRET: process.env.CRON_SECRET,
  NEXTAUTH_URL: process.env.NEXTAUTH_URL,
  VERCEL_AUTOMATION_BYPASS_SECRET: process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
};

function restore(key: keyof typeof ORIGINAL): void {
  const value = ORIGINAL[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restore('CRON_SECRET');
  restore('NEXTAUTH_URL');
  restore('VERCEL_AUTOMATION_BYPASS_SECRET');
});

describe('scheduleRunContinuation (B0-990)', () => {
  it('POSTs the run route in background mode with the bearer token, hop and bypass headers', async () => {
    process.env.CRON_SECRET = 'bex_test_token';
    process.env.NEXTAUTH_URL = 'https://bex.example.com';
    process.env.VERCEL_AUTOMATION_BYPASS_SECRET = 'bypass-secret';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await scheduleRunContinuation({ testResultId: 'run-1', hop: 3 });

    expect(result).toEqual({ scheduled: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://bex.example.com/api/admin/tests/runs/run-1');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer bex_test_token',
      'x-bex-run-mode': 'background',
      'x-bex-run-hop': '3',
      'x-vercel-protection-bypass': 'bypass-secret',
    });
  });

  it('is a no-op without CRON_SECRET, and says so through canScheduleRunContinuation', async () => {
    delete process.env.CRON_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(canScheduleRunContinuation()).toBe(false);
    await expect(
      scheduleRunContinuation({ testResultId: 'run-1', hop: 1 }),
    ).resolves.toEqual({ scheduled: false, reason: 'no_token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops the chain past MAX_RUN_HOPS without fetching', async () => {
    process.env.CRON_SECRET = 'bex_test_token';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      scheduleRunContinuation({ testResultId: 'run-1', hop: MAX_RUN_HOPS + 1 }),
    ).resolves.toEqual({ scheduled: false, reason: 'hop_cap' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a rejected hop and a thrown fetch as not scheduled, never throwing', async () => {
    process.env.CRON_SECRET = 'bex_test_token';
    process.env.NEXTAUTH_URL = 'https://bex.example.com';

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    await expect(
      scheduleRunContinuation({ testResultId: 'run-1', hop: 1 }),
    ).resolves.toEqual({ scheduled: false, reason: 'http_409' });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket hang up')));
    await expect(
      scheduleRunContinuation({ testResultId: 'run-1', hop: 1 }),
    ).resolves.toEqual({ scheduled: false, reason: 'fetch_failed' });
  });
});
