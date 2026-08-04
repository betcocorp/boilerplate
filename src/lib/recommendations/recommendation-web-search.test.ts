import { describe, expect, it, vi } from 'vitest';

import {
  buildRecommendationQuery,
  isSearchInconclusive,
  loadRecommendationSearchPolicy,
  runRecommendationWebSearch,
  PARALLEL_PROJECTED_COST_USD,
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
  minTopScore: 0.3,
  minUsableResults: 3,
  parallelEscalation: false,
};

/** N results each carrying usable content, at a given top score. */
const resultsWith = (count: number, topScore: number) =>
  Array.from({ length: count }, (_, i) => ({
    title: `t${i}`,
    url: `https://a${i}.example.com`,
    snippet: 'x'.repeat(200),
    score: i === 0 ? topScore : topScore / 2,
  }));

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

  it('is inconclusive when no result carries usable content, whatever the score', () => {
    expect(
      isSearchInconclusive(
        resp({ results: [{ title: 't', url: 'https://a', snippet: 'tiny', score: 0.99 }] }),
      ),
    ).toBe(true);
  });

  // B0-325: the live cache showed escalations firing on passes with 5/5 richly-populated results
  // purely because the appended query boilerplate depressed the provider's relevance score.
  it('does NOT escalate on a weak top score when the evidence set is rich', () => {
    expect(isSearchInconclusive(resp({ results: resultsWith(5, 0.044) }))).toBe(false);
  });

  it('still escalates on a weak top score when the evidence set is thin', () => {
    expect(isSearchInconclusive(resp({ results: resultsWith(2, 0.044) }))).toBe(true);
  });

  it('honours tuned thresholds', () => {
    const thin = resp({ results: resultsWith(2, 0.044) });
    // Accepting 2 usable results makes the same pass conclusive.
    expect(isSearchInconclusive(thin, { minUsableResults: 2 })).toBe(false);
    // Raising the score floor makes a rich pass inconclusive again.
    expect(
      isSearchInconclusive(resp({ results: resultsWith(5, 0.5) }), {
        minTopScore: 0.9,
        minUsableResults: 10,
      }),
    ).toBe(true);
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

  // B0-326: the live cache held separate rows for "Spartan ..." and "Spartan Chemical ..." of the
  // same product, each costing a fresh provider call.
  it('collapses corporate-form brand variants onto one query', () => {
    expect(
      buildRecommendationQuery({ brand: 'Spartan Chemical', product: 'Xtreme Blue Triple Foam' }),
    ).toBe(buildRecommendationQuery({ brand: 'Spartan', product: 'Xtreme Blue Triple Foam' }));
  });

  it('does not repeat a brand the product name already leads with', () => {
    const query = buildRecommendationQuery({
      brand: 'Spartan',
      product: 'Spartan Xtreme Blue Triple Foam',
    });
    expect(query.match(/Spartan/g)).toHaveLength(1);
  });

  it('never reduces an all-corporate brand to nothing', () => {
    expect(buildRecommendationQuery({ brand: 'Chemical Co', product: 'Zenith' })).toContain(
      'Chemical Co',
    );
  });

  it('keeps genuinely different brands apart', () => {
    expect(buildRecommendationQuery({ brand: 'Spartan', product: 'X' })).not.toBe(
      buildRecommendationQuery({ brand: 'Zorbex', product: 'X' }),
    );
  });
});

describe('parallel escalation (B0-325)', () => {
  const parallel: RecommendationSearchPolicy = { ...POLICY, parallelEscalation: true };

  it('dispatches both tiers concurrently instead of sequentially', async () => {
    const started: string[] = [];
    let firstResolve: (() => void) | null = null;
    const deps: RecommendationWebSearchDeps = {
      search: async (r) => {
        started.push(r.depth ?? 'basic');
        if (r.depth === 'basic') {
          // Hold the basic pass open; the advanced pass must already be in flight.
          await new Promise<void>((res) => {
            firstResolve = res;
          });
        }
        return resp({ results: [] });
      },
      ...noBudget,
    };

    const running = runRecommendationWebSearch({ brand: 'Acme', product: 'X' }, deps, parallel);
    await vi.waitFor(() => expect(started).toEqual(['basic', 'advanced']));
    firstResolve?.();
    const out = await running;

    expect(out.searchesUsed).toBe(2);
    expect(out.escalated).toBe(true);
  });

  it('reports both searches as billed but does not escalate when basic is conclusive', async () => {
    const recorded: number[] = [];
    const deps: RecommendationWebSearchDeps = {
      search: async (r) =>
        resp({
          results: r.depth === 'basic' ? resultsWith(5, 0.9) : resultsWith(5, 0.95),
          metrics: { latencyMs: 1, resultCount: 5, estimatedCostUsd: r.depth === 'basic' ? 0.008 : 0.016, cached: false },
        }),
      getDailySpendUsd: () => 0,
      recordDailySpendUsd: (u) => recorded.push(u),
    };
    const out = await runRecommendationWebSearch({ brand: 'Acme', product: 'X' }, deps, parallel);

    // Truthful telemetry: both searches were dispatched and billed...
    expect(out.searchesUsed).toBe(2);
    expect(out.estimatedCostUsd).toBeCloseTo(0.024);
    expect(recorded).toEqual([0.008, 0.016]);
    // ...but the advanced evidence was discarded, so the recommendation was not escalated.
    expect(out.escalated).toBe(false);
    expect(out.response?.results).toHaveLength(5);
  });

  it('falls back to the advanced pass when the basic pass fails', async () => {
    const deps: RecommendationWebSearchDeps = {
      search: async (r) => {
        if (r.depth === 'basic') throw new WebSearchError('boom', 'nope', 500);
        return resp();
      },
      ...noBudget,
    };
    const out = await runRecommendationWebSearch({ brand: 'Acme', product: 'X' }, deps, parallel);
    expect(out.searchesUsed).toBe(1);
    expect(out.escalated).toBe(true);
    expect(out.response).not.toBeNull();
  });

  it('declines with budgetExceeded when both passes are rate-limited', async () => {
    const deps: RecommendationWebSearchDeps = {
      search: async () => {
        throw new WebSearchError('rate_limited', 'nope', 429);
      },
      ...noBudget,
    };
    const out = await runRecommendationWebSearch({ brand: 'Acme', product: 'X' }, deps, parallel);
    expect(out.response).toBeNull();
    expect(out.budgetExceeded).toBe(true);
    expect(out.searchesUsed).toBe(0);
  });

  it('stays sequential when the per-recommendation budget cannot absorb both searches', async () => {
    const depths: string[] = [];
    const deps: RecommendationWebSearchDeps = {
      search: async (r) => {
        depths.push(r.depth ?? 'basic');
        return resp({ results: resultsWith(5, 0.9) });
      },
      ...noBudget,
    };
    const out = await runRecommendationWebSearch(
      { brand: 'Acme', product: 'X' },
      deps,
      { ...parallel, queryBudgetUsd: PARALLEL_PROJECTED_COST_USD - 0.001 },
    );
    expect(depths).toEqual(['basic']); // never fired the advanced pass
    expect(out.searchesUsed).toBe(1);
  });

  it('stays sequential when only one search is allowed', async () => {
    const depths: string[] = [];
    const deps: RecommendationWebSearchDeps = {
      search: async (r) => {
        depths.push(r.depth ?? 'basic');
        return resp({ results: [] });
      },
      ...noBudget,
    };
    await runRecommendationWebSearch(
      { brand: 'Acme', product: 'X' },
      deps,
      { ...parallel, maxSearches: 1 },
    );
    expect(depths).toEqual(['basic']);
  });

  it('still short-circuits on the daily budget before spending anything', async () => {
    let searched = false;
    const deps: RecommendationWebSearchDeps = {
      search: async () => {
        searched = true;
        return resp();
      },
      getDailySpendUsd: () => 10,
      recordDailySpendUsd: () => {},
    };
    const out = await runRecommendationWebSearch({ brand: 'Acme', product: 'X' }, deps, parallel);
    expect(searched).toBe(false);
    expect(out.budgetExceeded).toBe(true);
  });
});

describe('loadRecommendationSearchPolicy (B0-325)', () => {
  it('defaults to the sequential, tuned-gate behaviour', () => {
    const policy = loadRecommendationSearchPolicy({} as NodeJS.ProcessEnv);
    expect(policy.parallelEscalation).toBe(false);
    expect(policy.minTopScore).toBe(0.3);
    expect(policy.minUsableResults).toBe(3);
  });

  it('reads the escalation knobs from the environment', () => {
    const policy = loadRecommendationSearchPolicy({
      XREF_PARALLEL_SEARCH_ESCALATION: 'true',
      XREF_SEARCH_MIN_TOP_SCORE: '0.15',
      XREF_SEARCH_MIN_USABLE_RESULTS: '5',
    } as unknown as NodeJS.ProcessEnv);
    expect(policy.parallelEscalation).toBe(true);
    expect(policy.minTopScore).toBe(0.15);
    expect(policy.minUsableResults).toBe(5);
  });

  it('accepts a 0 score floor (disables score-based escalation)', () => {
    expect(
      loadRecommendationSearchPolicy({ XREF_SEARCH_MIN_TOP_SCORE: '0' } as unknown as NodeJS.ProcessEnv)
        .minTopScore,
    ).toBe(0);
  });
});
