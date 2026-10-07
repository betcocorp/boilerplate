import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * The `settings` table backs runtime feature toggles (read at call time, so a change takes effect
 * without a deploy). Cached briefly per key so a hot request path doesn't round-trip Postgres per call; a DB error or missing row falls back to
 * the caller's `fallback` rather than throwing, since a settings outage should never break
 * the feature it's toggling.
 */
const CACHE_TTL_MS = 30_000;

type CacheEntry = { value: string | null; expiresAt: number };

const cache = new Map<string, CacheEntry>();

/**
 * A row's effective value is `value` when set, else its `default_value` (the reader's
 * own code fallback, mirrored into the table so /admin/settings can show it and "Reset to
 * default" can restore it). Null only when the row is missing, unreadable, or has neither — in
 * which case the caller's `fallback` still applies, exactly as before.
 */
export function resolveSettingValue(row: {
  value: string | null;
  default_value?: string | null;
} | null | undefined): string | null {
  if (!row) return null;
  return row.value ?? row.default_value ?? null;
}

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
      .select('value, default_value')
      .eq('key', key)
      .maybeSingle();

    if (error) throw error;
    value = resolveSettingValue(data);
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
