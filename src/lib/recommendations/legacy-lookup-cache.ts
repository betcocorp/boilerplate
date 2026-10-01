import { normalizeLookupValue } from '~/lib/text/normalization';
import { lookupCrossReference } from '~/lib/tools/cross-reference-lookup';

/**
 * B0-322 — de-duplicate the legacy cross-reference lookup inside a single turn.
 *
 * The orchestrator routinely calls `lookup_cross_reference` and then `recommend_cross_reference`
 * back-to-back with the same brand/product (observed on all 5 items of test run
 * 577d100e-4c15-4274-a666-69031c0b661e). `recommendCrossReference`'s step 1 is the *same*
 * `lookupCrossReference()` call the tool just made, so the second one re-queries identical legacy
 * data (override table + competitor + competitor_products + two legacy product joins).
 *
 * The tool loop gives this layer no run/turn identifier (the runtime is owned elsewhere), so the
 * scope is enforced by time instead: a small in-process cache with a short TTL
 * (`XREF_LEGACY_LOOKUP_TTL_MS`, default 30s — long enough to cover the gap between two tool calls in
 * one turn, short enough that legacy/override edits show up promptly). Deliberate properties:
 *   - the key is the *normalized* brand + productName + the clamped `maxResults`, so a request for a
 *     different result count never gets a mismatched (shorter/longer) cached `matches` array;
 *   - in-flight promises are shared, so two concurrent identical lookups cost one round-trip;
 *   - a rejected lookup is evicted immediately — failures are never cached;
 *   - only the agent tool paths go through here. The admin testers
 *     (`/api/admin/tools/product-cross-reference`) and `competitor-grounding` still call
 *     `lookupCrossReference()` directly, so a reviewer editing an override sees it immediately.
 */

export type LegacyLookupInput = {
  brand: string;
  productName: string;
  maxResults?: number;
};

export type LegacyLookupResult = Awaited<ReturnType<typeof lookupCrossReference>>;

export type LegacyLookupOutcome = {
  result: LegacyLookupResult;
  /** True when this call was served from the cache instead of the database. */
  cacheHit: boolean;
};

const DEFAULT_TTL_MS = 30_000;
/** Bound on distinct cached lookups; a turn only ever needs a handful. */
const MAX_ENTRIES = 64;

/** Mirrors `clampCrossReferenceLimit` in cross-reference-lookup so the key matches the real query. */
function clampMaxResults(value: number | undefined): number {
  if (!Number.isFinite(value) || !value || value < 1) return 3;
  return Math.min(Math.floor(value), 10);
}

/** TTL in ms. `0` (or a negative value) disables caching entirely. */
export function resolveLegacyLookupTtlMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.XREF_LEGACY_LOOKUP_TTL_MS?.trim();
  if (!raw) return DEFAULT_TTL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_TTL_MS;
}

export function legacyLookupCacheKey(input: LegacyLookupInput): string {
  return [
    normalizeLookupValue(input.brand ?? ''),
    normalizeLookupValue(input.productName ?? ''),
    clampMaxResults(input.maxResults),
  ].join('|');
}

type CacheEntry = {
  expiresAt: number;
  promise: Promise<LegacyLookupResult>;
};

const cache = new Map<string, CacheEntry>();
const stats = { hits: 0, misses: 0 };

function prune(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  // Still oversized (many distinct lookups inside one TTL window): drop the oldest insertions.
  while (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export type LegacyLookupCacheDeps = {
  lookup: (input: LegacyLookupInput) => Promise<LegacyLookupResult>;
  now: () => number;
  ttlMs: () => number;
};

const defaultDeps: LegacyLookupCacheDeps = {
  lookup: (input) => lookupCrossReference(input),
  now: () => Date.now(),
  ttlMs: () => resolveLegacyLookupTtlMs(),
};

/**
 * Legacy lookup with turn-scoped de-duplication. Returns the identical payload
 * `lookupCrossReference()` returns, plus whether the cache served it.
 */
export async function lookupCrossReferenceRunScoped(
  input: LegacyLookupInput,
  deps: LegacyLookupCacheDeps = defaultDeps,
): Promise<LegacyLookupOutcome> {
  const ttlMs = deps.ttlMs();
  if (ttlMs <= 0) {
    stats.misses += 1;
    return { result: await deps.lookup(input), cacheHit: false };
  }

  const now = deps.now();
  const key = legacyLookupCacheKey(input);
  const existing = cache.get(key);

  if (existing && existing.expiresAt > now) {
    stats.hits += 1;
    return { result: await existing.promise, cacheHit: true };
  }

  prune(now);
  stats.misses += 1;
  const promise = deps.lookup(input);
  cache.set(key, { expiresAt: now + ttlMs, promise });

  try {
    return { result: await promise, cacheHit: false };
  } catch (error) {
    // Never cache a failure: the next call must be free to retry against the database.
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw error;
  }
}

/** Convenience wrapper for callers that only need the payload (e.g. the `lookup_cross_reference` tool). */
export async function lookupCrossReferenceDeduped(
  input: LegacyLookupInput,
  deps: LegacyLookupCacheDeps = defaultDeps,
): Promise<LegacyLookupResult> {
  const { result } = await lookupCrossReferenceRunScoped(input, deps);
  return result;
}

/** Observability/test helper: cumulative hit/miss counts for this process. */
export function getLegacyLookupCacheStats(): { hits: number; misses: number; size: number } {
  return { hits: stats.hits, misses: stats.misses, size: cache.size };
}

/** Test helper: drop every cached entry and reset the counters. */
export function resetLegacyLookupCache(): void {
  cache.clear();
  stats.hits = 0;
  stats.misses = 0;
}
