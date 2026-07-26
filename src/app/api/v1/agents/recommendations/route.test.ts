import { beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticateApiToken } from '~/lib/api/client-auth';
import { smeAgentRunResultSchema } from '~/lib/agents/sme/sme-schemas';

import { POST } from './route';

// Mirrors the withApiV1 auth-mocking pattern in `src/lib/api/with-api-v1.test.ts` — this is a
// contract test for the `/api/v1/agents/recommendations` SME agent endpoint (B0-98), the same
// shape other SME agent routes (`product`, `bathroom`, `dilution`, `floor`) share via
// `createSmeAgentPostHandler`, which had no dedicated route test yet.
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

const ACTIVE = {
  ok: true as const,
  context: { keyId: 'k', appId: 'a', projectId: 'p', rateLimitPerMinute: null },
};

function req(body: unknown) {
  return new Request('http://localhost/api/v1/agents/recommendations', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  afterCallbacks.length = 0;
  vi.clearAllMocks();
});

describe('POST /api/v1/agents/recommendations (B0-98 contract test)', () => {
  it('requires a token — 401 when auth fails, and never touches the agent runner', async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue({ ok: false, reason: 'missing_token' });

    const res = await POST(req({ query: 'Betco equivalent for Spartan BNC-15?' }));

    expect(res.status).toBe(401);
  });

  it('400s on an empty query', async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue(ACTIVE);

    const res = await POST(req({ query: '' }));

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });

  it('returns the recommendations agent metadata, matching the shared SME run-result schema', async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue(ACTIVE);

    const res = await POST(
      req({
        query: 'What is the Betco equivalent of Spartan BNC-15?',
        context: { competitorBrand: 'Spartan', competitorProduct: 'BNC-15' },
      }),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.agent).toBe('recommendations');

    // Full contract check against the shared Zod schema every SME agent route must satisfy.
    const parsed = smeAgentRunResultSchema.safeParse(body);
    expect(parsed.success).toBe(true);

    // Recommendations-specific content: the 0.80 confidence gate and required session-context
    // keys must be surfaced, since callers rely on this metadata to know how to invoke the agent.
    expect(body.focusAreas.join(' ')).toMatch(/0\.80/);
    expect(body.sessionContextGuide.join(' ')).toMatch(/competitorBrand/);
    expect(body.sessionContextGuide.join(' ')).toMatch(/competitorProduct/);
    expect(body.context).toEqual({
      competitorBrand: 'Spartan',
      competitorProduct: 'BNC-15',
    });
  });

  it('rejects an unknown/array context shape with 400 rather than silently dropping it', async () => {
    vi.mocked(authenticateApiToken).mockResolvedValue(ACTIVE);

    const res = await POST(req({ query: 'Betco equivalent for X?', context: ['not', 'an', 'object'] }));

    expect(res.status).toBe(400);
  });
});
