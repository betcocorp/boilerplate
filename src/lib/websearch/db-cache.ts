import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import {
  webSearchResponseSchema,
  type WebSearchResponse,
} from '~/lib/websearch/websearch-schemas';

/**
 * Durable web-search cache (extends WEB-4). Layered UNDER the in-memory cache so repeated identical
 * queries are served from `public.web_search_cache` instead of re-billing the provider, and survive
 * restarts / are shared across instances.
 *
 * Best-effort by design: every method swallows errors (including a missing table) and returns
 * null / no-ops, so a DB hiccup never breaks a search — it just falls through to the provider.
 */
export interface WebSearchDurableCache {
  get(key: string): Promise<WebSearchResponse | null>;
  set(key: string, value: WebSearchResponse, ttlMs: number): Promise<void>;
}

type CacheRow = { response: unknown; expires_at: string };
type LooseTable = {
  select: (cols: string) => LooseTable;
  eq: (column: string, value: unknown) => LooseTable;
  gt: (column: string, value: unknown) => LooseTable;
  limit: (count: number) => LooseTable;
  maybeSingle: () => Promise<{ data: CacheRow | null; error: unknown }>;
  upsert: (
    row: Record<string, unknown>,
    opts: { onConflict: string },
  ) => Promise<{ error: unknown }>;
};

function cacheTable(): LooseTable {
  // web_search_cache post-dates the generated public types; access it loosely.
  const supabase = getSupabaseServiceRoleClient() as unknown as {
    from: (table: string) => LooseTable;
  };
  return supabase.from('web_search_cache');
}

export class WebSearchDbCache implements WebSearchDurableCache {
  async get(key: string): Promise<WebSearchResponse | null> {
    try {
      const { data, error } = await cacheTable()
        .select('response, expires_at')
        .eq('cache_key', key)
        .gt('expires_at', new Date().toISOString())
        .limit(1)
        .maybeSingle();
      if (error || !data) {
        return null;
      }
      const parsed = webSearchResponseSchema.safeParse(data.response);
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }

  async set(key: string, value: WebSearchResponse, ttlMs: number): Promise<void> {
    try {
      const now = Date.now();
      await cacheTable().upsert(
        {
          cache_key: key,
          query: value.query,
          provider: value.provider,
          response: value,
          created_at: new Date(now).toISOString(),
          expires_at: new Date(now + Math.max(0, ttlMs)).toISOString(),
        },
        { onConflict: 'cache_key' },
      );
    } catch {
      // best-effort write-through; never let a cache write fail the request
    }
  }
}

/** Process-wide durable cache; used when WEBSEARCH_DB_CACHE_ENABLED=true. */
export const sharedDbCache = new WebSearchDbCache();
