import { describe, expect, it } from 'vitest';

import type { BetcoCandidate } from '~/lib/recommendations/candidate-retrieval';
import { XREF_DECLINE_COPY } from '~/lib/recommendations/confidence-scoring';
import {
  loadXrefLatencyPolicy,
  recommendCrossReference,
  type RecommendCrossReferenceDeps,
  type XrefLatencyPolicy,
  type XrefTimingBreakdown,
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
  keySource: 'direct_match',
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

const webSearchOk = async () => ({
  response: await new WebSearchService(new MockWebSearchProvider()).search({ query: 'competitor spec' }),
  searchesUsed: 1,
  estimatedCostUsd: 0,
  budgetExceeded: false,
  escalated: false,
});

const webVia = (candidates: BetcoCandidate[]): Omit<RecommendCrossReferenceDeps, 'lookupInternal'> => ({
  searchWeb: webSearchOk,
  enrich: async () => SPEC,
  retrieve: async () => candidates,
  filterGrounded: async (cands) => ({ grounded: cands, dropped: [] }),
  validate: async () => APPROVED_VALIDATOR,
});

/** A step that never settles — the thing the B0-329 ceiling exists to bound. */
const never = () => new Promise<never>(() => {});

/** Tight budgets so the ceiling tests finish in milliseconds. */
const FAST_POLICY: XrefLatencyPolicy = {
  totalBudgetMs: 200,
  webSearchBudgetMs: 40,
  enrichBudgetMs: 40,
  retrieveBudgetMs: 40,
  validateBudgetMs: 40,
};

const legacyWeak = {
  ok: true,
  fallbackRecommended: true,
  normalizedInput: { brand: 'spartan', productName: 'bnc 15' },
  totalCandidates: 4,
  matches: [
    {
      productKey: '111A1-00',
      betcoProductId: 111,
      betcoProduct: { title: 'Weak Match' },
      confidence: 0.61,
      matchType: 'fuzzy',
      productUrl: 'https://betco.com/weak',
      legacyRowId: 'r9',
    },
  ],
} as unknown as Awaited<ReturnType<RecommendCrossReferenceDeps['lookupInternal']>>;

describe('recommendCrossReference (B0-85)', () => {
  it('returns a confident legacy match without spending a web search', async () => {
    let webCalled = false;
    const result = await recommendCrossReference(
      { competitorProduct: 'BNC-15', competitorBrand: 'Spartan' },
      {
        lookupInternal: async () => legacyConfident,
        searchWeb: async () => { webCalled = true; throw new Error('should not search web'); },
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

  it('B0-442: a line-representative candidate carries its betcoProductKey and an honest rationale', async () => {
    const lineRepCandidate: BetcoCandidate = {
      betcoProductKey: 'REP-PK-1',
      betcoProductLineKey: 'L1',
      sku: 'GEP-1',
      title: 'Green Earth Peroxide Cleaner',
      similarity: 0.95,
      url: 'https://betco.com/rep-pk-1',
      documentId: 'd-line',
      evidence: 'evidence',
      keySource: 'line_representative',
    };
    const result = await recommendCrossReference(
      { competitorProduct: 'Unknown Cleaner X', competitorBrand: 'Acme' },
      { lookupInternal: async () => legacyMiss, ...webVia([lineRepCandidate]) },
    );
    expect(result.candidates[0]).toMatchObject({ betcoProductKey: 'REP-PK-1' });
    expect(result.candidates[0].rationale).toMatch(/representative product/i);
    expect(result.candidates[0].source).toMatchObject({ keySource: 'line_representative' });
  });

  it('B0-442: a line-only candidate (no resolvable key) is honestly marked, not silently dropped', async () => {
    const lineOnlyCandidate: BetcoCandidate = {
      betcoProductKey: null,
      betcoProductLineKey: 'L-NO-REP',
      sku: null,
      title: 'Some Line Only Match',
      similarity: 0.95,
      url: null,
      documentId: 'd-line-only',
      evidence: 'evidence',
      keySource: 'line_only',
    };
    const result = await recommendCrossReference(
      { competitorProduct: 'Unknown Cleaner Y', competitorBrand: 'Acme' },
      {
        lookupInternal: async () => legacyMiss,
        ...webVia([lineOnlyCandidate]),
        // Grounding would normally check the line key against legacy.products_attr; here we just
        // pass the (single) candidate through to isolate the rationale/source marking.
        filterGrounded: async (cands) => ({ grounded: cands, dropped: [] }),
      },
    );
    expect(result.candidates[0]).toMatchObject({ betcoProductKey: null });
    expect(result.candidates[0].rationale).toMatch(/no representative product/i);
    expect(result.candidates[0].source).toMatchObject({ keySource: 'line_only' });
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

  it('B0-353: a validator that requires human review forces status=escalated and declines', async () => {
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
    expect(result.status).toBe('escalated');
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

  it('B0-92: declines with no candidates when the web-search budget is exceeded', async () => {
    const result = await recommendCrossReference(
      { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
      {
        lookupInternal: async () => legacyMiss,
        searchWeb: async () => ({
          response: null,
          searchesUsed: 0,
          estimatedCostUsd: 0,
          budgetExceeded: true,
          escalated: false,
        }),
        enrich: async () => SPEC,
        retrieve: async () => [candidate(0.95, 'A')], // would clear the gate, but never reached
        filterGrounded: async (cands) => ({ grounded: cands, dropped: [] }),
        validate: async () => APPROVED_VALIDATOR,
      },
    );
    expect(result.source).toBe('web');
    expect(result.answered).toBe(false);
    expect(result.status).toBe('declined');
    expect(result.candidates).toEqual([]);
    expect((result.evidence.webSearch as { budgetExceeded: boolean }).budgetExceeded).toBe(true);
  });
});

describe('B0-322: step 1 reuses the turn-scoped legacy lookup', () => {
  it('prefers lookupInternalCached and records the cache hit in the timing breakdown', async () => {
    let uncachedCalls = 0;
    const result = await recommendCrossReference(
      { competitorProduct: 'BNC-15', competitorBrand: 'Spartan' },
      {
        lookupInternal: async () => {
          uncachedCalls += 1;
          return legacyConfident;
        },
        lookupInternalCached: async () => ({ result: legacyConfident, cacheHit: true }),
        searchWeb: async () => { throw new Error('should not search web'); },
        enrich: async () => SPEC,
        retrieve: async () => [],
        filterGrounded: async (cands) => ({ grounded: cands, dropped: [] }),
        validate: async () => APPROVED_VALIDATOR,
      },
    );
    expect(uncachedCalls).toBe(0); // no second legacy query
    expect(result.source).toBe('legacy');
    expect((result.evidence.timingBreakdown as XrefTimingBreakdown).legacyCacheHit).toBe(true);
  });

  it('asks for exactly 3 legacy matches (the key the lookup_cross_reference tool call shares)', async () => {
    const seen: Array<{ brand: string; productName: string; maxResults?: number }> = [];
    await recommendCrossReference(
      { competitorProduct: 'BNC-15', competitorBrand: '  Spartan  ' },
      {
        lookupInternal: async () => legacyConfident,
        lookupInternalCached: async (arg) => {
          seen.push(arg);
          return { result: legacyConfident, cacheHit: false };
        },
        searchWeb: async () => { throw new Error('should not search web'); },
        enrich: async () => SPEC,
        retrieve: async () => [],
        filterGrounded: async (cands) => ({ grounded: cands, dropped: [] }),
        validate: async () => APPROVED_VALIDATOR,
      },
    );
    expect(seen).toEqual([{ brand: 'Spartan', productName: 'BNC-15', maxResults: 3 }]);
  });

  it('falls back to lookupInternal (cacheHit false) when no cached variant is injected', async () => {
    const result = await recommendCrossReference(
      { competitorProduct: 'BNC-15', competitorBrand: 'Spartan' },
      {
        lookupInternal: async () => legacyConfident,
        searchWeb: async () => { throw new Error('should not search web'); },
        enrich: async () => SPEC,
        retrieve: async () => [],
        filterGrounded: async (cands) => ({ grounded: cands, dropped: [] }),
        validate: async () => APPROVED_VALIDATOR,
      },
    );
    expect((result.evidence.timingBreakdown as XrefTimingBreakdown).legacyCacheHit).toBe(false);
  });
});

describe('B0-323: sub-step timing breakdown', () => {
  it('records only step 1 on the confident-legacy fast path', async () => {
    const result = await recommendCrossReference(
      { competitorProduct: 'BNC-15', competitorBrand: 'Spartan' },
      {
        lookupInternal: async () => legacyConfident,
        searchWeb: async () => { throw new Error('should not search web'); },
        enrich: async () => SPEC,
        retrieve: async () => [],
        filterGrounded: async (cands) => ({ grounded: cands, dropped: [] }),
        validate: async () => APPROVED_VALIDATOR,
      },
    );
    const timing = result.evidence.timingBreakdown as XrefTimingBreakdown;
    expect(timing.stepsRun).toEqual(['legacyLookup']);
    expect(timing.legacyLookupMs).toBeGreaterThanOrEqual(0);
    expect(timing.webSearchMs).toBeNull();
    expect(timing.enrichMs).toBeNull();
    expect(timing.retrieveMs).toBeNull();
    expect(timing.filterGroundedMs).toBeNull();
    expect(timing.validateMs).toBeNull();
    expect(timing.searchesUsed).toBeNull();
    expect(timing.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('records every sub-step plus the web-search count on the full web path', async () => {
    const result = await recommendCrossReference(
      { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
      { lookupInternal: async () => legacyMiss, ...webVia([candidate(0.95, 'A'), candidate(0.92, 'B')]) },
    );
    const timing = result.evidence.timingBreakdown as XrefTimingBreakdown;
    expect(timing.stepsRun).toEqual([
      'legacyLookup',
      'webSearch',
      'enrich',
      'retrieve',
      'filterGrounded',
      'validate',
    ]);
    for (const step of ['legacyLookupMs', 'webSearchMs', 'enrichMs', 'retrieveMs', 'filterGroundedMs', 'validateMs'] as const) {
      expect(timing[step]).toBeGreaterThanOrEqual(0);
    }
    expect(timing.searchesUsed).toBe(1);
    expect(timing.escalated).toBe(false);
  });

  it('attributes a measurably slow sub-step to that step', async () => {
    const slow = () => new Promise((resolve) => setTimeout(resolve, 30));
    const result = await recommendCrossReference(
      { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
      {
        lookupInternal: async () => legacyMiss,
        ...webVia([candidate(0.95, 'A')]),
        enrich: async () => {
          await slow();
          return SPEC;
        },
      },
    );
    const timing = result.evidence.timingBreakdown as XrefTimingBreakdown;
    expect(timing.enrichMs ?? 0).toBeGreaterThanOrEqual(25);
    expect(timing.totalMs).toBeGreaterThanOrEqual(timing.enrichMs ?? 0);
  });

  it('records the timed-out step in the breakdown', async () => {
    const result = await recommendCrossReference(
      { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
      {
        lookupInternal: async () => legacyMiss,
        ...webVia([candidate(0.95, 'A')]),
        enrich: () => never(),
      },
      { ...FAST_POLICY, enrichBudgetMs: 10 },
    );
    const timing = result.evidence.timingBreakdown as XrefTimingBreakdown;
    expect(timing.timedOutStep).toBe('enrich');
    expect(timing.enrichMs).toBeGreaterThanOrEqual(0);
    expect(timing.stepsRun).toContain('enrich');
  });

  it('records timing even when the web-search budget short-circuits the run', async () => {
    const result = await recommendCrossReference(
      { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
      {
        lookupInternal: async () => legacyMiss,
        searchWeb: async () => ({
          response: null,
          searchesUsed: 0,
          estimatedCostUsd: 0,
          budgetExceeded: true,
          escalated: false,
        }),
        enrich: async () => SPEC,
        retrieve: async () => [],
        filterGrounded: async (cands) => ({ grounded: cands, dropped: [] }),
        validate: async () => APPROVED_VALIDATOR,
      },
    );
    const timing = result.evidence.timingBreakdown as XrefTimingBreakdown;
    expect(timing.stepsRun).toEqual(['legacyLookup', 'webSearch']);
    expect(timing.searchesUsed).toBe(0);
  });
});

describe('B0-329: latency ceiling / circuit breaker', () => {
  it('caps a hung web search and declines instead of hanging (no legacy match to fall back to)', async () => {
    const startedAt = Date.now();
    const result = await recommendCrossReference(
      { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
      { lookupInternal: async () => legacyMiss, ...webVia([candidate(0.95, 'A')]), searchWeb: () => never() },
      FAST_POLICY,
    );
    expect(Date.now() - startedAt).toBeLessThan(FAST_POLICY.totalBudgetMs + 150);
    expect(result.source).toBe('web');
    expect(result.answered).toBe(false);
    expect(result.status).toBe('declined');
    expect(result.candidates).toEqual([]);
    expect(result.declineReason).toBe(XREF_DECLINE_COPY);
    const timeout = result.evidence.timeout as { timedOut: boolean; step: string; fallback: string };
    expect(timeout).toMatchObject({ timedOut: true, step: 'webSearch', fallback: 'decline' });
  });

  it('falls back to the (weak) legacy matches when a later step times out', async () => {
    const result = await recommendCrossReference(
      { competitorProduct: 'BNC-15', competitorBrand: 'Spartan' },
      { lookupInternal: async () => legacyWeak, ...webVia([candidate(0.95, 'A')]), enrich: () => never() },
      FAST_POLICY,
    );
    expect(result.source).toBe('legacy');
    // Declined, NOT pending: a cut-short run must not enter the human-review queue, which is
    // reserved for prompts that ran as far as they could. Candidates are still carried as evidence.
    expect(result.status).toBe('declined');
    expect(result.answered).toBe(false);
    expect(result.declineReason).toBe(XREF_DECLINE_COPY);
    expect(result.candidates.map((c) => c.betcoProductKey)).toEqual(['111A1-00']);
    expect(result.overallConfidence).toBe(0.61);
    const timeout = result.evidence.timeout as { step: string; fallback: string };
    expect(timeout).toMatchObject({ step: 'enrich', fallback: 'legacy_matches' });
    // Step-2 telemetry gathered before the timeout survives into the evidence payload.
    expect(result.evidence.webSearch).toMatchObject({ searchesUsed: 1 });
  });

  it('caps a hung validator (step 5) and still returns a well-formed result', async () => {
    const result = await recommendCrossReference(
      { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
      {
        lookupInternal: async () => legacyMiss,
        ...webVia([candidate(0.95, 'A'), candidate(0.93, 'B')]),
        validate: () => never(),
      },
      FAST_POLICY,
    );
    expect(result.status).toBe('declined');
    expect(result.answered).toBe(false);
    expect((result.evidence.timeout as { step: string }).step).toBe('validate');
    expect((result.evidence.timingBreakdown as XrefTimingBreakdown).timedOutStep).toBe('validate');
  });

  it('never exceeds the total budget even when every step is slow', async () => {
    const slowish = <T>(value: T) => new Promise<T>((resolve) => setTimeout(() => resolve(value), 60));
    const startedAt = Date.now();
    const result = await recommendCrossReference(
      { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
      {
        lookupInternal: async () => legacyMiss,
        ...webVia([candidate(0.95, 'A')]),
        searchWeb: async () => slowish(await webSearchOk()),
        enrich: () => slowish(SPEC),
        retrieve: () => slowish([candidate(0.95, 'A')]),
      },
      { ...FAST_POLICY, totalBudgetMs: 100, webSearchBudgetMs: 500, enrichBudgetMs: 500, retrieveBudgetMs: 500 },
    );
    expect(Date.now() - startedAt).toBeLessThan(400);
    expect((result.evidence.timeout as { timedOut: boolean }).timedOut).toBe(true);
  });

  it('turns an outright step failure into the same defined fallback (never an unhandled error)', async () => {
    const result = await recommendCrossReference(
      { competitorProduct: 'BNC-15', competitorBrand: 'Spartan' },
      {
        lookupInternal: async () => legacyWeak,
        ...webVia([candidate(0.95, 'A')]),
        enrich: async () => {
          throw new Error('enrichment provider exploded');
        },
      },
      FAST_POLICY,
    );
    expect(result.status).toBe('declined');
    const timeout = result.evidence.timeout as { timedOut: boolean; reason: string; message: string };
    expect(timeout).toMatchObject({ timedOut: false, reason: 'step_failure' });
    expect(timeout.message).toContain('enrichment provider exploded');
  });

  it('declines when step 1 itself blows the total budget', async () => {
    const result = await recommendCrossReference(
      { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
      { lookupInternal: () => never(), ...webVia([candidate(0.95, 'A')]) },
      { ...FAST_POLICY, totalBudgetMs: 30 },
    );
    expect(result.status).toBe('declined');
    expect(result.candidates).toEqual([]);
    expect((result.evidence.timeout as { step: string }).step).toBe('legacyLookup');
  });

  it('still propagates a hard legacy-lookup failure (unchanged tool-error behavior)', async () => {
    await expect(
      recommendCrossReference(
        { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
        {
          lookupInternal: async () => {
            throw new Error('legacy database unavailable');
          },
          ...webVia([candidate(0.95, 'A')]),
        },
        FAST_POLICY,
      ),
    ).rejects.toThrow('legacy database unavailable');
  });

  it('leaves the happy path untouched when nothing is slow', async () => {
    const result = await recommendCrossReference(
      { competitorProduct: 'Cleaner X', competitorBrand: 'Acme' },
      { lookupInternal: async () => legacyMiss, ...webVia([candidate(0.95, 'A'), candidate(0.9, 'B')]) },
      FAST_POLICY,
    );
    expect(result.answered).toBe(true);
    expect(result.status).toBe('answered');
    expect(result.evidence.timeout).toBeUndefined();
    expect((result.evidence.timingBreakdown as XrefTimingBreakdown).timedOutStep).toBeNull();
  });
});

describe('loadXrefLatencyPolicy (B0-329)', () => {
  it('defaults every budget and honors env overrides without a code change', () => {
    expect(loadXrefLatencyPolicy({} as NodeJS.ProcessEnv)).toEqual({
      totalBudgetMs: 20_000,
      webSearchBudgetMs: 12_000,
      enrichBudgetMs: 8_000,
      retrieveBudgetMs: 8_000,
      validateBudgetMs: 8_000,
    });
    expect(
      loadXrefLatencyPolicy({
        XREF_RECOMMENDATION_TIMEOUT_MS: '9000',
        XREF_WEB_SEARCH_TIMEOUT_MS: '4000',
        XREF_ENRICH_TIMEOUT_MS: '3000',
        XREF_RETRIEVE_TIMEOUT_MS: '2000',
        XREF_VALIDATE_TIMEOUT_MS: '1000',
      } as NodeJS.ProcessEnv),
    ).toEqual({
      totalBudgetMs: 9000,
      webSearchBudgetMs: 4000,
      enrichBudgetMs: 3000,
      retrieveBudgetMs: 2000,
      validateBudgetMs: 1000,
    });
    // Garbage / non-positive values fall back to the defaults rather than disabling the ceiling.
    expect(
      loadXrefLatencyPolicy({ XREF_RECOMMENDATION_TIMEOUT_MS: '0' } as NodeJS.ProcessEnv).totalBudgetMs,
    ).toBe(20_000);
    expect(
      loadXrefLatencyPolicy({ XREF_RECOMMENDATION_TIMEOUT_MS: 'soon' } as NodeJS.ProcessEnv).totalBudgetMs,
    ).toBe(20_000);
  });
});
