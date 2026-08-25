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
  created_at: string;
  updated_at: string;
};

/** Which router a run exercises (mirrors the `ROUTER_TYPE` setting). */
export type RoutingTestRouterType = 'keyword' | 'semantic';

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

export type RoutingTestItemDetail =
  | RoutingTestKeywordDetail
  | RoutingTestSemanticDetail;

/** One item's outcome. Ephemeral — never persisted (B0-659). */
export type RoutingTestItemResult = {
  itemId: string;
  prompt: string;
  expectedAgent: SmeAgentId;
  predicted: RoutingTestPredictedLabel;
  passed: boolean;
  /** Non-null when the router degraded (semantic fallback, missing service, thrown error). */
  error: string | null;
  detail: RoutingTestItemDetail | null;
};

export type RoutingTestRunSummary = {
  total: number;
  correct: number;
  /** 0–1, rounded to 4 decimal places. `0` when `total === 0`. */
  accuracy: number;
  /** Items whose router reported an error/degradation, correct or not. */
  degraded: number;
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
    }
  | {
      ok: false;
      routerType: RoutingTestRouterType;
      error: string;
    };
