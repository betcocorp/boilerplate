import type { ModelProvider } from '~/lib/constants/models';
import {
  DEFAULT_HIGH_CONFIDENCE_ABSOLUTE,
  DEFAULT_MIN_LOCK_MARGIN,
  DEFAULT_MIN_LOCK_SIMILARITY,
} from '~/lib/retrieval/product-line-resolution';
import {
  DEFAULT_RAG_BOOST_WEIGHTS,
  DEFAULT_RAG_CHUNK_STRATEGY,
  RAG_BOOST_WEIGHT_BOUNDS,
  RAG_CHUNK_STRATEGIES,
  RAG_CHUNK_TOKEN_BOUNDS,
  type RagBoostConfig,
  type RagChunkingConfig,
  type RagChunkStrategy,
} from '~/lib/settings/rag-corpus-config';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export {
  DEFAULT_RAG_BOOST_WEIGHTS,
  DEFAULT_RAG_CHUNK_STRATEGY,
  RAG_BOOST_WEIGHT_BOUNDS,
  RAG_CHUNK_STRATEGIES,
  RAG_CHUNK_TOKEN_BOUNDS,
};
export type { RagBoostConfig, RagChunkingConfig, RagChunkStrategy };

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

/**
 * B0-992 — a row's effective value is `value` when set, else its `default_value` (the reader's
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

/**
 * B0-897 — which LLM vendor Bex should prefer, as selected on /admin/settings (`BEX_LLM_PROVIDER`).
 *
 * `'openai'` is today's behavior everywhere and the safe fallback for every failure mode: missing
 * row, DB error, or a stored string outside the allowed set. As with `getRouterType`,
 * `settings.allowed_values` is advisory metadata the admin API validates against — it is NOT a
 * database constraint — so the stored value is re-validated here rather than trusted, and this
 * getter can never throw or return an unrecognized provider.
 *
 * WIRED since B0-899: `resolveModel` (`~/lib/llm/resolve-model`) reads this to decide which default
 * row the `preview` tag resolves to — `BEX_RESPONSES_MODEL` (OpenAI tags) or `BEX_ANTHROPIC_MODEL`
 * (Anthropic tags). That is its ONLY consumer and its only effect: an explicit tag (`gpt-4.1`,
 * `claude-sonnet-5`, …) bypasses it entirely, because the vendor is implied by the tag
 * (`modelProviderFor`), never by this flag. The type is `ModelProvider` from
 * `~/lib/constants/models` so the consumer shares the one provider type with `modelProviderFor`
 * instead of growing a second one.
 */
export const LLM_PROVIDERS = ['openai', 'anthropic'] as const satisfies readonly ModelProvider[];

export const DEFAULT_LLM_PROVIDER: ModelProvider = 'openai';

export async function getLlmProvider(): Promise<ModelProvider> {
  const value = await getStringSetting('BEX_LLM_PROVIDER', DEFAULT_LLM_PROVIDER);
  const normalized = value.trim().toLowerCase();
  return (LLM_PROVIDERS as readonly string[]).includes(normalized)
    ? (normalized as ModelProvider)
    : DEFAULT_LLM_PROVIDER;
}

/**
 * B0-686 — how `rag.document_chunk` rows are cut when a document is (re)chunked.
 *
 * `'naive'` is the split-on-blank-lines behaviour the corpus was built with and the safe fallback
 * for every failure mode: missing row, DB error, or a stored string outside the allowed set.
 * As with `getRouterType`, `settings.allowed_values` is advisory metadata the admin API validates
 * against — it is NOT a database constraint — so the stored value is re-validated here rather than
 * trusted, and this getter can never throw or return an unrecognized strategy.
 *
 * `'heading-aware'` packs sections to the token budget below; selecting it changes nothing already
 * in the corpus until documents are re-chunked.
 *
 * The tuple, bounds and defaults live in `~/lib/settings/rag-corpus-config` so the admin cards can
 * import them client-side; they are re-exported here for callers already reaching for this module.
 */
export async function getRagChunkStrategy(): Promise<RagChunkStrategy> {
  const value = await getStringSetting('RAG_CHUNK_STRATEGY', DEFAULT_RAG_CHUNK_STRATEGY);
  const normalized = value.trim().toLowerCase();
  return (RAG_CHUNK_STRATEGIES as readonly string[]).includes(normalized)
    ? (normalized as RagChunkStrategy)
    : DEFAULT_RAG_CHUNK_STRATEGY;
}

function clampInt(value: number, { min, max }: { min: number; max: number }, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * B0-686 — the chunking strategy plus its token budget, as one read.
 *
 * Every field is clamped to the bounds the admin form enforces, and `maxTokens` is additionally
 * floored at `minTokens`, so a hand-edited `settings` row can never hand a caller an impossible
 * `min > max` budget. The defaults reproduce today's corpus exactly.
 */
export async function getRagChunkingConfig(): Promise<RagChunkingConfig> {
  const [strategy, rawMin, rawMax, rawOverlap] = await Promise.all([
    getRagChunkStrategy(),
    getNumberSetting('RAG_CHUNK_MIN_TOKENS', RAG_CHUNK_TOKEN_BOUNDS.minTokens.default),
    getNumberSetting('RAG_CHUNK_MAX_TOKENS', RAG_CHUNK_TOKEN_BOUNDS.maxTokens.default),
    getNumberSetting('RAG_CHUNK_OVERLAP_TOKENS', RAG_CHUNK_TOKEN_BOUNDS.overlapTokens.default),
  ]);

  const minTokens = clampInt(
    rawMin,
    RAG_CHUNK_TOKEN_BOUNDS.minTokens,
    RAG_CHUNK_TOKEN_BOUNDS.minTokens.default,
  );
  const maxTokens = Math.max(
    minTokens,
    clampInt(rawMax, RAG_CHUNK_TOKEN_BOUNDS.maxTokens, RAG_CHUNK_TOKEN_BOUNDS.maxTokens.default),
  );
  const overlapTokens = clampInt(
    rawOverlap,
    RAG_CHUNK_TOKEN_BOUNDS.overlapTokens,
    RAG_CHUNK_TOKEN_BOUNDS.overlapTokens.default,
  );

  return { strategy, minTokens, maxTokens, overlapTokens };
}

function clampWeight(value: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(RAG_BOOST_WEIGHT_BOUNDS.max, Math.max(RAG_BOOST_WEIGHT_BOUNDS.min, value));
}

/**
 * B0-686 — metadata boost weights added to cosine similarity for `ORDER BY` only.
 *
 * `RAG_BOOST_ENABLED` defaults to false, and when it is false every weight is reported as `0` so a
 * caller never needs a second branch: multiplying by the returned weights is a no-op. The stored
 * weights are preserved in `settings` across a disable/enable cycle — only what this getter reports
 * changes.
 */
export async function getRagBoostConfig(): Promise<RagBoostConfig> {
  const enabled = await getBooleanSetting('RAG_BOOST_ENABLED', false);
  if (!enabled) {
    return { enabled: false, surfaceType: 0, dwellTime: 0, dilutionRatio: 0 };
  }

  const [surfaceType, dwellTime, dilutionRatio] = await Promise.all([
    getNumberSetting('RAG_BOOST_SURFACE_TYPE', DEFAULT_RAG_BOOST_WEIGHTS.surfaceType),
    getNumberSetting('RAG_BOOST_DWELL_TIME', DEFAULT_RAG_BOOST_WEIGHTS.dwellTime),
    getNumberSetting('RAG_BOOST_DILUTION_RATIO', DEFAULT_RAG_BOOST_WEIGHTS.dilutionRatio),
  ]);

  return {
    enabled: true,
    surfaceType: clampWeight(surfaceType, DEFAULT_RAG_BOOST_WEIGHTS.surfaceType),
    dwellTime: clampWeight(dwellTime, DEFAULT_RAG_BOOST_WEIGHTS.dwellTime),
    dilutionRatio: clampWeight(dilutionRatio, DEFAULT_RAG_BOOST_WEIGHTS.dilutionRatio),
  };
}

/**
 * B0-686 — the stored weights regardless of `RAG_BOOST_ENABLED`, for the admin form to seed its
 * inputs from. Read paths should use `getRagBoostConfig()` instead, which zeroes a disabled rule.
 */
export async function getRagBoostWeights(): Promise<Omit<RagBoostConfig, 'enabled'>> {
  const [surfaceType, dwellTime, dilutionRatio] = await Promise.all([
    getNumberSetting('RAG_BOOST_SURFACE_TYPE', DEFAULT_RAG_BOOST_WEIGHTS.surfaceType),
    getNumberSetting('RAG_BOOST_DWELL_TIME', DEFAULT_RAG_BOOST_WEIGHTS.dwellTime),
    getNumberSetting('RAG_BOOST_DILUTION_RATIO', DEFAULT_RAG_BOOST_WEIGHTS.dilutionRatio),
  ]);

  return {
    surfaceType: clampWeight(surfaceType, DEFAULT_RAG_BOOST_WEIGHTS.surfaceType),
    dwellTime: clampWeight(dwellTime, DEFAULT_RAG_BOOST_WEIGHTS.dwellTime),
    dilutionRatio: clampWeight(dilutionRatio, DEFAULT_RAG_BOOST_WEIGHTS.dilutionRatio),
  };
}

/**
 * B0-757 — the three `resolveProductLineFromMatches` (~/lib/retrieval/product-line-resolution.ts)
 * lock thresholds, moved off `process.env.BEX_PRODUCT_LINE_LOCK_*` (never actually set in any
 * environment). Defaults mirror that module's own fallback consts exactly, so a missing/unreadable
 * row reproduces today's behavior. The function itself stays synchronous and untouched — this is
 * read once by the one production call site (`~/lib/retrieval/product-knowledge.ts`) and passed in
 * as an options override; its unit tests keep exercising the hardcoded defaults directly.
 */
export async function getProductLineLockThresholds(): Promise<{
  minLockSimilarity: number;
  minLockMargin: number;
  highConfidenceAbsolute: number;
}> {
  const [minLockSimilarity, minLockMargin, highConfidenceAbsolute] = await Promise.all([
    getNumberSetting('BEX_PRODUCT_LINE_LOCK_MIN_SIMILARITY', DEFAULT_MIN_LOCK_SIMILARITY),
    getNumberSetting('BEX_PRODUCT_LINE_LOCK_MARGIN', DEFAULT_MIN_LOCK_MARGIN),
    getNumberSetting('BEX_PRODUCT_LINE_LOCK_HIGH_CONFIDENCE', DEFAULT_HIGH_CONFIDENCE_ABSOLUTE),
  ]);

  return { minLockSimilarity, minLockMargin, highConfidenceAbsolute };
}

/** Test seam: clears the per-key value cache so a test can change the mocked DB response. */
export function resetSettingsCacheForTest(): void {
  cache.clear();
}
