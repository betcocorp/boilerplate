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

/**
 * B0-656 — which router implementation the orchestrator should use.
 *
 * `'keyword'` is the existing `routeUserMessageToSme` / LLM-classifier path and the safe fallback
 * for every failure mode: missing row, DB error, or a stored string outside the allowed set.
 * `settings.allowed_values` is advisory metadata the admin API validates against — it is NOT a
 * database constraint (only `value_type` has a CHECK) — so the stored value is re-validated here
 * rather than trusted, and this getter can never throw or return an unrecognized route.
 *
 * `'semantic'` HAS NO EFFECT yet: the embedding-similarity router (B0-648) and the wiring of this
 * setting into the live routing decision (B0-649) are separate tickets. Nothing calls this getter
 * from the request path as of B0-656, so selecting `'semantic'` early is inert — it cannot misroute
 * a turn, it only changes what this function reports.
 */
export const ROUTER_TYPES = ['keyword', 'semantic'] as const;

export type RouterType = (typeof ROUTER_TYPES)[number];

export const DEFAULT_ROUTER_TYPE: RouterType = 'keyword';

export async function getRouterType(): Promise<RouterType> {
  const value = await getStringSetting('ROUTER_TYPE', DEFAULT_ROUTER_TYPE);
  const normalized = value.trim().toLowerCase();
  return (ROUTER_TYPES as readonly string[]).includes(normalized)
    ? (normalized as RouterType)
    : DEFAULT_ROUTER_TYPE;
}

/** Test seam: clears the per-key value cache so a test can change the mocked DB response. */
export function resetSettingsCacheForTest(): void {
  cache.clear();
}
