import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/api/client-auth', () => ({
  authenticateApiToken: vi.fn(),
  unauthorizedResponse: () =>
    new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
}));
vi.mock('~/lib/audit/audit-log', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { authenticateApiToken } from '~/lib/api/client-auth';

import { POST } from './route';

const mockedAuth = vi.mocked(authenticateApiToken);

function authOk() {
  mockedAuth.mockResolvedValue({
    ok: true,
    context: {
      keyId: 'key-1',
      appId: 'app-1',
      projectId: 'project-1',
      environment: 'test',
      rateLimitPerMinute: null,
    },
  } as never);
}

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/v1/tools/web-search', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer bex_test_token',
    },
    body: JSON.stringify(body),
  });
}

describe('POST /api/v1/tools/web-search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBSEARCH_PROVIDER = 'mock';
  });

  it('returns 401 when the client token is not authenticated', async () => {
    mockedAuth.mockResolvedValue({ ok: false, reason: 'missing_token' } as never);
    const res = await POST(makeRequest({ query: 'x' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 with Zod issues on a malformed body', async () => {
    authOk();
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues?: unknown };
    expect(json.issues).toBeDefined();
  });

  it('returns 200 with normalized results for a valid request', async () => {
    authOk();
    const res = await POST(makeRequest({ query: 'BNC-15' }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      provider: string;
      results: unknown[];
      metrics: { resultCount: number };
    };
    expect(json.provider).toBe('mock');
    expect(Array.isArray(json.results)).toBe(true);
    expect(json.metrics.resultCount).toBe(json.results.length);
  });
});
