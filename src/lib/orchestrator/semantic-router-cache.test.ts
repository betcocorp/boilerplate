import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-654 — Redis example-embedding cache. No real Redis: `@upstash/redis` is replaced with an
 * in-memory store whose `get`/`set` are vi.fn()s, so a case can make Redis miss, return garbage, or
 * throw. Arrow-wrapped bodies so the hoisted `vi.mock` factory can reference these consts (same
 * pattern as `intent-classifier.test.ts`).
 *
 * What these tests CANNOT prove: that two separate instances actually share the cache. That needs a
 * real Redis and two processes, neither of which exists in this environment. What is covered instead
 * is every branch a second instance would take — key derivation (so both instances agree on the
 * key), hit, miss, malformed payload, and Redis-absent.
 */
const redisGetMock = vi.fn();
const redisSetMock = vi.fn();
const redisConstructorMock = vi.fn();

vi.mock('@upstash/redis', () => ({
  Redis: class {
    constructor(config: unknown) {
      redisConstructorMock(config);
    }
    get(...args: unknown[]) {
      return redisGetMock(...args);
    }
    set(...args: unknown[]) {
      return redisSetMock(...args);
    }
  },
}));

import {
  buildSemanticRouterCacheKey,
  computeExamplesFingerprint,
  decodeVector,
  encodeVector,
  isSemanticRouterCacheConfigured,
  measureCachePayloadBytes,
  readCachedRouteEmbeddings,
  writeCachedRouteEmbeddings,
} from '~/lib/orchestrator/semantic-router-cache';
import { SEMANTIC_ROUTER_EMBEDDING_DIMENSIONS } from '~/lib/orchestrator/semantic-router-config';
import {
  SEMANTIC_ROUTER_EXAMPLES,
  SEMANTIC_ROUTER_EXAMPLES_VERSION,
} from '~/lib/orchestrator/semantic-router-examples';

const DIMS = SEMANTIC_ROUTER_EMBEDDING_DIMENSIONS;
const MODEL = 'text-embedding-3-large';
const ORIGINAL_ENV = { ...process.env };

const EXAMPLES = SEMANTIC_ROUTER_EXAMPLES.floor;

/** Deterministic pseudo-random unit-ish vector, so payload sizes are realistic (not all zeros). */
function fakeVector(seed: number): number[] {
  const out = new Array<number>(DIMS);
  // Lehmer LCG — small multiplier so every intermediate stays inside Number.MAX_SAFE_INTEGER.
  let x = seed * 7919 + 1;
  for (let i = 0; i < DIMS; i += 1) {
    x = (x * 48271) % 2147483647;
    out[i] = (x / 2147483647) * 2 - 1;
  }
  return out;
}

const VECTORS = EXAMPLES.map((_, i) => fakeVector(i));

const readArgs = {
  examplesVersion: SEMANTIC_ROUTER_EXAMPLES_VERSION,
  embeddingModel: MODEL,
  route: 'floor' as const,
  examples: EXAMPLES,
  dimensions: DIMS,
};

/** A store-backed get/set pair, i.e. "Redis works". */
function useWorkingRedis(): Map<string, unknown> {
  const store = new Map<string, unknown>();
  redisGetMock.mockImplementation((key: string) => Promise.resolve(store.get(key) ?? null));
  redisSetMock.mockImplementation((key: string, value: unknown) => {
    // Upstash serializes to JSON on the wire and deserializes on read; mimic that round-trip so a
    // test can never pass by accident on a shared object reference.
    store.set(key, JSON.parse(JSON.stringify(value)));
    return Promise.resolve('OK');
  });
  return store;
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://example.upstash.io';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'test-token';
  redisGetMock.mockReset();
  redisSetMock.mockReset();
  redisConstructorMock.mockReset();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('cache key', () => {
  it('is scoped by examples version, embedding model, and route', () => {
    expect(
      buildSemanticRouterCacheKey({
        examplesVersion: 'v1',
        embeddingModel: MODEL,
        route: 'floor',
      }),
    ).toBe('semantic_router:examples:v1:text-embedding-3-large:floor');
  });

  it('changes when the version, the model, or the route changes', () => {
    const base = { examplesVersion: 'v1', embeddingModel: MODEL, route: 'floor' as const };
    const keys = new Set([
      buildSemanticRouterCacheKey(base),
      buildSemanticRouterCacheKey({ ...base, examplesVersion: 'v2' }),
      buildSemanticRouterCacheKey({ ...base, embeddingModel: 'other-model' }),
      buildSemanticRouterCacheKey({ ...base, route: 'bathroom' }),
    ]);
    expect(keys.size).toBe(4);
  });

  it('fingerprints the exact utterance texts, so an un-bumped version is still caught', () => {
    const a = computeExamplesFingerprint(['one', 'two']);
    expect(computeExamplesFingerprint(['one', 'two'])).toBe(a);
    expect(computeExamplesFingerprint(['one', 'two!'])).not.toBe(a);
    // Not vulnerable to a boundary shift between two adjacent examples.
    expect(computeExamplesFingerprint(['onet', 'wo'])).not.toBe(computeExamplesFingerprint(['one', 'two']));
  });
});

describe('float32 packing', () => {
  it('round-trips a vector within float32 precision', () => {
    const vector = fakeVector(7);
    const decoded = decodeVector(encodeVector(vector), DIMS);

    expect(decoded).not.toBeNull();
    for (let i = 0; i < DIMS; i += 1) {
      expect(decoded![i]).toBeCloseTo(vector[i]!, 6);
    }
  });

  it('rejects a payload whose byte length does not match the expected dimensions', () => {
    expect(decodeVector(encodeVector(fakeVector(1)), DIMS - 1)).toBeNull();
    expect(decodeVector(encodeVector([1, 2, 3]), DIMS)).toBeNull();
    expect(decodeVector('not-base64-at-all!!', DIMS)).toBeNull();
  });

  it('keeps one route\'s payload well inside a 1 MB request ceiling', () => {
    const bytes = measureCachePayloadBytes(EXAMPLES, VECTORS);

    // ~16.4 KB per vector as base64 float32 x 10 examples. The point of this assertion is that a
    // regression to JSON number arrays (~60 KB per vector, ~600 KB per route, ~3 MB for the corpus)
    // fails here instead of failing an Upstash write in production.
    expect(bytes).toBeLessThan(1024 * 1024);
    expect(bytes).toBeGreaterThan(100_000);
  });
});

describe('read/write round-trip', () => {
  it('writes then reads back the same vectors', async () => {
    useWorkingRedis();

    expect(await writeCachedRouteEmbeddings({ ...readArgs, vectors: VECTORS })).toBe(true);
    const read = await readCachedRouteEmbeddings(readArgs);

    expect(read).not.toBeNull();
    expect(read).toHaveLength(VECTORS.length);
    expect(read![0]![0]).toBeCloseTo(VECTORS[0]![0]!, 6);
    expect(read![9]![DIMS - 1]).toBeCloseTo(VECTORS[9]![DIMS - 1]!, 6);
  });

  it('writes under the key both instances would derive', async () => {
    const store = useWorkingRedis();

    await writeCachedRouteEmbeddings({ ...readArgs, vectors: VECTORS });

    expect([...store.keys()]).toEqual([
      buildSemanticRouterCacheKey({
        examplesVersion: SEMANTIC_ROUTER_EXAMPLES_VERSION,
        embeddingModel: MODEL,
        route: 'floor',
      }),
    ]);
  });

  it('sets a long TTL rather than leaving the key to live forever', async () => {
    useWorkingRedis();

    await writeCachedRouteEmbeddings({ ...readArgs, vectors: VECTORS });

    const options = redisSetMock.mock.calls[0]?.[2] as { ex: number };
    expect(options.ex).toBeGreaterThan(30 * 24 * 60 * 60);
  });

  it('misses (returns null) when the key is absent', async () => {
    useWorkingRedis();
    expect(await readCachedRouteEmbeddings(readArgs)).toBeNull();
  });

  it('misses after a version bump, so a bump invalidates the cache', async () => {
    useWorkingRedis();
    await writeCachedRouteEmbeddings({ ...readArgs, vectors: VECTORS });

    expect(await readCachedRouteEmbeddings({ ...readArgs, examplesVersion: 'v99' })).toBeNull();
    // ...and the un-bumped read still hits, proving the miss came from the version, not a broken write.
    expect(await readCachedRouteEmbeddings(readArgs)).not.toBeNull();
  });

  it('misses when the examples changed but the version was NOT bumped (fingerprint guard)', async () => {
    useWorkingRedis();
    await writeCachedRouteEmbeddings({ ...readArgs, vectors: VECTORS });

    const edited = [...EXAMPLES.slice(0, EXAMPLES.length - 1), 'a reworded utterance'];
    expect(await readCachedRouteEmbeddings({ ...readArgs, examples: edited })).toBeNull();
  });

  it('refuses to write when the vector count does not match the example count', async () => {
    useWorkingRedis();

    expect(
      await writeCachedRouteEmbeddings({ ...readArgs, vectors: VECTORS.slice(0, 3) }),
    ).toBe(false);
    expect(await writeCachedRouteEmbeddings({ ...readArgs, vectors: [] })).toBe(false);
    expect(redisSetMock).not.toHaveBeenCalled();
  });
});

describe('malformed payloads fall back to recompute', () => {
  const cases: Array<[string, unknown]> = [
    ['not an object', 42],
    ['null-ish garbage', 'null'],
    ['unparseable string', '{{{'],
    ['wrong envelope format', { format: 99 }],
    ['wrong dimensions', { format: 1, examplesVersion: SEMANTIC_ROUTER_EXAMPLES_VERSION, embeddingModel: MODEL, dimensions: 1536, count: EXAMPLES.length, fingerprint: computeExamplesFingerprint(EXAMPLES), vectors: EXAMPLES.map(() => encodeVector(fakeVector(0))) }],
    ['truncated vector list', { format: 1, examplesVersion: SEMANTIC_ROUTER_EXAMPLES_VERSION, embeddingModel: MODEL, dimensions: DIMS, count: EXAMPLES.length, fingerprint: computeExamplesFingerprint(EXAMPLES), vectors: [encodeVector(fakeVector(0))] }],
    ['non-string vector entry', { format: 1, examplesVersion: SEMANTIC_ROUTER_EXAMPLES_VERSION, embeddingModel: MODEL, dimensions: DIMS, count: EXAMPLES.length, fingerprint: computeExamplesFingerprint(EXAMPLES), vectors: EXAMPLES.map(() => 0) }],
    ['short-vector payload', { format: 1, examplesVersion: SEMANTIC_ROUTER_EXAMPLES_VERSION, embeddingModel: MODEL, dimensions: DIMS, count: EXAMPLES.length, fingerprint: computeExamplesFingerprint(EXAMPLES), vectors: EXAMPLES.map(() => encodeVector([1, 2, 3])) }],
    ['model mismatch', { format: 1, examplesVersion: SEMANTIC_ROUTER_EXAMPLES_VERSION, embeddingModel: 'some-other-model', dimensions: DIMS, count: EXAMPLES.length, fingerprint: computeExamplesFingerprint(EXAMPLES), vectors: EXAMPLES.map(() => encodeVector(fakeVector(0))) }],
  ];

  for (const [label, payload] of cases) {
    it(`returns null for ${label}`, async () => {
      redisGetMock.mockResolvedValue(payload);
      expect(await readCachedRouteEmbeddings(readArgs)).toBeNull();
    });
  }
});

describe('degraded Redis', () => {
  it('reads null and writes false when Upstash credentials are absent, without constructing a client', async () => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;

    expect(isSemanticRouterCacheConfigured()).toBe(false);
    expect(await readCachedRouteEmbeddings(readArgs)).toBeNull();
    expect(await writeCachedRouteEmbeddings({ ...readArgs, vectors: VECTORS })).toBe(false);
    expect(redisConstructorMock).not.toHaveBeenCalled();
    expect(redisGetMock).not.toHaveBeenCalled();
    expect(redisSetMock).not.toHaveBeenCalled();
  });

  it('degrades instead of throwing when a Redis read fails', async () => {
    redisGetMock.mockRejectedValue(new Error('ECONNRESET'));
    await expect(readCachedRouteEmbeddings(readArgs)).resolves.toBeNull();
  });

  it('degrades instead of throwing when a Redis write fails', async () => {
    redisSetMock.mockRejectedValue(new Error('request too large'));
    await expect(
      writeCachedRouteEmbeddings({ ...readArgs, vectors: VECTORS }),
    ).resolves.toBe(false);
  });

  it('reports configured when both credentials are present', () => {
    expect(isSemanticRouterCacheConfigured()).toBe(true);
  });
});
