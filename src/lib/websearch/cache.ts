import type {
  WebSearchRequest,
  WebSearchResponse,
} from '~/lib/websearch/websearch-schemas';

/**
 * Normalize a query for cache-key purposes only (B0-326).
 *
 * The provider still receives the caller's verbatim query — this decides solely which requests count
 * as *the same* request. Previously the key used `trim().toLowerCase()`, so pure punctuation /
 * separator variance for an identical lookup ("Klenz-9000" vs "Klenz 9000", "OR" vs "or", a stray
 * double space) minted a separate cache row and re-billed the provider.
 */
export function normalizeSearchQuery(query: string): string {
  return query
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Stable cache key over the inputs that change results (provider + normalized request). */
export function webSearchCacheKey(
  provider: string,
  request: WebSearchRequest,
): string {
  return JSON.stringify({
    provider,
    query: normalizeSearchQuery(request.query),
    depth: request.depth ?? 'basic',
    maxResults: request.maxResults ?? 5,
    domains: [...(request.domains ?? [])].map((d) => d.toLowerCase()).sort(),
  });
}

/**
 * Cache keys to probe for a read, in priority order (B0-326).
 *
 * `depth` is part of the key, so a `basic` and an `advanced` pass over the same query could never
 * share an entry — an escalating recommendation always wrote two rows and a later `basic` request
 * re-billed the provider even though a stored `advanced` response was sitting right there. Since
 * `advanced` is a strictly more thorough crawl of the same query, a stored `advanced` response can
 * satisfy a `basic` request. Never the reverse: serving `basic` for an `advanced` request would
 * quietly downgrade evidence quality.
 *
 * Writes always use the first (exact) key, so a `basic` response never lands under an
 * `advanced` key.
 */
export function webSearchCacheReadKeys(
  provider: string,
  request: WebSearchRequest,
): string[] {
  const exact = webSearchCacheKey(provider, request);
  if ((request.depth ?? 'basic') !== 'basic') {
    return [exact];
  }
  return [exact, webSearchCacheKey(provider, { ...request, depth: 'advanced' })];
}

/** Small in-memory TTL cache for external search responses (freshness via ttlMs). */
export class WebSearchCache {
  private readonly store = new Map<string, { at: number; value: WebSearchResponse }>();

  constructor(private readonly ttlMs: number) {}

  get(key: string): WebSearchResponse | null {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.at > this.ttlMs) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: WebSearchResponse): void {
    this.store.set(key, { at: Date.now(), value });
  }

  /** Inspectable: number of live entries (stale ones are pruned lazily on get). */
  get size(): number {
    return this.store.size;
  }

  clear(): void {
    this.store.clear();
  }
}

export function defaultCacheTtlMs(): number {
  const raw = Number(process.env.WEBSEARCH_CACHE_TTL_MS);
  // Default 30 days; override with WEBSEARCH_CACHE_TTL_MS (ms).
  return Number.isFinite(raw) && raw > 0 ? raw : 2_592_000_000;
}
