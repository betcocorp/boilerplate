import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticateApiToken } from '~/lib/api/client-auth';
import { countAppRequestsInWindow } from '~/lib/api/rate-limit';
import { touchApiKeyLastUsed, writeApiRequestLog } from '~/lib/api/request-log';
import { withApiV1 } from '~/lib/api/with-api-v1';

// after() collects callbacks so the test can drain them post-response.
const { afterCallbacks } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>();
  return { ...actual, after: (cb: () => unknown) => afterCallbacks.push(cb) };
});

vi.mock('~/lib/api/client-auth', () => ({
  authenticateApiToken: vi.fn(),
  unauthorizedResponse: () =>
    new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
}));

vi.mock('~/lib/api/request-log', () => ({
  writeApiRequestLog: vi.fn(async () => {}),
  touchApiKeyLastUsed: vi.fn(async () => {}),
}));

vi.mock('~/lib/api/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/api/rate-limit')>();
  return { ...actual, countAppRequestsInWindow: vi.fn(async () => 0) };
});

async function drainAfter() {
  for (const cb of afterCallbacks) await cb();
}

function req(method = 'POST') {
  return new Request('http://localhost/api/v1/orchestrator', { method });
}

const ACTIVE = {
  ok: true as const,
  context: {
    keyId: 'k',
    appId: 'a',
    projectId: 'p',
    rateLimitPerMinute: null,
  },
};

beforeEach(() => {
  afterCallbacks.length = 0;
  vi.clearAllMocks();
});

describe('withApiV1', () => {
  it('logs a successful authenticated request with attribution and touches last_used', async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue(ACTIVE);
    const route = withApiV1(async () => new Response('ok', { status: 200 }));

    const res = await route(req());
    expect(res.status).toBe(200);
    await drainAfter();

    expect(writeApiRequestLog).toHaveBeenCalledWith(
      expect.objectContaining({
        keyId: 'k',
        appId: 'a',
        projectId: 'p',
        method: 'POST',
        path: '/api/v1/orchestrator',
        status: 200,
        error: null,
      }),
    );
    expect(touchApiKeyLastUsed).toHaveBeenCalledWith('k');
  });

  it('attaches token usage the handler records', async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue(ACTIVE);
    const route = withApiV1(async (_request, { recordUsage }) => {
      recordUsage({ totalTokens: 42 });
      return new Response('ok', { status: 200 });
    });

    await route(req());
    await drainAfter();

    expect(writeApiRequestLog).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { totalTokens: 42 } }),
    );
  });

  it('B0-119: returns 429 + Retry-After and logs it when the app is over its rate limit', async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue({
      ok: true,
      context: { keyId: 'k', appId: 'a', projectId: 'p', rateLimitPerMinute: 5 },
    });
    vi.mocked(countAppRequestsInWindow).mockResolvedValue(5);
    let handlerCalled = false;
    const route = withApiV1(async () => {
      handlerCalled = true;
      return new Response('ok', { status: 200 });
    });

    const res = await route(req());
    expect(res.status).toBe(429);
    expect(res.headers.get('retry-after')).toBeTruthy();
    expect(handlerCalled).toBe(false);
    await drainAfter();
    expect(writeApiRequestLog).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'a', status: 429, error: 'rate_limited' }),
    );
  });

  it('B0-119: an app under its limit is allowed through', async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue({
      ok: true,
      context: { keyId: 'k', appId: 'a', projectId: 'p', rateLimitPerMinute: 5 },
    });
    vi.mocked(countAppRequestsInWindow).mockResolvedValue(4);
    const route = withApiV1(async () => new Response('ok', { status: 200 }));
    const res = await route(req());
    expect(res.status).toBe(200);
  });

  it('does NOT log an unattributable failure (no orphan rows)', async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue({ ok: false, reason: 'missing_token' });
    const route = withApiV1(async () => new Response('ok', { status: 200 }));

    const res = await route(req());
    expect(res.status).toBe(401);
    await drainAfter();

    expect(writeApiRequestLog).not.toHaveBeenCalled();
    expect(touchApiKeyLastUsed).not.toHaveBeenCalled();
  });

  it('logs a resolvable-but-dead token attempt (revoked) without touching last_used', async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue({
      ok: false,
      reason: 'revoked',
      attribution: { keyId: 'k', appId: 'a', projectId: null },
    });
    const route = withApiV1(async () => new Response('ok', { status: 200 }));

    const res = await route(req());
    expect(res.status).toBe(401);
    await drainAfter();

    expect(writeApiRequestLog).toHaveBeenCalledWith(
      expect.objectContaining({
        keyId: 'k',
        appId: 'a',
        projectId: null,
        status: 401,
        error: 'revoked',
      }),
    );
    expect(touchApiKeyLastUsed).not.toHaveBeenCalled();
  });

  it('does not call the handler when auth fails', async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue({ ok: false, reason: 'unknown_token' });
    const handler = vi.fn(async () => new Response('ok', { status: 200 }));
    const route = withApiV1(handler);

    await route(req());
    expect(handler).not.toHaveBeenCalled();
  });
});
