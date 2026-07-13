import {
  WebSearchCache,
  defaultCacheTtlMs,
  webSearchCacheKey,
} from '~/lib/websearch/cache';
import { MockWebSearchProvider } from '~/lib/websearch/mock-provider';
import { TavilyProvider } from '~/lib/websearch/tavily-provider';
import type { WebSearchProvider } from '~/lib/websearch/types';
import { WebSearchError } from '~/lib/websearch/types';
import {
  webSearchResultSchema,
  type WebSearchRequest,
  type WebSearchResponse,
} from '~/lib/websearch/websearch-schemas';

/** Rough per-search cost estimate (USD) for observability; not billing-accurate. */
function estimateCost(providerName: string, request: WebSearchRequest): number {
  if (providerName !== 'tavily') {
    return 0;
  }
  return request.depth === 'advanced' ? 0.016 : 0.008;
}

/** Select the active provider from env; consumers never change when the provider swaps. */
export function createProviderFromEnv(): WebSearchProvider {
  const name = (process.env.WEBSEARCH_PROVIDER ?? 'tavily').trim().toLowerCase();
  switch (name) {
    case 'tavily':
      return new TavilyProvider();
    case 'mock':
      return new MockWebSearchProvider();
    default:
      throw new WebSearchError(
        'unknown_provider',
        `Unknown WEBSEARCH_PROVIDER: ${name}`,
        500,
      );
  }
}

/**
 * Generic web-search core: run a provider search, validate + normalize to the Bex-owned
 * shape, and attach timing/cost metrics. Intent-specific tools consume this, not the provider.
 */
/** Process-wide cache shared across requests; TTL from WEBSEARCH_CACHE_TTL_MS (default 10 min). */
const sharedCache = new WebSearchCache(defaultCacheTtlMs());

export class WebSearchService {
  private readonly provider: WebSearchProvider;
  private readonly cache: WebSearchCache;

  constructor(provider?: WebSearchProvider, cache?: WebSearchCache) {
    this.provider = provider ?? createProviderFromEnv();
    this.cache = cache ?? sharedCache;
  }

  get providerName(): string {
    return this.provider.name;
  }

  async search(request: WebSearchRequest): Promise<WebSearchResponse> {
    const startedAt = Date.now();
    const cacheKey = webSearchCacheKey(this.provider.name, request);

    const hit = this.cache.get(cacheKey);
    if (hit) {
      return {
        ...hit,
        metrics: {
          ...hit.metrics,
          cached: true,
          estimatedCostUsd: 0,
          latencyMs: Date.now() - startedAt,
        },
      };
    }

    const raw = await this.provider.search(request);

    const parsed = webSearchResultSchema.array().safeParse(raw.results);
    if (!parsed.success) {
      throw new WebSearchError(
        'invalid_provider_response',
        'Provider returned results that failed schema validation.',
      );
    }

    const results = parsed.data.slice(0, request.maxResults ?? 5);
    const response: WebSearchResponse = {
      query: request.query,
      provider: this.provider.name,
      answer: raw.answer ?? null,
      results,
      metrics: {
        latencyMs: Date.now() - startedAt,
        resultCount: results.length,
        estimatedCostUsd: estimateCost(this.provider.name, request),
        cached: false,
      },
    };
    this.cache.set(cacheKey, response);
    return response;
  }
}
