import { describe, expect, it } from 'vitest';

import type { BetcoCandidate } from '~/lib/recommendations/candidate-retrieval';
import {
  recommendCrossReference,
  type RecommendCrossReferenceDeps,
} from '~/lib/recommendations/recommend-cross-reference';
import type { EnrichedCompetitorSpec } from '~/lib/websearch/enrich-competitor-spec';
import { MockWebSearchProvider } from '~/lib/websearch/mock-provider';
import { WebSearchService } from '~/lib/websearch/web-search-service';

const SPEC: EnrichedCompetitorSpec = {
  chemistryClass: 'quat',
  epaRegistration: '6836-361',
  contactTimeSeconds: 60,
  dilutionOzPerGal: 2,
  productCategory: 'disinfectant',
  primaryUse: 'surface disinfection',
  formFactor: 'RTU',
  keyClaims: ['kills 99.9%'],
  provenance: {
    chemistryClass: null, epaRegistration: null, contactTimeSeconds: null, dilutionOzPerGal: null,
    productCategory: null, primaryUse: null, formFactor: null, keyClaims: null,
  },
};

const candidate = (similarity: number, key = 'PK'): BetcoCandidate => ({
  betcoProductKey: key,
  betcoProductLineKey: null,
  sku: null,
  title: `Betco ${key}`,
  similarity,
  url: `https://betco.com/${key}`,
  documentId: `d-${key}`,
  evidence: 'evidence',
});

const legacyConfident = {
  ok: true,
  fallbackRecommended: false,
  normalizedInput: { brand: 'spartan', productName: 'bnc 15' },
  totalCandidates: 1,
  matches: [
    {
      productKey: '333B5-00',
      betcoProductId: 333,
      betcoProduct: { title: 'Triforce' },
      confidence: 0.92,
      matchType: 'exact',
      productUrl: 'https://betco.com/triforce',
      legacyRowId: 'r1',
    },
  ],
} as unknown as Awaited<ReturnType<RecommendCrossReferenceDeps['lookupInternal']>>;

const legacyMiss = {
  ok: true,
  fallbackRecommended: true,
  normalizedInput: {},
  totalCandidates: 0,
  matches: [],
} as unknown as Awaited<ReturnType<RecommendCrossReferenceDeps['lookupInternal']>>;

const webVia = (candidates: BetcoCandidate[]): Omit<RecommendCrossReferenceDeps, 'lookupInternal'> => ({
  fetchWeb: (query) => new WebSearchService(new MockWebSearchProvider()).search({ query }),
  enrich: async () => SPEC,
  retrieve: async () => candidates,
});

describe('recommendCrossReference (B0-85)', () => {
  it('returns a confident legacy match without spending a web search', async () => {
    let webCalled = false;
    const result = await recommendCrossReference(
      { competitorProduct: 'BNC-15', competitorBrand: 'Spartan' },
      {
        lookupInternal: async () => legacyConfident,
        fetchWeb: async () => { webCalled = true; throw new Error('should not fetch web'); },
        enrich: async () => SPEC,
        retrieve: async () => [],
      },
    );
    expect(webCalled).toBe(false);
    expect(result.source).toBe('legacy');
    expect(result.answered).toBe(true);
    expect(result.candidates[0]).toMatchObject({ betcoTitle: 'Triforce', betcoProductKey: '333B5-00', rank: 1 });
    expect(result.overallConfidence).toBe(0.92);
  });

  it('falls through to the web path and answers when confidence clears the gate', async () => {
    const result = await recommendCrossReference(
      { competitorProduct: 'Unknown Cleaner X', competitorBrand: 'Acme' },
      { lookupInternal: async () => legacyMiss, ...webVia([candidate(0.95, 'A'), candidate(0.9, 'B')]) },
    );
    expect(result.source).toBe('web');
    expect(result.answered).toBe(true);
    expect(result.declineReason).toBeNull();
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[0].betcoProductKey).toBe('A');
    expect(result.evidence.source).toBe('web');
  });

  it('declines on the web path when confidence is below threshold (still returned)', async () => {
    const result = await recommendCrossReference(
      { competitorProduct: 'Obscure Product' }, // no brand → penalty
      { lookupInternal: async () => legacyMiss, ...webVia([candidate(0.45, 'A')]) },
    );
    expect(result.source).toBe('web');
    expect(result.answered).toBe(false);
    expect(result.overallConfidence).toBeLessThan(0.8);
    expect(result.declineReason).toBeTruthy();
    expect(result.candidates).toHaveLength(1); // decline still carries the (weak) candidates
  });
});
