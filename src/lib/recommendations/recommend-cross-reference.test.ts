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

const APPROVED_VALIDATOR = {
  approved: true,
  confidence: 1,
  issues: [] as string[],
  requires_human_review: false,
};

const webVia = (candidates: BetcoCandidate[]): Omit<RecommendCrossReferenceDeps, 'lookupInternal'> => ({
  fetchWeb: (query) => new WebSearchService(new MockWebSearchProvider()).search({ query }),
  enrich: async () => SPEC,
  retrieve: async () => candidates,
  filterGrounded: async (cands) => ({ grounded: cands, dropped: [] }),
  validate: async () => APPROVED_VALIDATOR,
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
        filterGrounded: async (cands) => ({ grounded: cands, dropped: [] }),
        validate: async () => APPROVED_VALIDATOR,
      },
    );
    expect(webCalled).toBe(false);
    expect(result.source).toBe('legacy');
    expect(result.answered).toBe(true);
    expect(result.status).toBe('answered');
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

  it('B0-91: drops ungrounded candidates so a fabricated match cannot inflate confidence', async () => {
    // Two strong candidates, but grounding resolves only 'A' to a real legacy row.
    const result = await recommendCrossReference(
      { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
      {
        lookupInternal: async () => legacyMiss,
        ...webVia([candidate(0.95, 'A'), candidate(0.9, 'GHOST')]),
        filterGrounded: async (cands) => ({
          grounded: cands.filter((c) => c.betcoProductKey === 'A'),
          dropped: cands.filter((c) => c.betcoProductKey !== 'A'),
        }),
      },
    );
    expect(result.candidates.map((c) => c.betcoProductKey)).toEqual(['A']);
    expect(result.evidence.droppedCandidates).toBe(1);
  });

  it('B0-91: a validator that requires human review forces status=pending and declines', async () => {
    let validated = false;
    const result = await recommendCrossReference(
      { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
      {
        lookupInternal: async () => legacyMiss,
        ...webVia([candidate(0.95, 'A'), candidate(0.92, 'B')]),
        validate: async () => {
          validated = true;
          return { approved: true, confidence: 0.9, issues: [], requires_human_review: true };
        },
      },
    );
    expect(validated).toBe(true);
    expect(result.answered).toBe(false);
    expect(result.status).toBe('pending');
    expect(result.declineReason).toBeTruthy();
    const validation = result.evidence.validation as { reasons: string[] };
    expect(validation.reasons).toContain('requires_human_review');
  });

  it('B0-91: skips the validator entirely when the confidence gate already declines', async () => {
    let validated = false;
    const result = await recommendCrossReference(
      { competitorProduct: 'Obscure Product' }, // no brand → penalty → sub-threshold
      {
        lookupInternal: async () => legacyMiss,
        ...webVia([candidate(0.4, 'A')]),
        validate: async () => {
          validated = true;
          return APPROVED_VALIDATOR;
        },
      },
    );
    expect(validated).toBe(false);
    expect(result.status).toBe('declined');
  });
});
