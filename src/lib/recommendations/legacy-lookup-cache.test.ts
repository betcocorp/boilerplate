import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getLegacyLookupCacheStats,
  legacyLookupCacheKey,
  lookupCrossReferenceDeduped,
  lookupCrossReferenceRunScoped,
  resetLegacyLookupCache,
  resolveLegacyLookupTtlMs,
  type LegacyLookupCacheDeps,
  type LegacyLookupResult,
} from '~/lib/recommendations/legacy-lookup-cache';

const legacyResult = (totalCandidates: number) =>
  ({
    ok: true,
    fallbackRecommended: false,
    normalizedInput: { brand: 'spartan', productName: 'bnc 15' },
    totalCandidates,
    matches: [],
  }) as unknown as LegacyLookupResult;

/** Deterministic clock + injectable lookup so the TTL window is exercised without real timers. */
function harness(options?: { ttlMs?: number; lookup?: LegacyLookupCacheDeps['lookup'] }) {
  let clock = 1_000_000;
  const lookup = vi.fn(options?.lookup ?? (async () => legacyResult(1)));
  const deps: LegacyLookupCacheDeps = {
    lookup,
    now: () => clock,
    ttlMs: () => options?.ttlMs ?? 30_000,
  };
  return { deps, lookup, advance: (ms: number) => (clock += ms) };
}

afterEach(() => {
  resetLegacyLookupCache();
});

describe('legacyLookupCacheKey (B0-322)', () => {
  it('normalizes brand and product so casing/punctuation variants collide', () => {
    expect(legacyLookupCacheKey({ brand: 'Spartan', productName: 'BNC-15', maxResults: 3 })).toBe(
      legacyLookupCacheKey({ brand: ' spartan ', productName: 'bnc 15', maxResults: 3 }),
    );
  });

  it('keys on the clamped maxResults so a different result count is a different entry', () => {
    const three = legacyLookupCacheKey({ brand: 'Spartan', productName: 'BNC-15', maxResults: 3 });
    // Undefined and out-of-range values clamp to the same default of 3 the lookup itself uses.
    expect(legacyLookupCacheKey({ brand: 'Spartan', productName: 'BNC-15' })).toBe(three);
    expect(legacyLookupCacheKey({ brand: 'Spartan', productName: 'BNC-15', maxResults: 0 })).toBe(three);
    expect(legacyLookupCacheKey({ brand: 'Spartan', productName: 'BNC-15', maxResults: 5 })).not.toBe(three);
  });
});

describe('lookupCrossReferenceRunScoped (B0-322)', () => {
  it('serves an identical second lookup from the cache without re-querying legacy', async () => {
    const { deps, lookup } = harness();
    const input = { brand: 'Spartan', productName: 'BNC-15', maxResults: 3 };

    const first = await lookupCrossReferenceRunScoped(input, deps);
    const second = await lookupCrossReferenceRunScoped(input, deps);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(first.cacheHit).toBe(false);
    expect(second.cacheHit).toBe(true);
    expect(second.result).toBe(first.result);
    expect(getLegacyLookupCacheStats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it('dedupes the tool path and the recommendation engine path (same brand/product, maxResults 3)', async () => {
    const { deps, lookup } = harness();
    // The `lookup_cross_reference` tool omits maxResults; recommendCrossReference passes 3.
    await lookupCrossReferenceDeduped({ brand: 'Spartan', productName: 'BNC-15' }, deps);
    const engine = await lookupCrossReferenceRunScoped(
      { brand: 'Spartan', productName: 'BNC-15', maxResults: 3 },
      deps,
    );

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(engine.cacheHit).toBe(true);
  });

  it('does not reuse an entry fetched with a different maxResults', async () => {
    const { deps, lookup } = harness();
    await lookupCrossReferenceRunScoped({ brand: 'Spartan', productName: 'BNC-15', maxResults: 3 }, deps);
    const wider = await lookupCrossReferenceRunScoped(
      { brand: 'Spartan', productName: 'BNC-15', maxResults: 10 },
      deps,
    );

    expect(lookup).toHaveBeenCalledTimes(2);
    expect(wider.cacheHit).toBe(false);
  });

  it('does not reuse an entry for a different brand or product', async () => {
    const { deps, lookup } = harness();
    await lookupCrossReferenceRunScoped({ brand: 'Spartan', productName: 'BNC-15' }, deps);
    await lookupCrossReferenceRunScoped({ brand: 'Diversey', productName: 'BNC-15' }, deps);
    await lookupCrossReferenceRunScoped({ brand: 'Spartan', productName: 'Clothesline Fresh' }, deps);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it('expires after the TTL so legacy/override edits are not served stale across turns', async () => {
    const { deps, lookup, advance } = harness({ ttlMs: 30_000 });
    const input = { brand: 'Spartan', productName: 'BNC-15' };

    await lookupCrossReferenceRunScoped(input, deps);
    advance(29_999);
    expect((await lookupCrossReferenceRunScoped(input, deps)).cacheHit).toBe(true);

    advance(2);
    expect((await lookupCrossReferenceRunScoped(input, deps)).cacheHit).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight round-trip between concurrent identical lookups', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, lookup } = harness({
      lookup: async () => {
        await gate;
        return legacyResult(7);
      },
    });

    const input = { brand: 'Spartan', productName: 'BNC-15' };
    const both = Promise.all([
      lookupCrossReferenceRunScoped(input, deps),
      lookupCrossReferenceRunScoped(input, deps),
    ]);
    release?.();
    const [a, b] = await both;

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(a.result).toBe(b.result);
  });

  it('never caches a failure — the next call retries against the database', async () => {
    let calls = 0;
    const { deps, lookup } = harness({
      lookup: async () => {
        calls += 1;
        if (calls === 1) throw new Error('legacy lookup failed');
        return legacyResult(2);
      },
    });
    const input = { brand: 'Spartan', productName: 'BNC-15' };

    await expect(lookupCrossReferenceRunScoped(input, deps)).rejects.toThrow('legacy lookup failed');
    const retry = await lookupCrossReferenceRunScoped(input, deps);

    expect(retry.cacheHit).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache entirely when the TTL is configured to 0', async () => {
    const { deps, lookup } = harness({ ttlMs: 0 });
    const input = { brand: 'Spartan', productName: 'BNC-15' };
    await lookupCrossReferenceRunScoped(input, deps);
    const second = await lookupCrossReferenceRunScoped(input, deps);
    expect(second.cacheHit).toBe(false);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
});

describe('resolveLegacyLookupTtlMs (B0-322)', () => {
  it('defaults to 30s, honors an override, and ignores garbage', () => {
    expect(resolveLegacyLookupTtlMs({} as NodeJS.ProcessEnv)).toBe(30_000);
    expect(resolveLegacyLookupTtlMs({ XREF_LEGACY_LOOKUP_TTL_MS: '5000' } as NodeJS.ProcessEnv)).toBe(5000);
    expect(resolveLegacyLookupTtlMs({ XREF_LEGACY_LOOKUP_TTL_MS: '0' } as NodeJS.ProcessEnv)).toBe(0);
    expect(resolveLegacyLookupTtlMs({ XREF_LEGACY_LOOKUP_TTL_MS: 'nope' } as NodeJS.ProcessEnv)).toBe(30_000);
    expect(resolveLegacyLookupTtlMs({ XREF_LEGACY_LOOKUP_TTL_MS: '-1' } as NodeJS.ProcessEnv)).toBe(30_000);
  });
});
