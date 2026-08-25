import { EMBEDDING_MODEL } from '~/lib/rag/embeddings';
import { getNumberSetting, getStringSetting } from '~/lib/settings/settings-service';

/**
 * B0-650 — the semantic router's tunable knobs, read from the `settings` table (`/admin/settings`).
 *
 * These getters live next to the feature rather than inside `settings-service.ts` — same shape as
 * `isLlmRouterEnabled()` in `intent-classifier.ts`. `settings-service` stays a generic
 * key/value reader (30s per-key cache, DB error → caller's fallback); the typed defaults,
 * validation, and clamping for THIS feature belong here.
 *
 * Tuning strategy (what to move, and when): `src/docs/semantic-router-thresholds.md`.
 *
 * NOT here: `BEX_SEMANTIC_ROUTER_ENABLED` / `BEX_SEMANTIC_ROUTER_SHADOW_MODE`. Those are the
 * rollout levers owned by the B0-649 workflow integration, deliberately kept with the code that
 * decides whether to route on this router at all.
 */

/**
 * Both thresholds must pass for a semantic route to be trusted. Starting values, not proven ones —
 * see the tuning doc: with max-over-examples cosine on `text-embedding-3-large` the realistic
 * same-topic band is roughly 0.3–0.6, so 0.50 is a deliberately conservative opening bid that is
 * expected to be re-tuned against observed fallback rates.
 */
export const DEFAULT_SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD = 0.5;
/** Top score must beat the runner-up by this much, i.e. "is there a clear winner?". */
export const DEFAULT_SEMANTIC_ROUTER_MARGIN_THRESHOLD = 0.1;

/**
 * Dimensionality every router vector must have. This is not a free choice: the shared embedding
 * helper (`createEmbedding` in `~/lib/rag/embeddings.ts`) hard-rejects anything that is not 3072
 * dims, and the whole RAG corpus is embedded with `text-embedding-3-large`. The router computes its
 * own embeddings (it needs a batched call for 50 examples) but keeps the same dimension contract so
 * a vector is never silently compared against one from a different model.
 */
export const SEMANTIC_ROUTER_EMBEDDING_DIMENSIONS = 3072;

/** `text-embedding-3-large` — sourced from `~/lib/rag/embeddings` rather than re-typed as a literal. */
export const DEFAULT_SEMANTIC_ROUTER_EMBEDDING_MODEL = EMBEDDING_MODEL;

/**
 * The only models this router accepts. `text-embedding-3-small` is 1536 dims and would fail the
 * dimension check on every call, so it is NOT offered: an "any model you like" setting that crashes
 * for two of the three plausible values is worse than an honestly narrow one. Widening this list
 * means teaching the router (and the Redis cache payload validation) about a second dimension count
 * first — and re-embedding the corpus, since vectors from different models are not comparable.
 */
export const SEMANTIC_ROUTER_SUPPORTED_EMBEDDING_MODELS = ['text-embedding-3-large'] as const;

export const SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD_KEY = 'SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD';
export const SEMANTIC_ROUTER_MARGIN_THRESHOLD_KEY = 'SEMANTIC_ROUTER_MARGIN_THRESHOLD';
export const SEMANTIC_ROUTER_EMBEDDING_MODEL_KEY = 'SEMANTIC_ROUTER_EMBEDDING_MODEL';

/**
 * Every `settings` key this module owns, in the order the migration seeds them. Exported so the
 * settings UI registration (and any future audit of "which keys does the router read?") can
 * reference the list instead of re-typing the strings.
 */
export const SEMANTIC_ROUTER_SETTING_KEYS = [
  SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD_KEY,
  SEMANTIC_ROUTER_MARGIN_THRESHOLD_KEY,
  SEMANTIC_ROUTER_EMBEDDING_MODEL_KEY,
] as const;

/** Cosine similarity is only meaningful in [0,1] here, so a nonsensical stored value is clamped, not obeyed. */
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * Minimum top-route similarity for a semantic route to be trusted ("is this a real match at all?").
 * Missing/unreadable/non-numeric row → the default; out-of-range values are clamped into [0,1].
 */
export async function getSemanticRouterConfidenceThreshold(): Promise<number> {
  const value = await getNumberSetting(
    SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD_KEY,
    DEFAULT_SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD,
  );
  return clamp01(value);
}

/**
 * Minimum gap between the top route and the runner-up ("is it a clear winner?"). Same
 * missing/invalid → default, out-of-range → clamped semantics as the confidence threshold.
 */
export async function getSemanticRouterMarginThreshold(): Promise<number> {
  const value = await getNumberSetting(
    SEMANTIC_ROUTER_MARGIN_THRESHOLD_KEY,
    DEFAULT_SEMANTIC_ROUTER_MARGIN_THRESHOLD,
  );
  return clamp01(value);
}

/**
 * Embedding model used for BOTH the example corpus and live messages — they must match or the
 * cosine comparison is meaningless. An unsupported stored value falls back to the default instead
 * of being passed to OpenAI, because a 1536-dim response would fail the dimension check and take
 * routing down for as long as the bad row sat there.
 */
export async function getSemanticRouterEmbeddingModel(): Promise<string> {
  const value = await getStringSetting(
    SEMANTIC_ROUTER_EMBEDDING_MODEL_KEY,
    DEFAULT_SEMANTIC_ROUTER_EMBEDDING_MODEL,
  );
  const trimmed = value.trim();
  return (SEMANTIC_ROUTER_SUPPORTED_EMBEDDING_MODELS as readonly string[]).includes(trimmed)
    ? trimmed
    : DEFAULT_SEMANTIC_ROUTER_EMBEDDING_MODEL;
}
