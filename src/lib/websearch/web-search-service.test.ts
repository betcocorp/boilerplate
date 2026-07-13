import { afterEach, describe, expect, it } from 'vitest';

import { WebSearchCache } from '~/lib/websearch/cache';
import { MockWebSearchProvider } from '~/lib/websearch/mock-provider';
import { TavilyProvider } from '~/lib/websearch/tavily-provider';
import type { ProviderSearchResult, WebSearchProvider } from '~/lib/websearch/types';
import { WebSearchError } from '~/lib/websearch/types';
import {
  WebSearchService,
  createProviderFromEnv,
} from '~/lib/websearch/web-search-service';
import {
  webSearchRequestSchema,
  type WebSearchResult,
} from '~/lib/websearch/websearch-schemas';

const freshCache = () => new WebSearchCache(60_000);

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

describe('createProviderFromEnv', () => {
  const prevProvider = process.env.WEBSEARCH_PROVIDER;
  const prevKey = process.env.TAVILY_API_KEY;

  afterEach(() => {
    if (prevProvider === undefined) delete process.env.WEBSEARCH_PROVIDER;
    else process.env.WEBSEARCH_PROVIDER = prevProvider;
    if (prevKey === undefined) delete process.env.TAVILY_API_KEY;
    else process.env.TAVILY_API_KEY = prevKey;
  });

  it('selects the mock provider', () => {
    process.env.WEBSEARCH_PROVIDER = 'mock';
    expect(createProviderFromEnv()).toBeInstanceOf(MockWebSearchProvider);
  });

  it('selects the Tavily provider when a key is present', () => {
    process.env.WEBSEARCH_PROVIDER = 'tavily';
    process.env.TAVILY_API_KEY = 'test-key';
    expect(createProviderFromEnv()).toBeInstanceOf(TavilyProvider);
  });

  it('throws a structured error for an unknown provider', () => {
    process.env.WEBSEARCH_PROVIDER = 'nope';
    expect(() => createProviderFromEnv()).toThrow(WebSearchError);
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
