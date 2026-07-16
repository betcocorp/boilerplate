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

export type WebSearchCacheEntry = {
  cacheKey: string;
  query: string;
  provider: string;
  hitCount: number;
  resultCount: number | null;
  createdAt: string;
  expiresAt: string;
  expired: boolean;
};

type CacheListRow = {
  cache_key: string;
  query: string;
  provider: string;
  hit_count: number | null;
  response: unknown;
  created_at: string;
  expires_at: string;
};

/** Newest cached web-search entries, for the admin cache table (B0-109). Best-effort. */
export async function listWebSearchCacheEntries(limit = 100): Promise<WebSearchCacheEntry[]> {
  try {
    const supabase = getSupabaseServiceRoleClient() as unknown as {
      from: (table: string) => {
        select: (cols: string) => {
          order: (
            col: string,
            opts: { ascending: boolean },
          ) => {
            limit: (
              count: number,
            ) => Promise<{ data: CacheListRow[] | null; error: unknown }>;
          };
        };
      };
    };
    const { data, error } = await supabase
      .from('web_search_cache')
      .select('cache_key, query, provider, hit_count, response, created_at, expires_at')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (error || !data) {
      return [];
    }
    const now = Date.now();
    return data.map((row) => {
      const parsed = webSearchResponseSchema.safeParse(row.response);
      return {
        cacheKey: row.cache_key,
        query: row.query,
        provider: row.provider,
        hitCount: typeof row.hit_count === 'number' ? row.hit_count : 0,
        resultCount: parsed.success ? parsed.data.results.length : null,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        expired: new Date(row.expires_at).getTime() <= now,
      };
    });
  } catch {
    return [];
  }
}
