import type { SmeAgentId } from '~/lib/agents/agent-registry';

/**
 * B0-657 — one row of `public.routing_test_items`.
 *
 * Deliberately flat: there is no parent test/dataset entity, because there is (and will only ever
 * be) ONE routing test. Do not extend this into a second copy of `public.test_items`.
 */
export type RoutingTestItemRecord = {
  id: string;
  prompt: string;
  expected_agent: SmeAgentId;
  /** `halfvec(3072)` of `prompt` (B0-669) — round-trips through supabase-js as a JSON number array. */
  embedding_large: number[] | null;
  /** Model that produced `embedding_large` (B0-669), e.g. `text-embedding-3-large`. */
  embedding_model_large: string | null;
  created_at: string;
  updated_at: string;
};

/** Which router a run exercises (mirrors the `ROUTER_TYPE` setting). */
export type RoutingTestRouterType = 'keyword' | 'semantic' | 'llm';

/**
 * The label space a router prediction is compared in. `SmeRouteDecision.agent` can be `null`
 * (empty message / no keyword signal); the house convention (`normalizeKeywordRoute` in
 * `~/lib/tests/routing-comparison`) collapses that to `'ambiguous'` so pass/fail stays meaningful
 * instead of silently unscored.
 */
export type RoutingTestPredictedLabel = SmeAgentId | 'ambiguous';

/** Router-specific detail, surfaced as-is — nothing here is recomputed by the routing test. */
export type RoutingTestKeywordDetail = {
  kind: 'keyword';
  decisionPath: string;
  rationale: string;
  matchedPhrases: Record<string, string[]>;
  scores: Record<string, number>;
};

export type RoutingTestSemanticDetail = {
  kind: 'semantic';
  confidence: number;
  similarity: number;
  margin: number;
  path: 'semantic' | 'fallback';
  scores: { route: string; similarity: number }[];
  thresholds: { confidence: number; margin: number };
  thresholdsPassed: { confidence: boolean; margin: boolean };
  latencyMs: number;
  examplesVersion: string;
  embeddingModel: string;
};

export type RoutingTestLlmDetail = {
  kind: 'llm';
  /** `'llm'` on a real classification, `'keyword_fallback'` when the LLM router degraded. */
  source: 'llm' | 'keyword_fallback';
  confidence: number;
  /** Non-null only on the `keyword_fallback` source — mirrors `IntentClassification.fallbackReason`. */
  fallbackReason: string | null;
  /** Null on the fallback path — no model call was made. */
  model: string | null;
  suggestedTool: string | null;
};

export type RoutingTestItemDetail =
  | RoutingTestKeywordDetail
  | RoutingTestSemanticDetail
  | RoutingTestLlmDetail;

/**
 * One item's outcome. Was ephemeral-only under B0-659; B0-667 snapshots this shape into
 * `public.routing_test_run_items` on every `ok: true` run (see `./repository.ts`).
 */
export type RoutingTestItemResult = {
  itemId: string;
  prompt: string;
  expectedAgent: SmeAgentId;
  predicted: RoutingTestPredictedLabel;
  passed: boolean;
  /** Non-null when the router degraded (semantic fallback, missing service, thrown error). */
  error: string | null;
  detail: RoutingTestItemDetail | null;
  /** Wall-clock time for this one item's classification call (B0-667), in milliseconds. */
  elapsedMs: number;
};

export type RoutingTestRunSummary = {
  total: number;
  correct: number;
  /** 0–1, rounded to 4 decimal places. `0` when `total === 0`. */
  accuracy: number;
  /** Items whose router reported an error/degradation, correct or not. */
  degraded: number;
  /** Wall-clock time for the whole run (B0-667), in milliseconds. */
  durationMs: number;
  /** Mean of every item's `elapsedMs` (B0-667). `0` when there are no items. */
  avgItemDurationMs: number;
};

export type RoutingTestRunResult =
  | {
      ok: true;
      routerType: RoutingTestRouterType;
      ranAt: string;
      items: RoutingTestItemResult[];
      summary: RoutingTestRunSummary;
      /** Set when the whole run degraded (e.g. semantic router unavailable). */
      warning: string | null;
      /**
       * B0-671 — the resolved OpenAI model id the `llm` router actually called (from
       * `resolveResponsesModel(modelTag)`), so a caller can verify which model produced this run
       * without relying on `items[].detail.model` alone. `null` for `keyword`/`semantic` runs, and
       * for an `llm` run where no explicit model tag was chosen (falls back to `BEX_ROUTER_MODEL`).
       */
      model: string | null;
    }
  | {
      ok: false;
      routerType: RoutingTestRouterType;
      error: string;
    };

/**
 * B0-667 — one row of `public.routing_test_runs`: the persisted, run-level summary of an `ok: true`
 * `RoutingTestRunResult`. Written by `insertRoutingTestRun` (`./repository.ts`) as a best-effort
 * side effect of `runRoutingTestAction` — the live inline result stays the source of truth for the
 * request that triggered it either way.
 */
export type RoutingTestRunRecord = {
  id: string;
  router_type: RoutingTestRouterType;
  ran_at: string;
  total_items: number;
  passed_items: number;
  degraded_items: number;
  duration_ms: number;
  avg_item_duration_ms: number | null;
  warning: string | null;
  /** B0-671 — the resolved OpenAI model id an `llm` run called, `null` otherwise (see `RoutingTestRunResult.model`). */
  model: string | null;
  created_at: string;
};

/**
 * B0-667 — one row of `public.routing_test_run_items`: a per-item snapshot of a
 * `RoutingTestItemResult` taken at run time. `prompt`/`expected_agent` are snapshots of the source
 * `routing_test_items` row (which can later change or be deleted — `item_id` is nullable via
 * `ON DELETE SET NULL` for exactly that reason).
 */
export type RoutingTestRunItemRecord = {
  id: string;
  run_id: string;
  item_id: string | null;
  row_index: number;
  prompt: string;
  expected_agent: SmeAgentId;
  predicted_agent: RoutingTestPredictedLabel;
  passed: boolean;
  error: string | null;
  elapsed_ms: number;
  detail: RoutingTestItemDetail | null;
  created_at: string;
};
