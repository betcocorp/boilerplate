import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/recommendations/persist-recommendation', () => ({
  runCrossReferenceRecommendation: vi.fn(),
}));

// B0-1056 — the tool case's guard calls this on an implausible/self-referential identity instead
// of the real (settings-backed) implementation, so these tests don't need a DB connection.
const buildUnresolvedCompetitorDeclineMock = vi.fn().mockResolvedValue({
  source: 'web',
  answered: false,
  status: 'declined',
  overallConfidence: 0,
  thresholdUsed: 0.8,
  candidates: [],
  evidence: { source: 'web', reason: 'competitor_identity_unresolved' },
  declineReason: 'Please contact a Betco sales representative.',
  recommendationId: null,
});
vi.mock('~/lib/recommendations/recommend-cross-reference', () => ({
  buildUnresolvedCompetitorDecline: () => buildUnresolvedCompetitorDeclineMock(),
}));

import { runCrossReferenceRecommendation } from '~/lib/recommendations/persist-recommendation';
import { executeProductTool } from '~/lib/tools/product-tools';

type Result = Awaited<ReturnType<typeof runCrossReferenceRecommendation>>;

const candidate = (key: string) => ({
  betcoProductKey: key,
  betcoProdId: null,
  betcoTitle: `Betco ${key}`,
  confidence: 0.9,
  rank: 1,
  url: `https://betco.com/${key}`,
  rationale: null,
  source: {},
});

describe('recommend_cross_reference tool (B0-93)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });


  it('dispatches to runCrossReferenceRecommendation and maps the result', async () => {
    vi.mocked(runCrossReferenceRecommendation).mockResolvedValue({
      source: 'web',
      answered: true,
      overallConfidence: 0.86,
      thresholdUsed: 0.8,
      candidates: [candidate('PK1')],
      evidence: { source: 'web' },
      declineReason: null,
      recommendationId: 'rec-1',
    } as Result);

    const out = await executeProductTool('recommend_cross_reference', {
      competitorProduct: 'BNC-15',
      competitorBrand: 'Spartan',
    });

    expect(runCrossReferenceRecommendation).toHaveBeenCalledWith(
      {
        competitorProduct: 'BNC-15',
        competitorBrand: 'Spartan',
      },
      undefined,
    );
    expect(out).toMatchObject({
      ok: true,
      adapter: 'cross_reference_recommendation_v1',
      source: 'web',
      answered: true,
      overallConfidence: 0.86,
      thresholdUsed: 0.8,
      recommendationId: 'rec-1',
    });
    expect(out.candidates).toHaveLength(1);
  });

  it('honors maxResults and relays a decline verbatim', async () => {
    vi.mocked(runCrossReferenceRecommendation).mockResolvedValue({
      source: 'web',
      answered: false,
      overallConfidence: 0.5,
      thresholdUsed: 0.8,
      candidates: [candidate('A'), candidate('B'), candidate('C')],
      evidence: {},
      declineReason: 'Please contact a Betco sales representative.',
      recommendationId: null,
    } as Result);

    const out = await executeProductTool('recommend_cross_reference', {
      competitorProduct: 'Obscure',
      maxResults: 2,
    });
    expect(out.answered).toBe(false);
    expect(out.declineReason).toBe('Please contact a Betco sales representative.');
    expect(out.candidates).toHaveLength(2);
  });

  it('rejects a missing competitorProduct', async () => {
    await expect(executeProductTool('recommend_cross_reference', {})).rejects.toBeTruthy();
  });

  it('B0-1056: threads auditCtx.workflowRunId through as the traceId', async () => {
    vi.mocked(runCrossReferenceRecommendation).mockResolvedValue({
      source: 'web',
      answered: true,
      overallConfidence: 0.86,
      thresholdUsed: 0.8,
      candidates: [],
      evidence: {},
      declineReason: null,
      recommendationId: 'rec-1',
    } as Result);

    await executeProductTool(
      'recommend_cross_reference',
      { competitorProduct: 'BNC-15', competitorBrand: 'Spartan' },
      { traceId: 'turn-trace', workflowRunId: 'run-42' },
    );

    expect(runCrossReferenceRecommendation).toHaveBeenCalledWith(
      { competitorProduct: 'BNC-15', competitorBrand: 'Spartan' },
      { traceId: 'run-42' },
    );
  });

  it('B0-1056: declines a non-competitor question without calling the engine or persisting', async () => {
    const out = await executeProductTool('recommend_cross_reference', {
      competitorProduct: 'Why does the grout stay dirty even after we mop it?',
    });

    expect(runCrossReferenceRecommendation).not.toHaveBeenCalled();
    expect(buildUnresolvedCompetitorDeclineMock).toHaveBeenCalledTimes(1);
    expect(out.answered).toBe(false);
    expect(out.recommendationId).toBeNull();
  });

  it('B0-1056: declines when the model names one of Betco\'s own brands as the "competitor"', async () => {
    const out = await executeProductTool('recommend_cross_reference', {
      competitorProduct: 'Grease Solv',
      competitorBrand: 'Betco',
    });

    expect(runCrossReferenceRecommendation).not.toHaveBeenCalled();
    expect(buildUnresolvedCompetitorDeclineMock).toHaveBeenCalledTimes(1);
    expect(out.answered).toBe(false);
  });
});
