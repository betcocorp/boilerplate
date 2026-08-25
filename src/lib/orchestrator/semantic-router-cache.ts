import { createHash } from 'node:crypto';

import { Redis } from '@upstash/redis';

import type { SmeAgentId } from '~/lib/agents/agent-registry';

/**
 * B0-654 — shared Redis cache for the semantic router's EXAMPLE embeddings (not live message
 * embeddings; those stay in-process, see `semantic-router.ts`).
 *
 * Why: every serverless instance / container that boots would otherwise re-embed the whole example
 * corpus (~50 utterances) against OpenAI on its first routed message. One shared cache makes that a
 * single cost for the fleet, and a cache read is a few hundred KB of Redis instead of a model call.
 *
 * Shape of the contract this module offers `semantic-router.ts` (kept deliberately narrow so the
 * router is testable by mocking exactly two functions):
 *   readCachedRouteEmbeddings(...)  -> number[][] | null   ("null" always means "recompute")
 *   writeCachedRouteEmbeddings(...) -> boolean             (false means "not cached", never throws)
 *
 * Redis is OPTIONAL, exactly like `~/lib/permissions/redis.ts`: with `UPSTASH_REDIS_REST_URL` /
 * `UPSTASH_REDIS_REST_TOKEN` unset, `getRedis()` returns null, reads return null and writes no-op.
 * Every operation is try/catch-degraded — a Redis outage must cost latency, never correctness.
 */

const CACHE_KEY_PREFIX = 'semantic_router:examples';

/**
 * 90 days rather than "no expiry". The key already carries the examples version and the model, so a
 * stale payload can never be *served* after a version bump — but it would sit in Redis forever
 * paying storage for a corpus nobody uses. A TTL far longer than any deploy cadence gets both.
 */
const CACHE_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * Payload envelope version. Bump when the ENCODING below changes (not when examples change — that
 * is `SEMANTIC_ROUTER_EXAMPLES_VERSION`, which is already part of the key). An older-shaped payload
 * fails validation and falls back to recompute, which is the safe direction.
 */
const PAYLOAD_FORMAT = 1;

/**
 * Vectors are stored as base64-packed Float32, one string per example, NOT as JSON number arrays.
 *
 * Measured: 3072 float64s serialized as JSON text is ~60 KB per vector, so a 50-example corpus in
 * one key is ~3 MB — over the 1 MB per-request ceiling on Upstash's smaller plans. Float32 packing
 * is 3072 * 4 = 12,288 bytes -> 16,384 base64 chars per vector (~16 KB), and the cache is split one
 * key PER ROUTE (10 examples), so a single request moves ~165 KB. Comfortably inside the limit
 * without needing to know which Upstash plan an environment is on.
 *
 * Float32 costs ~1e-7 of cosine precision against the float64 the API returns — several orders of
 * magnitude below the 0.10 margin threshold, so it cannot change a routing decision. Packing is
 * little-endian (both x86-64 and arm64 are); a cross-endian reader would fail the finite-value
 * validation below and recompute rather than route on garbage.
 */
const BYTES_PER_FLOAT32 = 4;

export type SemanticRouterCacheKeyParts = {
  examplesVersion: string;
  embeddingModel: string;
  route: SmeAgentId;
};

/**
 * `semantic_router:examples:<examplesVersion>:<embeddingModel>:<route>`.
 *
 * The MODEL is in the key on purpose: the same utterances embedded by a different model are
 * different (possibly different-length) vectors, and a version-only key would happily serve a
 * wrong-dimension payload to a router that had switched models. The ROUTE suffix is the per-route
 * split described above.
 */
export function buildSemanticRouterCacheKey({
  examplesVersion,
  embeddingModel,
  route,
}: SemanticRouterCacheKeyParts): string {
  return `${CACHE_KEY_PREFIX}:${examplesVersion}:${embeddingModel}:${route}`;
}

/**
 * Fingerprint of the exact utterance texts a payload was computed from. Belt-and-braces against the
 * one failure mode the key cannot catch: someone edits the examples and forgets to bump
 * `SEMANTIC_ROUTER_EXAMPLES_VERSION`. A mismatch recomputes instead of routing on vectors that
 * belong to text no longer in the codebase.
 */
export function computeExamplesFingerprint(examples: readonly string[]): string {
  const canonical = examples.map((e) => `${e.length}:${e}`).join('|');
  return createHash('sha256').update(canonical, 'utf8').digest('hex').slice(0, 32);
}

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  try {
    return new Redis({ url, token });
  } catch {
    return null;
  }
}

/** True when Upstash credentials are present. Reported by `initSemanticRouter` for observability. */
export function isSemanticRouterCacheConfigured(): boolean {
  return Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

/** base64-packed little-endian Float32 for one vector. Exported for the encode/decode round-trip test. */
export function encodeVector(vector: readonly number[]): string {
  const packed = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i += 1) packed[i] = vector[i]!;
  return Buffer.from(packed.buffer, packed.byteOffset, packed.byteLength).toString('base64');
}

/** Inverse of `encodeVector`. Returns null on any length/format problem rather than a short vector. */
export function decodeVector(encoded: string, expectedDimensions: number): number[] | null {
  let buffer: Buffer;
  try {
    buffer = Buffer.from(encoded, 'base64');
  } catch {
    return null;
  }

  if (buffer.byteLength !== expectedDimensions * BYTES_PER_FLOAT32) return null;

  const out = new Array<number>(expectedDimensions);
  for (let i = 0; i < expectedDimensions; i += 1) {
    const value = buffer.readFloatLE(i * BYTES_PER_FLOAT32);
    if (!Number.isFinite(value)) return null;
    out[i] = value;
  }
  return out;
}

type CachedPayload = {
  format: number;
  examplesVersion: string;
  embeddingModel: string;
  dimensions: number;
  count: number;
  fingerprint: string;
  vectors: string[];
};

/**
 * Validate a payload read back from Redis before trusting a single number in it. A stale or corrupt
 * payload must degrade to "recompute", never poison routing — a wrong-dimension or truncated vector
 * would silently skew every similarity score for the lifetime of the process.
 */
function parsePayload(
  raw: unknown,
  expected: {
    examplesVersion: string;
    embeddingModel: string;
    dimensions: number;
    count: number;
    fingerprint: string;
  },
): number[][] | null {
  // Upstash deserializes JSON for us, but a value written by another client (or an older format)
  // can still arrive as a string.
  let value: unknown = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (typeof value !== 'object' || value === null) return null;

  const payload = value as Partial<CachedPayload>;
  if (payload.format !== PAYLOAD_FORMAT) return null;
  if (payload.examplesVersion !== expected.examplesVersion) return null;
  if (payload.embeddingModel !== expected.embeddingModel) return null;
  if (payload.dimensions !== expected.dimensions) return null;
  if (payload.count !== expected.count) return null;
  if (payload.fingerprint !== expected.fingerprint) return null;
  if (!Array.isArray(payload.vectors) || payload.vectors.length !== expected.count) return null;

  const vectors: number[][] = [];
  for (const encoded of payload.vectors) {
    if (typeof encoded !== 'string') return null;
    const decoded = decodeVector(encoded, expected.dimensions);
    if (!decoded) return null;
    vectors.push(decoded);
  }

  return vectors;
}

export type ReadCachedRouteEmbeddingsArgs = SemanticRouterCacheKeyParts & {
  examples: readonly string[];
  dimensions: number;
};

/**
 * Vectors for one route's examples, or null for every "don't trust the cache" case: Redis not
 * configured, key missing, Redis error, or a payload that fails validation. The caller treats null
 * as "compute locally".
 */
export async function readCachedRouteEmbeddings({
  examplesVersion,
  embeddingModel,
  route,
  examples,
  dimensions,
}: ReadCachedRouteEmbeddingsArgs): Promise<number[][] | null> {
  const redis = getRedis();
  if (!redis) return null;

  try {
    const raw = await redis.get<unknown>(
      buildSemanticRouterCacheKey({ examplesVersion, embeddingModel, route }),
    );
    if (raw == null) return null;
    return parsePayload(raw, {
      examplesVersion,
      embeddingModel,
      dimensions,
      count: examples.length,
      fingerprint: computeExamplesFingerprint(examples),
    });
  } catch {
    return null;
  }
}

export type WriteCachedRouteEmbeddingsArgs = SemanticRouterCacheKeyParts & {
  examples: readonly string[];
  vectors: readonly number[][];
};

/**
 * Persist one route's example vectors for the rest of the fleet. Returns whether the write actually
 * happened; a false is never an error the caller has to handle (the vectors are already in memory).
 */
export async function writeCachedRouteEmbeddings({
  examplesVersion,
  embeddingModel,
  route,
  examples,
  vectors,
}: WriteCachedRouteEmbeddingsArgs): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return false;
  if (vectors.length !== examples.length || vectors.length === 0) return false;

  const first = vectors[0];
  if (!first) return false;

  const payload: CachedPayload = {
    format: PAYLOAD_FORMAT,
    examplesVersion,
    embeddingModel,
    dimensions: first.length,
    count: vectors.length,
    fingerprint: computeExamplesFingerprint(examples),
    vectors: vectors.map(encodeVector),
  };

  try {
    await redis.set(buildSemanticRouterCacheKey({ examplesVersion, embeddingModel, route }), payload, {
      ex: CACHE_TTL_SECONDS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Serialized size in bytes of the payload that WOULD be written for these vectors. Used by the
 * cache tests to keep the per-request payload honestly inside Upstash's smaller-plan 1 MB ceiling —
 * a regression here (e.g. reverting to JSON floats) should fail a test, not a production write.
 */
export function measureCachePayloadBytes(
  examples: readonly string[],
  vectors: readonly number[][],
): number {
  const payload: CachedPayload = {
    format: PAYLOAD_FORMAT,
    examplesVersion: 'measure',
    embeddingModel: 'measure',
    dimensions: vectors[0]?.length ?? 0,
    count: vectors.length,
    fingerprint: computeExamplesFingerprint(examples),
    vectors: vectors.map(encodeVector),
  };
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}
