import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('~/lib/auth', () => ({ authOptions: {} }));
vi.mock('~/lib/audit/audit-log', () => ({
  writeAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { getServerSession } from 'next-auth';

import { POST } from './route';

const mockedSession = vi.mocked(getServerSession);

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/web-search', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/admin/web-search', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.WEBSEARCH_PROVIDER = 'mock';
  });

  it('returns 401 when unauthenticated', async () => {
    mockedSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ query: 'x' }));
    expect(res.status).toBe(401);
  });

  it('returns 400 with Zod issues on a malformed body', async () => {
    mockedSession.mockResolvedValue({ user: { name: 'admin' } } as never);
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues?: unknown };
    expect(json.issues).toBeDefined();
  });

  it('returns 200 with normalized results for a valid request', async () => {
    mockedSession.mockResolvedValue({ user: { name: 'admin' } } as never);
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
