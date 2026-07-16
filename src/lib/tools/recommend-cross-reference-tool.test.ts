import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/recommendations/persist-recommendation', () => ({
  runCrossReferenceRecommendation: vi.fn(),
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

    expect(runCrossReferenceRecommendation).toHaveBeenCalledWith({
      competitorProduct: 'BNC-15',
      competitorBrand: 'Spartan',
    });
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
});
