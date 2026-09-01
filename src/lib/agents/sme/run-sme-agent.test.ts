import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-779 — the `cross_reference` SME agent (`runCrossReferenceSmeAgentAnswer`, only reachable via
 * `runSmeAgent`) is one of the two callers that resolve competitor identity from raw query text via
 * `extractCompetitorProduct` and then call `runCrossReferenceRecommendation` directly (no model
 * chat loop of its own — see `run-sme-agent.ts`'s own docstring). PRO-045/PRO-036 both fabricated a
 * "Comparable Betco product" match line for a message that named no resolvable competitor; this
 * guards that shape at this call site.
 */

const extractCompetitorProductMock = vi.fn();
const runCrossReferenceRecommendationMock = vi.fn();

vi.mock('~/lib/recommendations/extract-competitor-product', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('~/lib/recommendations/extract-competitor-product')>();
  return {
    ...actual,
    extractCompetitorProduct: (...args: unknown[]) => extractCompetitorProductMock(...args),
  };
});

vi.mock('~/lib/recommendations/persist-recommendation', () => ({
  runCrossReferenceRecommendation: (...args: unknown[]) =>
    runCrossReferenceRecommendationMock(...args),
}));

import { runSmeAgent } from '~/lib/agents/sme/run-sme-agent';

function engineResult(overrides: Record<string, unknown> = {}) {
  return {
    source: 'web',
    answered: true,
    status: 'answered',
    overallConfidence: 0.83,
    thresholdUsed: 0.8,
    candidates: [
      {
        betcoTitle: 'Portable Chemical Management System',
        url: 'https://www.betco.com/products/portable-chemical-management-system',
        rationale: null,
        rank: 1,
        tier: 'primary',
      },
    ],
    evidence: {},
    declineReason: null,
    recommendationId: 'rec-1',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('cross_reference SME agent — competitor identity guard (B0-779)', () => {
  it('declines and never calls the engine when no competitor brand or product can be resolved', async () => {
    extractCompetitorProductMock.mockResolvedValue({
      brand: null,
      product: 'what should I replace my current dispensing system with',
      otherCompetitorProduct: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 },
      resolved: false,
    });

    const result = await runSmeAgent('cross_reference', {
      query: 'What should I replace my current dispensing system with?',
    });

    expect(runCrossReferenceRecommendationMock).not.toHaveBeenCalled();
    expect(result.answer?.answerText).not.toContain('Comparable Betco product');
    expect(result.answer?.confidence).toBe(0);
  });

  it('reproduces the PRO-045 shape: an unresolved extraction never renders a match line even if the engine would have', async () => {
    extractCompetitorProductMock.mockResolvedValue({
      brand: null,
      product: 'What should I replace my current dispensing system with?',
      otherCompetitorProduct: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 },
      resolved: false,
    });
    // Even if the engine WOULD have fabricated an answered match from the raw text, it must never
    // be given the chance — the guard short-circuits before this mock is ever consulted.
    runCrossReferenceRecommendationMock.mockResolvedValue(engineResult());

    const result = await runSmeAgent('cross_reference', {
      query: 'What should I replace my current dispensing system with?',
    });

    expect(runCrossReferenceRecommendationMock).not.toHaveBeenCalled();
    expect(result.answer?.answerText).not.toContain('Comparable Betco product');
  });

  it('still calls the engine and surfaces its match for a confidently-resolved competitor (no regression)', async () => {
    extractCompetitorProductMock.mockResolvedValue({
      brand: 'Spartan',
      product: 'BNC-15',
      otherCompetitorProduct: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 },
      resolved: true,
    });
    runCrossReferenceRecommendationMock.mockResolvedValue(
      engineResult({
        candidates: [
          {
            betcoTitle: 'Triforce',
            url: 'https://www.betco.com/products/triforce',
            rationale: null,
            rank: 1,
            tier: 'primary',
          },
        ],
      }),
    );

    const result = await runSmeAgent('cross_reference', {
      query: 'What is the Betco equivalent to Spartan BNC-15?',
    });

    expect(runCrossReferenceRecommendationMock).toHaveBeenCalledTimes(1);
    expect(runCrossReferenceRecommendationMock).toHaveBeenCalledWith(
      { competitorProduct: 'BNC-15', competitorBrand: 'Spartan' },
      expect.anything(),
    );
    expect(result.answer?.answerText).toContain('Comparable Betco product');
    expect(result.answer?.answerText).toContain('Triforce');
  });

  it('still calls the engine when a product is confidently resolved with no brand (no regression)', async () => {
    extractCompetitorProductMock.mockResolvedValue({
      brand: null,
      product: 'BNC-15',
      otherCompetitorProduct: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 },
      resolved: true,
    });
    runCrossReferenceRecommendationMock.mockResolvedValue(engineResult());

    await runSmeAgent('cross_reference', { query: 'What replaces BNC-15?' });

    expect(runCrossReferenceRecommendationMock).toHaveBeenCalledTimes(1);
  });

  it('trusts session-context-supplied identity without running the guard (caller already confirmed it)', async () => {
    runCrossReferenceRecommendationMock.mockResolvedValue(engineResult());

    await runSmeAgent('cross_reference', {
      query: 'compare to what we use now',
      context: { competitorProduct: 'BNC-15', competitorBrand: 'Spartan' },
    });

    expect(extractCompetitorProductMock).not.toHaveBeenCalled();
    expect(runCrossReferenceRecommendationMock).toHaveBeenCalledTimes(1);
  });
});
