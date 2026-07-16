import { describe, expect, it } from 'vitest';

import {
  buildRecommendationQuery,
  isSearchInconclusive,
  runRecommendationWebSearch,
  type RecommendationSearchPolicy,
  type RecommendationWebSearchDeps,
} from '~/lib/recommendations/recommendation-web-search';
import { WebSearchCache } from '~/lib/websearch/cache';
import { MockWebSearchProvider } from '~/lib/websearch/mock-provider';
import type { ProviderSearchResult } from '~/lib/websearch/types';
import { WebSearchError } from '~/lib/websearch/types';
import { WebSearchService } from '~/lib/websearch/web-search-service';
import type { WebSearchRequest, WebSearchResponse } from '~/lib/websearch/websearch-schemas';

const POLICY: RecommendationSearchPolicy = {
  maxSearches: 2,
  queryBudgetUsd: 1,
  dailyBudgetUsd: 5,
  domainAllowlist: [],
};

const resp = (over: Partial<WebSearchResponse> = {}): WebSearchResponse => ({
  query: 'q',
  provider: 'tavily',
  answer: null,
  results: [{ title: 't', url: 'https://a.example.com', snippet: 'x'.repeat(60), score: 0.9 }],
  metrics: { latencyMs: 1, resultCount: 1, estimatedCostUsd: 0.008, cached: false },
  ...over,
});

const noBudget = { getDailySpendUsd: () => 0, recordDailySpendUsd: () => {} };

describe('isSearchInconclusive (B0-92)', () => {
  it('is inconclusive when there are no results', () => {
    expect(isSearchInconclusive(resp({ results: [] }))).toBe(true);
  });
  it('is inconclusive when the top score is low', () => {
    expect(
      isSearchInconclusive(resp({ results: [{ title: 't', url: 'https://a', snippet: 'x'.repeat(60), score: 0.1 }] })),
    ).toBe(true);
  });
  it('is conclusive with substantial, high-scoring content', () => {
    expect(isSearchInconclusive(resp())).toBe(false);
  });
});

describe('runRecommendationWebSearch (B0-92)', () => {
  it('does one basic search and does not escalate when the first pass is conclusive', async () => {
    const reqs: WebSearchRequest[] = [];
    const deps: RecommendationWebSearchDeps = {
      search: async (r) => { reqs.push(r); return resp(); },
      ...noBudget,
    };
    const out = await runRecommendationWebSearch({ brand: 'Acme', product: 'X' }, deps, POLICY);
    expect(out.searchesUsed).toBe(1);
    expect(out.escalated).toBe(false);
    expect(reqs[0].depth).toBe('basic');
  });

  it('escalates to an advanced search when the first pass is inconclusive (capped at 2)', async () => {
    const reqs: WebSearchRequest[] = [];
    let call = 0;
    const deps: RecommendationWebSearchDeps = {
      search: async (r) => {
        reqs.push(r);
        call += 1;
        return call === 1 ? resp({ results: [] }) : resp();
      },
      ...noBudget,
    };
    const out = await runRecommendationWebSearch({ brand: 'Acme', product: 'X' }, deps, POLICY);
    expect(out.searchesUsed).toBe(2);
    expect(out.escalated).toBe(true);
    expect(reqs.map((r) => r.depth)).toEqual(['basic', 'advanced']);
  });

  it('never exceeds maxSearches even when still inconclusive', async () => {
    let call = 0;
    const deps: RecommendationWebSearchDeps = {
      search: async () => { call += 1; return resp({ results: [] }); },
      ...noBudget,
    };
    const out = await runRecommendationWebSearch(
      { brand: 'Acme', product: 'X' },
      deps,
      { ...POLICY, maxSearches: 1 },
    );
    expect(out.searchesUsed).toBe(1);
    expect(out.escalated).toBe(false);
    expect(call).toBe(1);
  });

  it('applies the domain allowlist to every search request', async () => {
    const reqs: WebSearchRequest[] = [];
    const deps: RecommendationWebSearchDeps = {
      search: async (r) => { reqs.push(r); return resp({ results: [] }); },
      ...noBudget,
    };
    await runRecommendationWebSearch(
      { brand: 'Acme', product: 'X' },
      deps,
      { ...POLICY, domainAllowlist: ['epa.gov', 'acme.com'] },
    );
    expect(reqs[0].domains).toEqual(['epa.gov', 'acme.com']);
  });

  it('short-circuits to a budget-exceeded decline when the daily cap is already spent', async () => {
    let searched = false;
    const deps: RecommendationWebSearchDeps = {
      search: async () => { searched = true; return resp(); },
      getDailySpendUsd: () => 10,
      recordDailySpendUsd: () => {},
    };
    const out = await runRecommendationWebSearch({ brand: 'Acme', product: 'X' }, deps, { ...POLICY, dailyBudgetUsd: 5 });
    expect(searched).toBe(false);
    expect(out.response).toBeNull();
    expect(out.budgetExceeded).toBe(true);
    expect(out.searchesUsed).toBe(0);
  });

  it('accumulates cost and records it against the daily budget', async () => {
    const recorded: number[] = [];
    const deps: RecommendationWebSearchDeps = {
      search: async () => resp({ metrics: { latencyMs: 1, resultCount: 1, estimatedCostUsd: 0.008, cached: false } }),
      getDailySpendUsd: () => 0,
      recordDailySpendUsd: (u) => recorded.push(u),
    };
    const out = await runRecommendationWebSearch({ brand: 'Acme', product: 'X' }, deps, POLICY);
    expect(out.estimatedCostUsd).toBeCloseTo(0.008);
    expect(recorded).toEqual([0.008]);
  });

  it('does not escalate once the per-recommendation query budget is spent', async () => {
    let call = 0;
    const deps: RecommendationWebSearchDeps = {
      search: async () => {
        call += 1;
        return resp({ results: [], metrics: { latencyMs: 1, resultCount: 0, estimatedCostUsd: 0.02, cached: false } });
      },
      ...noBudget,
    };
    const out = await runRecommendationWebSearch(
      { brand: 'Acme', product: 'X' },
      deps,
      { ...POLICY, queryBudgetUsd: 0.01 }, // first basic search (0.02) already blows the cap
    );
    expect(call).toBe(1);
    expect(out.escalated).toBe(false);
  });

  it('declines when the provider rate-limits the first search (429)', async () => {
    const deps: RecommendationWebSearchDeps = {
      search: async () => { throw new WebSearchError('rate_limited', 'nope', 429); },
      ...noBudget,
    };
    const out = await runRecommendationWebSearch({ brand: 'Acme', product: 'X' }, deps, POLICY);
    expect(out.response).toBeNull();
    expect(out.budgetExceeded).toBe(true);
  });

  it('reuses the cache within the TTL: an identical query makes only one provider call', async () => {
    let providerCalls = 0;
    const fixture: ProviderSearchResult = {
      answer: 'a',
      results: [{ title: 't', url: 'https://a.example.com', snippet: 'y'.repeat(60), score: 0.9 }],
    };
    class CountingProvider extends MockWebSearchProvider {
      async search(request: WebSearchRequest) {
        providerCalls += 1;
        return super.search(request);
      }
    }
    const service = new WebSearchService(new CountingProvider(fixture), new WebSearchCache(60_000), { dbCache: null });
    const deps: RecommendationWebSearchDeps = { search: (r) => service.search(r), ...noBudget };

    await runRecommendationWebSearch({ brand: 'Acme', product: 'X' }, deps, POLICY);
    await runRecommendationWebSearch({ brand: 'Acme', product: 'X' }, deps, POLICY);
    expect(providerCalls).toBe(1); // second run served from cache
  });
});

describe('buildRecommendationQuery (B0-92)', () => {
  it('includes brand + product and omits an empty brand', () => {
    expect(buildRecommendationQuery({ brand: 'Acme', product: 'BNC-15' })).toContain('Acme');
    expect(buildRecommendationQuery({ brand: '', product: 'BNC-15' }).startsWith('BNC-15')).toBe(true);
  });
});
