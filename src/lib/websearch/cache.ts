import type {
  WebSearchRequest,
  WebSearchResponse,
} from '~/lib/websearch/websearch-schemas';

/** Stable cache key over the inputs that change results (provider + normalized request). */
export function webSearchCacheKey(
  provider: string,
  request: WebSearchRequest,
): string {
  return JSON.stringify({
    provider,
    query: request.query.trim().toLowerCase(),
    depth: request.depth ?? 'basic',
    maxResults: request.maxResults ?? 5,
    domains: [...(request.domains ?? [])].map((d) => d.toLowerCase()).sort(),
  });
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
  return Number.isFinite(raw) && raw > 0 ? raw : 600_000;
}
