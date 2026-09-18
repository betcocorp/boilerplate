import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next-auth', () => ({ getServerSession: vi.fn() }));
vi.mock('~/lib/auth', () => ({ authOptions: {} }));
vi.mock('~/lib/recommendations/persist-recommendation', () => ({
  runCrossReferenceRecommendation: vi.fn(),
}));
// B0-1056 — the route now records a real conversation + workflow_runs row so its trace links to
// /admin/observability/[runId]; these tests exercise the route's auth/validation/response shape,
// not persistence, so the DB-touching repositories are stubbed.
vi.mock('~/lib/conversations/conversation-repository', () => ({
  createConversation: vi.fn().mockResolvedValue({ id: 'conversation-1' }),
}));
vi.mock('~/lib/conversations/workflow-repository', () => ({
  insertWorkflowRun: vi.fn().mockResolvedValue({ id: 'run-1' }),
  updateWorkflowRun: vi.fn().mockResolvedValue(undefined),
}));

import { getServerSession } from 'next-auth';

import { runCrossReferenceRecommendation } from '~/lib/recommendations/persist-recommendation';
import { POST } from './route';

const mockedSession = vi.mocked(getServerSession);
const mockedRun = vi.mocked(runCrossReferenceRecommendation);

function makeRequest(body: unknown): Request {
  return new Request('http://localhost/api/admin/tools/cross-reference-recommend', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const RESULT = {
  source: 'web' as const,
  answered: true,
  status: 'answered' as const,
  overallConfidence: 0.86,
  thresholdUsed: 0.8,
  candidates: [
    { betcoProductKey: 'A', betcoProdId: null, betcoTitle: 'Betco A', confidence: 0.9, rank: 1, url: null, rationale: null, source: {} },
    { betcoProductKey: 'B', betcoProdId: null, betcoTitle: 'Betco B', confidence: 0.8, rank: 2, url: null, rationale: null, source: {} },
  ],
  evidence: { source: 'web' },
  declineReason: null,
  recommendationId: 'rec-1',
};

describe('POST /api/admin/tools/cross-reference-recommend (B0-94)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns 401 when unauthenticated', async () => {
    mockedSession.mockResolvedValue(null);
    const res = await POST(makeRequest({ competitorProduct: 'X' }));
    expect(res.status).toBe(401);
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it('returns 400 with Zod issues when competitorProduct is missing', async () => {
    mockedSession.mockResolvedValue({ user: { name: 'admin' } } as never);
    const res = await POST(makeRequest({ competitorBrand: 'Acme' }));
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues?: unknown };
    expect(json.issues).toBeDefined();
  });

  it('returns 200 with the recommendation + recommendationId for a valid request', async () => {
    mockedSession.mockResolvedValue({ user: { email: 'admin@betco.com' } } as never);
    mockedRun.mockResolvedValue(RESULT);
    const res = await POST(makeRequest({ competitorProduct: 'Cleaner X', competitorBrand: 'Acme' }));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { recommendationId: string; status: string; candidates: unknown[] };
    expect(json.recommendationId).toBe('rec-1');
    expect(json.status).toBe('answered');
    expect(mockedRun).toHaveBeenCalledWith(
      { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
      expect.objectContaining({ createdBy: 'admin@betco.com' }),
    );
  });

  it('caps returned candidates to maxResults', async () => {
    mockedSession.mockResolvedValue({ user: { name: 'admin' } } as never);
    mockedRun.mockResolvedValue(RESULT);
    const res = await POST(makeRequest({ competitorProduct: 'Cleaner X', maxResults: 1 }));
    const json = (await res.json()) as { candidates: unknown[] };
    expect(json.candidates).toHaveLength(1);
  });
});
