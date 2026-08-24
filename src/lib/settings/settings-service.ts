import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-618 — the `settings` table (see /admin/settings) backs feature toggles that used to be
 * read straight off `process.env`. Cached briefly per key so a hot request path (e.g. every
 * RAG search) doesn't round-trip Postgres per call; a DB error or missing row falls back to
 * the caller's `fallback` rather than throwing, since a settings outage should never break
 * the feature it's toggling.
 */
const CACHE_TTL_MS = 30_000;

type CacheEntry = { value: string | null; expiresAt: number };

const cache = new Map<string, CacheEntry>();

async function fetchSettingValue(key: string): Promise<string | null> {
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  let value: string | null = null;
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();

    if (error) throw error;
    value = data?.value ?? null;
  } catch (err) {
    console.error(`Error reading setting "${key}":`, err);
    value = null;
  }

  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Resolved boolean value of a `settings` row (`value === 'true'`), or `fallback` if the row is missing/unreadable. */
export async function getBooleanSetting(key: string, fallback: boolean): Promise<boolean> {
  const value = await fetchSettingValue(key);
  return value === null ? fallback : value.toLowerCase() === 'true';
}

/** Resolved string value of a `settings` row, or `fallback` if the row is missing/unreadable. */
export async function getStringSetting(key: string, fallback: string): Promise<string> {
  const value = await fetchSettingValue(key);
  return value ?? fallback;
}

/** Resolved numeric value of a `settings` row, or `fallback` if the row is missing/unreadable/non-numeric. */
export async function getNumberSetting(key: string, fallback: number): Promise<number> {
  const value = await fetchSettingValue(key);
  if (value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** Test seam: clears the per-key value cache so a test can change the mocked DB response. */
export function resetSettingsCacheForTest(): void {
  cache.clear();
}
