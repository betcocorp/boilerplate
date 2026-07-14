import {
  WebSearchCache,
  defaultCacheTtlMs,
  webSearchCacheKey,
} from '~/lib/websearch/cache';
import {
  WebSearchGuardrails,
  loadGuardrailPolicyFromEnv,
} from '~/lib/websearch/guardrails';
import { MockWebSearchProvider } from '~/lib/websearch/mock-provider';
import {
  applySourceTrustPolicy,
  loadSourceTrustPolicyFromEnv,
  type SourceTrustPolicy,
} from '~/lib/websearch/source-trust';
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
/** Process-wide rate-limit + cost budget (WEB-5) shared across requests. */
const sharedGuardrails = new WebSearchGuardrails(loadGuardrailPolicyFromEnv());

export class WebSearchService {
  private readonly provider: WebSearchProvider;
  private readonly cache: WebSearchCache;
  private readonly guardrails: WebSearchGuardrails;
  private readonly trustPolicy: SourceTrustPolicy;

  constructor(
    provider?: WebSearchProvider,
    cache?: WebSearchCache,
    opts?: { guardrails?: WebSearchGuardrails; trustPolicy?: SourceTrustPolicy },
  ) {
    this.provider = provider ?? createProviderFromEnv();
    this.cache = cache ?? sharedCache;
    this.guardrails = opts?.guardrails ?? sharedGuardrails;
    this.trustPolicy = opts?.trustPolicy ?? loadSourceTrustPolicyFromEnv();
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

    // WEB-5: enforce rate limit + cost budget BEFORE the provider is billed (cache hits are free).
    const estimatedCostUsd = estimateCost(this.provider.name, request);
    this.guardrails.reserve(estimatedCostUsd);

    const raw = await this.provider.search(request);

    const parsed = webSearchResultSchema.array().safeParse(raw.results);
    if (!parsed.success) {
      throw new WebSearchError(
        'invalid_provider_response',
        'Provider returned results that failed schema validation.',
      );
    }

    // WEB-2: tag by source-trust tier, drop blocked domains, and rank authoritative sources first,
    // BEFORE trimming to maxResults (so exclusions don't silently shrink the trusted set).
    const ranked = applySourceTrustPolicy(parsed.data, this.trustPolicy).results;
    const results = ranked.slice(0, request.maxResults ?? 5);
    const response: WebSearchResponse = {
      query: request.query,
      provider: this.provider.name,
      answer: raw.answer ?? null,
      results,
      metrics: {
        latencyMs: Date.now() - startedAt,
        resultCount: results.length,
        estimatedCostUsd,
        cached: false,
      },
    };
    this.cache.set(cacheKey, response);
    return response;
  }
}
