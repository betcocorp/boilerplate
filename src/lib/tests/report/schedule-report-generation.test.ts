import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  MAX_REPORT_HOPS,
  scheduleReportGeneration,
} from './schedule-report-generation';

/**
 * B0-943 — the hop scheduler is the only thing standing between a completed run and a report that
 * never finishes, so what is pinned here is that it (a) never throws, (b) degrades to a no-op
 * rather than an error when the deployment has no service token, and (c) refuses to chain forever.
 *
 * `next/headers` is mocked to throw, which is what it does outside a request scope — the scheduler
 * then falls back to the configured origin. No real network call is ever made.
 */
vi.mock('next/headers', () => ({
  headers: () => {
    throw new Error('no request scope');
  },
}));

const ORIGINAL_CRON_SECRET = process.env.CRON_SECRET;
const ORIGINAL_NEXTAUTH_URL = process.env.NEXTAUTH_URL;

function restoreEnv(key: 'CRON_SECRET' | 'NEXTAUTH_URL', value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  restoreEnv('CRON_SECRET', ORIGINAL_CRON_SECRET);
  restoreEnv('NEXTAUTH_URL', ORIGINAL_NEXTAUTH_URL);
});

describe('scheduleReportGeneration (B0-943)', () => {
  it('POSTs the report route in background mode with the bearer token and hop headers', async () => {
    process.env.CRON_SECRET = 'bex_test_token';
    process.env.NEXTAUTH_URL = 'https://bex.example.com';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);

    const result = await scheduleReportGeneration({ testResultId: 'run-1', hop: 2 });

    expect(result).toEqual({ scheduled: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://bex.example.com/api/admin/tests/runs/run-1/report');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer bex_test_token',
      'x-bex-report-mode': 'background',
      'x-bex-report-hop': '2',
    });
  });

  it('degrades silently to {scheduled:false} when CRON_SECRET is missing', async () => {
    delete process.env.CRON_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    // Local dev has no service token; the report page's own auto-continue covers that case, and
    // this must never throw out of the run executor's after() callback.
    await expect(
      scheduleReportGeneration({ testResultId: 'run-1', hop: 1 }),
    ).resolves.toEqual({ scheduled: false, reason: 'no_token' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops the chain past MAX_REPORT_HOPS without fetching', async () => {
    process.env.CRON_SECRET = 'bex_test_token';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 202 });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      scheduleReportGeneration({ testResultId: 'run-1', hop: MAX_REPORT_HOPS }),
    ).resolves.toEqual({ scheduled: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockClear();
    await expect(
      scheduleReportGeneration({ testResultId: 'run-1', hop: MAX_REPORT_HOPS + 1 }),
    ).resolves.toEqual({ scheduled: false, reason: 'hop_cap' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports a non-ok response without throwing', async () => {
    process.env.CRON_SECRET = 'bex_test_token';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }));

    await expect(
      scheduleReportGeneration({ testResultId: 'run-1', hop: 1 }),
    ).resolves.toEqual({ scheduled: false, reason: 'http_401' });
  });

  it('swallows a transport failure', async () => {
    process.env.CRON_SECRET = 'bex_test_token';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    await expect(
      scheduleReportGeneration({ testResultId: 'run-1', hop: 1 }),
    ).resolves.toEqual({ scheduled: false, reason: 'fetch_failed' });
  });
});
