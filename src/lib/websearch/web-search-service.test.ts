import { afterEach, describe, expect, it, vi } from 'vitest';

import { getStringSetting } from '~/lib/settings/settings-service';
import { WebSearchCache, webSearchCacheKey } from '~/lib/websearch/cache';
import type { WebSearchDurableCache } from '~/lib/websearch/db-cache';
import { MockWebSearchProvider } from '~/lib/websearch/mock-provider';
import { TavilyProvider } from '~/lib/websearch/tavily-provider';
import type { ProviderSearchResult, WebSearchProvider } from '~/lib/websearch/types';
import { WebSearchError } from '~/lib/websearch/types';
import {
  WebSearchService,
  createProviderFromSettings,
} from '~/lib/websearch/web-search-service';
import {
  webSearchRequestSchema,
  type WebSearchResponse,
  type WebSearchResult,
} from '~/lib/websearch/websearch-schemas';

vi.mock('~/lib/settings/settings-service', () => ({
  getStringSetting: vi.fn((_key: string, fallback: string) => Promise.resolve(fallback)),
  getBooleanSetting: vi.fn((_key: string, fallback: boolean) => Promise.resolve(fallback)),
}));

const freshCache = () => new WebSearchCache(60_000);

/** In-memory stand-in for the durable DB cache, so layering is testable without a database. */
function stubDbCache() {
  const store = new Map<string, WebSearchResponse>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: WebSearchResponse) => {
      store.set(key, value);
    }),
  } satisfies WebSearchDurableCache & { store: Map<string, WebSearchResponse> };
}

describe('WebSearchService', () => {
  it('normalizes provider results into the Bex-owned shape with metrics (happy path)', async () => {
    const service = new WebSearchService(new MockWebSearchProvider(), freshCache());
    const result = await service.search({ query: 'BNC-15' });

    expect(service.providerName).toBe('mock');
    expect(result.provider).toBe('mock');
    expect(result.answer).toContain('BNC-15');
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]).toEqual(
      expect.objectContaining({
        title: expect.any(String),
        url: expect.any(String),
        snippet: expect.any(String),
        score: expect.any(Number),
      }),
    );
    expect(result.metrics.resultCount).toBe(result.results.length);
    expect(result.metrics.estimatedCostUsd).toBe(0);
    expect(result.metrics.cached).toBe(false);
  });

  it('respects maxResults', async () => {
    const service = new WebSearchService(new MockWebSearchProvider(), freshCache());
    const result = await service.search({ query: 'anything', maxResults: 1 });
    expect(result.results).toHaveLength(1);
  });

  it('serves a repeated identical query from cache (WEB-4)', async () => {
    let calls = 0;
    const counting: WebSearchProvider = {
      name: 'mock',
      search: async (): Promise<ProviderSearchResult> => {
        calls += 1;
        return {
          answer: 'cached-answer',
          results: [{ title: 't', url: 'https://example.com/a', snippet: 's', score: 1 }],
        };
      },
      extract: async () => [],
    };
    const service = new WebSearchService(counting, freshCache());

    const first = await service.search({ query: 'triforce' });
    const second = await service.search({ query: 'triforce' });

    expect(calls).toBe(1);
    expect(first.metrics.cached).toBe(false);
    expect(second.metrics.cached).toBe(true);
    expect(second.metrics.estimatedCostUsd).toBe(0);
    expect(second.results).toEqual(first.results);
  });

  it('expires cache entries past the TTL', () => {
    const cache = new WebSearchCache(-1);
    cache.set('k', {
      query: 'x',
      provider: 'mock',
      answer: null,
      results: [],
      metrics: { latencyMs: 1, resultCount: 0, estimatedCostUsd: 0, cached: false },
    });
    expect(cache.get('k')).toBeNull();
  });

  it('throws a structured WebSearchError on a malformed provider response', async () => {
    const malformed: WebSearchProvider = {
      name: 'mock',
      search: async () => ({
        answer: null,
        results: [{ nope: true }] as unknown as WebSearchResult[],
      }),
      extract: async () => [],
    };
    const service = new WebSearchService(malformed, freshCache());

    await expect(service.search({ query: 'x' })).rejects.toBeInstanceOf(WebSearchError);
    await expect(service.search({ query: 'x' })).rejects.toMatchObject({
      code: 'invalid_provider_response',
    });
  });
});

describe('createProviderFromSettings', () => {
  const prevKey = process.env.TAVILY_API_KEY;

  afterEach(() => {
    if (prevKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = prevKey;
    vi.mocked(getStringSetting).mockReset().mockImplementation((_key, fallback) => Promise.resolve(fallback));
  });

  it('selects the mock provider', async () => {
    vi.mocked(getStringSetting).mockResolvedValueOnce('mock');
    expect(await createProviderFromSettings()).toBeInstanceOf(MockWebSearchProvider);
  });

  it('selects the Tavily provider when a key is present', async () => {
    vi.mocked(getStringSetting).mockResolvedValueOnce('tavily');
    process.env.TAVILY_API_KEY = 'test-key';
    expect(await createProviderFromSettings()).toBeInstanceOf(TavilyProvider);
  });

  it('throws a structured error for an unknown provider', async () => {
    vi.mocked(getStringSetting).mockResolvedValueOnce('nope');
    await expect(createProviderFromSettings()).rejects.toThrow(WebSearchError);
  });
});

describe('webSearchRequestSchema', () => {
  it('rejects an empty query and an invalid depth, accepts a valid request', () => {
    expect(webSearchRequestSchema.safeParse({ query: '' }).success).toBe(false);
    expect(webSearchRequestSchema.safeParse({ query: 'ok', depth: 'nope' }).success).toBe(
      false,
    );
    expect(
      webSearchRequestSchema.safeParse({ query: 'ok', depth: 'advanced' }).success,
    ).toBe(true);
  });
});

describe('WebSearchService durable (DB) cache layer', () => {
  it('serves a memory-miss from the DB cache without calling the provider', async () => {
    let calls = 0;
    const provider: WebSearchProvider = {
      name: 'mock',
      search: async (): Promise<ProviderSearchResult> => {
        calls += 1;
        return { answer: 'from-provider', results: [] };
      },
      extract: async () => [],
    };
    const db = stubDbCache();
    const request = { query: 'triforce' };
    db.store.set(webSearchCacheKey('mock', request), {
      query: 'triforce',
      provider: 'mock',
      answer: 'from-db',
      results: [],
      metrics: { latencyMs: 5, resultCount: 0, estimatedCostUsd: 0.016, cached: false },
    });

    const service = new WebSearchService(provider, freshCache(), { dbCache: db });
    const result = await service.search(request);

    expect(result.answer).toBe('from-db');
    expect(result.metrics.cached).toBe(true);
    expect(result.metrics.estimatedCostUsd).toBe(0);
    expect(calls).toBe(0); // provider not billed
    expect(db.get).toHaveBeenCalledOnce();
  });

  it('serves a basic request from a stored advanced response without re-billing (B0-326)', async () => {
    let calls = 0;
    const provider: WebSearchProvider = {
      name: 'mock',
      search: async (): Promise<ProviderSearchResult> => {
        calls += 1;
        return { answer: 'from-provider', results: [] };
      },
      extract: async () => [],
    };
    const db = stubDbCache();
    // Only the advanced entry exists (the escalating pass wrote it).
    db.store.set(webSearchCacheKey('mock', { query: 'zorbex klenz 9000', depth: 'advanced' }), {
      query: 'zorbex klenz 9000',
      provider: 'mock',
      answer: 'from-advanced',
      results: [],
      metrics: { latencyMs: 5, resultCount: 0, estimatedCostUsd: 0.016, cached: false },
    });

    const service = new WebSearchService(provider, freshCache(), { dbCache: db });
    const result = await service.search({ query: 'Zorbex Klenz-9000', depth: 'basic' });

    expect(result.answer).toBe('from-advanced');
    expect(result.metrics.cached).toBe(true);
    expect(calls).toBe(0); // provider not billed for the basic pass
  });

  it('does NOT serve an advanced request from a stored basic response (B0-326)', async () => {
    let calls = 0;
    const provider: WebSearchProvider = {
      name: 'mock',
      search: async (): Promise<ProviderSearchResult> => {
        calls += 1;
        return { answer: 'from-provider', results: [] };
      },
      extract: async () => [],
    };
    const db = stubDbCache();
    db.store.set(webSearchCacheKey('mock', { query: 'q', depth: 'basic' }), {
      query: 'q',
      provider: 'mock',
      answer: 'from-basic',
      results: [],
      metrics: { latencyMs: 5, resultCount: 0, estimatedCostUsd: 0.008, cached: false },
    });

    const service = new WebSearchService(provider, freshCache(), { dbCache: db });
    const result = await service.search({ query: 'q', depth: 'advanced' });

    expect(result.answer).toBe('from-provider');
    expect(calls).toBe(1); // deeper evidence must not be downgraded to a cached basic pass
  });

  it('write-through uses the exact depth key, never the fallback (B0-326)', async () => {
    const provider: WebSearchProvider = {
      name: 'mock',
      search: async (): Promise<ProviderSearchResult> => ({ answer: 'fresh', results: [] }),
      extract: async () => [],
    };
    const db = stubDbCache();
    const service = new WebSearchService(provider, freshCache(), { dbCache: db });

    await service.search({ query: 'q', depth: 'basic' });

    expect([...db.store.keys()]).toEqual([
      webSearchCacheKey('mock', { query: 'q', depth: 'basic' }),
    ]);
  });

  it('write-through: a provider miss populates the DB cache', async () => {
    const provider: WebSearchProvider = {
      name: 'mock',
      search: async (): Promise<ProviderSearchResult> => ({
        answer: 'fresh',
        results: [{ title: 't', url: 'https://example.com/a', snippet: 's', score: 1 }],
      }),
      extract: async () => [],
    };
    const db = stubDbCache();
    const service = new WebSearchService(provider, freshCache(), { dbCache: db });

    const result = await service.search({ query: 'zep degreaser' });

    expect(result.metrics.cached).toBe(false);
    expect(db.set).toHaveBeenCalledOnce();
    expect(db.store.size).toBe(1);
  });
});
