/**
 * B0-629 — the Routing panel of the `/admin` Mission Control dashboard.
 *
 * Two questions, one window:
 *  1. Where did the orchestrator send traffic? (`rows` — the horizontal bar chart)
 *  2. Is the LLM router trustworthy? (`agreement` — live keyword-vs-LLM agreement and the
 *     classifier's own mean confidence)
 *
 * Read-only and folded in Node, for the same reason documented at the top of
 * `~/lib/observability/aggregates.ts`. `buildRoutingHealthData` is pure so the correctness
 * traps below are unit-testable without a database; only `getRoutingHealthData` does I/O.
 */

import { SME_AGENT_IDS, V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import {
  type AggregateWindow,
  buildRoutingDistribution,
  percentileNearestRank,
  type RunScanRow,
  roundTo,
  scanWorkflowRuns,
  scanWorkflowStepOutputsByName,
  type VersionFilter,
} from '~/lib/observability/aggregates';
import { readStepGateRecords } from '~/lib/workflows/product-support/product-support-schemas';

/**
 * A classifier confidence under this is "the router guessed". Deliberately the same 0.4 the
 * regulated-claim clamp uses in `run-product-support-workflow.ts`, so "low confidence" means
 * one thing across the admin surfaces.
 */
export const LOW_CONFIDENCE_THRESHOLD = 0.4;

/**
 * The step and gate that record a LIVE routing decision. Confirmed against the live DB
 * (2026-08-22): 1,348 `llm_intent_classifier_live` records exist on `orchestration_planner`
 * step rows, first seen 2026-08-18 (the B0-511 cutover) — so this stat is only populated for
 * traffic after that date, and a longer window will show a `comparableCount` well below
 * `totalRuns`. The shadow-mode predecessor (`llm_intent_classifier_shadow`) is deliberately
 * NOT read: it recorded what the classifier *would* have done, not what routed the turn.
 */
const PLANNER_STEP_NAME = 'orchestration_planner';
const LIVE_CLASSIFIER_GATE_ID = 'llm_intent_classifier_live';

/**
 * B0-651 — the two gate ids `~/lib/workflows/product-support/semantic-router-decision.ts` writes,
 * both on the same `orchestration_planner` step as the classifier gates above. Read together (and
 * distinguished by `thresholds.mode`) so a rollout that is half shadow and half live still reduces
 * to one set of numbers, while `liveCount`/`shadowCount` say how the sample splits.
 */
const SEMANTIC_ROUTER_LIVE_GATE_ID = 'semantic_router_live';
const SEMANTIC_ROUTER_SHADOW_GATE_ID = 'semantic_router_shadow';
const SEMANTIC_PATH_SEMANTIC = 'semantic';
const SEMANTIC_PATH_FALLBACK = 'fallback';

/** `gateRecordSchema.verdict` is a free string; these are the two the live gate writes. */
const AGREES_VERDICT = 'agrees_with_keyword_router';
const DISAGREES_VERDICT = 'disagrees_with_keyword_router';

/**
 * `inputs.classifierSource`. Only `'llm'` rows may feed the confidence mean:
 * `fallbackClassification` (`~/lib/orchestrator/intent-classifier.ts`) hard-codes
 * `confidence: 0` whenever the LLM router is disabled, times out or errors, so counting
 * `keyword_fallback` rows would fabricate zeros into both the mean and the low-confidence
 * count. They are reported separately as `fallbackCount` instead.
 */
const LLM_SOURCE = 'llm';
const KEYWORD_FALLBACK_SOURCE = 'keyword_fallback';

/** Buckets used by `buildRoutingDistribution`, neither of which is an SME agent. */
const AMBIGUOUS_ROUTE = 'ambiguous';
const UNROUTED_ROUTE = 'unrouted';

const AGENT_LABELS = new Map<string, string>(
  V1_AGENT_REGISTRY.map((agent) => [agent.id, agent.label]),
);
const AGENT_IDS = new Set<string>(SME_AGENT_IDS);

export type RoutingHealthRow = {
  /** `SmeAgentId | 'ambiguous' | 'unrouted'` — or any other literal a historical run persisted. */
  route: string;
  label: string;
  isAgent: boolean;
  count: number;
  /** Share of `totalRuns`, 0..1. */
  share: number;
  avgConfidence: number | null;
};

export type RouterAgreementSummary = {
  /** LLM-sourced live-gate records carrying one of the two agreement verdicts. */
  comparableCount: number;
  agreementCount: number;
  /** `null` when nothing was comparable — never 0, which would read as "the router never agrees". */
  agreementRate: number | null;
  /** Mean `inputs.classifierConfidence` over `classifierSource === 'llm'` records ONLY. */
  meanLlmConfidence: number | null;
  llmConfidenceSampleSize: number;
  lowConfidenceCount: number;
  fallbackCount: number;
};

/**
 * B0-651 — a distribution over one numeric field, named for the ticket's "histogram" metrics.
 *
 * Percentiles use `percentileNearestRank` (no interpolation) so every reported value is an
 * OBSERVED measurement, matching `/admin/observability`'s latency figures exactly. Every field is
 * `null` at `sampleSize === 0` rather than 0 — "no samples" and "measured zero" must not read alike
 * (a warm in-process cache hit can legitimately measure 0ms, which is a real data point).
 */
export type SemanticRouterDistribution = {
  sampleSize: number;
  mean: number | null;
  p50: number | null;
  p95: number | null;
  p99: number | null;
  min: number | null;
  max: number | null;
};

/** One cell of the `semantic_router_route` counter: a route, labeled by the path that produced it. */
export type SemanticRouterRouteCount = {
  route: string;
  /** `'semantic'` or `'fallback'` — the AC's metric label. */
  path: string;
  count: number;
};

/**
 * B0-651 — the semantic router's rollout metrics.
 *
 * These are QUERY-TIME REDUCERS over persisted `workflow_steps.output` gate records, not an
 * exported metrics pipeline: bex-2.0 has no Prometheus/StatsD/OpenTelemetry exporter (see
 * `~/lib/observability/logger.ts` — observability here is structured logs plus Supabase rows). The
 * field names deliberately match the metric names the ticket asks for, so the mapping from
 * "`semantic_router_fallback_rate` in Prometheus" to "this number on the dashboard" is one-to-one.
 */
export type SemanticRouterMetrics = {
  /** Total semantic-router decisions recorded in the window (live + shadow). */
  decisionCount: number;
  /** Decisions where the router was the authority (`semantic_router_live`). */
  liveCount: number;
  /** Decisions recorded for comparison only (`semantic_router_shadow`). */
  shadowCount: number;
  /** `semantic_router_route` — counter per route, labeled by path. Desc by count. */
  semanticRouterRoute: SemanticRouterRouteCount[];
  /** `semantic_router_latency_ms` — end-to-end router latency. */
  semanticRouterLatencyMs: SemanticRouterDistribution;
  /**
   * The honest split of the number above. A cold route pays an OpenAI embedding round-trip
   * (`embeddingMs`, typically 80-400ms); only a warm in-process cache hit is single-digit ms. Both
   * halves are reported so nobody reads a warm p50 as the general case.
   */
  semanticRouterEmbeddingMs: SemanticRouterDistribution;
  semanticRouterScoringMs: SemanticRouterDistribution;
  /** `semantic_router_confidence`. */
  semanticRouterConfidence: SemanticRouterDistribution;
  /** `semantic_router_margin`. */
  semanticRouterMargin: SemanticRouterDistribution;
  /**
   * `semantic_router_fallback_rate` — derived: `fallbackCount / decisionCount`. `null` when the
   * window recorded no decisions, never 0 (which would read as "it never falls back").
   */
  semanticRouterFallbackRate: number | null;
  fallbackCount: number;
  /** Distinct `error` strings on the fallback path, desc by count. The "why" behind the rate. */
  fallbackReasons: Array<{ reason: string; count: number }>;
  /** Share of decisions whose confidence cleared its threshold. `null` with no samples. */
  confidenceThresholdPassRate: number | null;
  /** Share of decisions whose margin cleared its threshold. `null` with no samples. */
  marginThresholdPassRate: number | null;
  /**
   * How often the semantic route matched the route the turn ACTUALLY ran. On a live+`semantic`
   * decision these agree by construction (the router decided), so this is informative mainly for
   * shadow decisions and for live fallbacks — which is exactly the shadow-stage comparison
   * B0-649's DoD asks to surface.
   */
  agreementWithRoutingDecision: {
    comparableCount: number;
    agreementCount: number;
    agreementRate: number | null;
  };
};

export type RoutingHealthData = {
  windowFrom: string;
  windowTo: string;
  totalRuns: number;
  /** Desc by count. `'ambiguous'` (a real classifier outcome) and `'unrouted'` (no decision recorded) stay distinct. */
  rows: RoutingHealthRow[];
  agreement: RouterAgreementSummary;
  /** B0-651 — semantic-router rollout metrics. All-zero/null when the router has never run. */
  semanticRouter: SemanticRouterMetrics;
};

/** One `orchestration_planner` step row: the shape `scanWorkflowStepOutputsByName` returns. */
export type RoutingPlannerScanRow = { workflow_run_id: string; output: unknown };

function labelForRoute(route: string): string {
  if (route === AMBIGUOUS_ROUTE) {
    return 'Ambiguous (no specialist)';
  }
  if (route === UNROUTED_ROUTE) {
    return 'No decision recorded';
  }
  // Falls back to the raw value so a route persisted by an older build is still visible.
  return AGENT_LABELS.get(route) ?? route;
}

/** `inputs` is `Record<string, unknown>` by schema, so every read narrows rather than dots into `any`. */
function readString(inputs: Record<string, unknown>, key: string): string | null {
  const value = inputs[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A confidence must be a finite 0..1 number to count; anything else is absent, not zero. */
function readConfidence(inputs: Record<string, unknown>): number | null {
  const value = inputs.classifierConfidence;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    return null;
  }
  return value;
}

/**
 * Live keyword-vs-LLM agreement plus classifier confidence, over the live-gate records on the
 * scanned planner steps.
 *
 * Counted per GATE RECORD, not per run: one record is one classification event, and a run with
 * two planner steps genuinely classified twice. `readStepGateRecords` already degrades an
 * unparseable/absent `output` to `[]`, so a malformed row contributes nothing and never throws.
 */
function buildRouterAgreement(plannerSteps: RoutingPlannerScanRow[]): RouterAgreementSummary {
  let comparableCount = 0;
  let agreementCount = 0;
  let confidenceSum = 0;
  let llmConfidenceSampleSize = 0;
  let lowConfidenceCount = 0;
  let fallbackCount = 0;

  for (const step of plannerSteps) {
    for (const record of readStepGateRecords(step.output)) {
      if (record.gate !== LIVE_CLASSIFIER_GATE_ID) {
        continue;
      }

      const source = readString(record.inputs, 'classifierSource');

      if (source === KEYWORD_FALLBACK_SOURCE) {
        fallbackCount += 1;
        // Degraded routing: no comparison, and its confidence is a fabricated 0. Nothing else to do.
        continue;
      }

      if (source !== LLM_SOURCE) {
        // Unknown/absent source — cannot be attributed, so it is not comparable either way.
        continue;
      }

      if (record.verdict === AGREES_VERDICT || record.verdict === DISAGREES_VERDICT) {
        comparableCount += 1;
        if (record.verdict === AGREES_VERDICT) {
          agreementCount += 1;
        }
      }

      const confidence = readConfidence(record.inputs);
      if (confidence !== null) {
        confidenceSum += confidence;
        llmConfidenceSampleSize += 1;
        if (confidence < LOW_CONFIDENCE_THRESHOLD) {
          lowConfidenceCount += 1;
        }
      }
    }
  }

  return {
    comparableCount,
    agreementCount,
    agreementRate: comparableCount > 0 ? roundTo(agreementCount / comparableCount, 4) : null,
    meanLlmConfidence:
      llmConfidenceSampleSize > 0 ? roundTo(confidenceSum / llmConfidenceSampleSize, 4) : null,
    llmConfidenceSampleSize,
    lowConfidenceCount,
    fallbackCount,
  };
}

/** A metric value must be a finite number to count; anything else is absent, not zero. */
function readFiniteNumber(inputs: Record<string, unknown>, key: string): number | null {
  const value = inputs[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = record[key];
  return typeof value === 'boolean' ? value : null;
}

const EMPTY_DISTRIBUTION: SemanticRouterDistribution = {
  sampleSize: 0,
  mean: null,
  p50: null,
  p95: null,
  p99: null,
  min: null,
  max: null,
};

/**
 * B0-651 — p50/p95/p99 + mean/min/max over one metric's samples.
 *
 * `decimals` because latency (ms) and confidence (0..1) want different precision: rounding a
 * confidence of 0.6234 to 0 decimals would report every decision as "1".
 *
 * Samples are clamped at 0 rather than dropped. A negative latency should be impossible here (the
 * router measures its own wall time from one Node clock, unlike `workflow_steps`, where
 * `started_at` is Postgres `now()` and `completed_at` is the Node clock and fast steps therefore
 * compute negative) — but the clamp costs nothing and the repo's rule is clamp, never filter: a
 * dropped sample silently shrinks the denominator of every percentile beside it.
 */
export function buildSemanticRouterDistribution(
  samples: number[],
  decimals: number,
): SemanticRouterDistribution {
  if (samples.length === 0) {
    return EMPTY_DISTRIBUTION;
  }
  const clamped = samples.map((sample) => Math.max(0, sample));
  const sorted = [...clamped].sort((a, b) => a - b);
  const sum = clamped.reduce((total, sample) => total + sample, 0);

  return {
    sampleSize: sorted.length,
    mean: roundTo(sum / sorted.length, decimals),
    p50: roundTo(percentileNearestRank(sorted, 0.5), decimals),
    p95: roundTo(percentileNearestRank(sorted, 0.95), decimals),
    p99: roundTo(percentileNearestRank(sorted, 0.99), decimals),
    min: roundTo(sorted[0] ?? 0, decimals),
    max: roundTo(sorted[sorted.length - 1] ?? 0, decimals),
  };
}

/** Latency is whole milliseconds; confidence/margin keep 4 decimals like `avgConfidence`. */
const LATENCY_DECIMALS = 0;
const SCORE_DECIMALS = 4;

/**
 * B0-651 — fold every persisted semantic-router gate record in the window into the five metrics the
 * ticket names, plus the fallback reasons and threshold pass-rates that explain them.
 *
 * Counted per GATE RECORD, not per run — same rule as `buildRouterAgreement`: one record is one
 * routing decision. `readStepGateRecords` degrades a malformed `output` to `[]`, so a bad row
 * contributes nothing and never throws.
 */
export function buildSemanticRouterMetrics(
  plannerSteps: RoutingPlannerScanRow[],
): SemanticRouterMetrics {
  const routeCounts = new Map<string, SemanticRouterRouteCount>();
  const fallbackReasonCounts = new Map<string, number>();
  const latency: number[] = [];
  const embedding: number[] = [];
  const scoring: number[] = [];
  const confidence: number[] = [];
  const margin: number[] = [];

  let decisionCount = 0;
  let liveCount = 0;
  let shadowCount = 0;
  let fallbackCount = 0;
  let confidenceThresholdSamples = 0;
  let confidenceThresholdPassed = 0;
  let marginThresholdSamples = 0;
  let marginThresholdPassed = 0;
  let comparableCount = 0;
  let agreementCount = 0;

  for (const step of plannerSteps) {
    for (const record of readStepGateRecords(step.output)) {
      const isLive = record.gate === SEMANTIC_ROUTER_LIVE_GATE_ID;
      const isShadow = record.gate === SEMANTIC_ROUTER_SHADOW_GATE_ID;
      if (!isLive && !isShadow) {
        continue;
      }

      decisionCount += 1;
      if (isLive) {
        liveCount += 1;
      } else {
        shadowCount += 1;
      }

      const route = readString(record.inputs, 'semanticRoute') ?? 'unknown';
      const path = readString(record.inputs, 'semanticPath') ?? 'unknown';
      const key = `${route} ${path}`;
      const existing = routeCounts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        routeCounts.set(key, { route, path, count: 1 });
      }

      if (path === SEMANTIC_PATH_FALLBACK) {
        fallbackCount += 1;
        // `error` is the router's own reason string; a threshold miss carries no error, so the
        // bucket is named rather than dropped — otherwise the reasons would not sum to the rate.
        const reason = readString(record.inputs, 'semanticError') ?? 'thresholds_not_met';
        fallbackReasonCounts.set(reason, (fallbackReasonCounts.get(reason) ?? 0) + 1);
      }

      const latencyMs = readFiniteNumber(record.inputs, 'semanticLatencyMs');
      if (latencyMs !== null) latency.push(latencyMs);
      const embeddingMs = readFiniteNumber(record.inputs, 'semanticEmbeddingMs');
      if (embeddingMs !== null) embedding.push(embeddingMs);
      const scoringMs = readFiniteNumber(record.inputs, 'semanticScoringMs');
      if (scoringMs !== null) scoring.push(scoringMs);

      /**
       * Confidence/margin are only meaningful on the `semantic` path: a `fallback` decision carries
       * whatever the failed attempt happened to leave behind (0 on an embedding error), so counting
       * those would fabricate zeros into both distributions — the same trap `buildRouterAgreement`
       * documents for `keyword_fallback` confidences.
       */
      if (path === SEMANTIC_PATH_SEMANTIC) {
        const confidenceValue = readFiniteNumber(record.inputs, 'semanticConfidence');
        if (confidenceValue !== null) confidence.push(confidenceValue);
        const marginValue = readFiniteNumber(record.inputs, 'semanticMargin');
        if (marginValue !== null) margin.push(marginValue);
      }

      const confidencePassed = readBoolean(record.thresholds, 'confidenceThresholdPassed');
      if (confidencePassed !== null) {
        confidenceThresholdSamples += 1;
        if (confidencePassed) confidenceThresholdPassed += 1;
      }
      const marginPassed = readBoolean(record.thresholds, 'marginThresholdPassed');
      if (marginPassed !== null) {
        marginThresholdSamples += 1;
        if (marginPassed) marginThresholdPassed += 1;
      }

      const actualRoute = readString(record.inputs, 'routingDecision');
      if (actualRoute !== null) {
        comparableCount += 1;
        if (actualRoute === route) agreementCount += 1;
      }
    }
  }

  return {
    decisionCount,
    liveCount,
    shadowCount,
    semanticRouterRoute: [...routeCounts.values()].sort(
      (a, b) => b.count - a.count || a.route.localeCompare(b.route) || a.path.localeCompare(b.path),
    ),
    semanticRouterLatencyMs: buildSemanticRouterDistribution(latency, LATENCY_DECIMALS),
    semanticRouterEmbeddingMs: buildSemanticRouterDistribution(embedding, LATENCY_DECIMALS),
    semanticRouterScoringMs: buildSemanticRouterDistribution(scoring, LATENCY_DECIMALS),
    semanticRouterConfidence: buildSemanticRouterDistribution(confidence, SCORE_DECIMALS),
    semanticRouterMargin: buildSemanticRouterDistribution(margin, SCORE_DECIMALS),
    semanticRouterFallbackRate:
      decisionCount > 0 ? roundTo(fallbackCount / decisionCount, 4) : null,
    fallbackCount,
    fallbackReasons: [...fallbackReasonCounts.entries()]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    confidenceThresholdPassRate:
      confidenceThresholdSamples > 0
        ? roundTo(confidenceThresholdPassed / confidenceThresholdSamples, 4)
        : null,
    marginThresholdPassRate:
      marginThresholdSamples > 0
        ? roundTo(marginThresholdPassed / marginThresholdSamples, 4)
        : null,
    agreementWithRoutingDecision: {
      comparableCount,
      agreementCount,
      agreementRate: comparableCount > 0 ? roundTo(agreementCount / comparableCount, 4) : null,
    },
  };
}

/**
 * Pure reducer — no I/O, so every trap above is unit-testable. Mirrors
 * `buildRoutingDistribution` / `buildPipelineStageStripData`.
 *
 * KNOWN CONTAMINATION (documented, not silently fixed): `final_output.routingDecision` also
 * holds a FORCED `agentMode` when an admin bypasses the router
 * (`run-product-support-workflow.ts`, `runtimeConfig.routedDirectly`). Those runs are not router
 * decisions, but `RunScanRow` — the shared `scanWorkflowRuns` projection, owned by
 * `aggregates.ts` — does not select `final_output.runtimeConfig.routedDirectly`, so this reducer
 * cannot tell them apart from routed runs. Measured on the live DB (2026-08-22): 6 of 2,780 runs
 * in the last 14 days, ~0.2%, so the bar chart is very slightly inflated on the forced route and
 * a handful of live-gate records belong to turns the router did not actually decide. Fix, when it
 * matters: add `routed_directly:final_output->runtimeConfig->>routedDirectly` to `scanWorkflowRuns`
 * and filter here — do not add a second scan for it.
 */
export function buildRoutingHealthData(input: {
  window: AggregateWindow;
  runs: RunScanRow[];
  plannerSteps: RoutingPlannerScanRow[];
}): RoutingHealthData {
  const totalRuns = input.runs.length;

  const rows: RoutingHealthRow[] = buildRoutingDistribution(input.runs)
    .map((datum) => ({
      route: datum.routingDecision,
      label: labelForRoute(datum.routingDecision),
      isAgent: AGENT_IDS.has(datum.routingDecision),
      count: datum.count,
      share: totalRuns > 0 ? roundTo(datum.count / totalRuns, 4) : 0,
      avgConfidence: datum.avgConfidence,
    }))
    .sort((a, b) => b.count - a.count || a.route.localeCompare(b.route));

  return {
    windowFrom: input.window.from,
    windowTo: input.window.to,
    totalRuns,
    rows,
    agreement: buildRouterAgreement(input.plannerSteps),
    // B0-651 — same scan, second fold: the semantic router's gate records live on the very same
    // planner steps, so no extra query is added for them.
    semanticRouter: buildSemanticRouterMetrics(input.plannerSteps),
  };
}

/** Window scan + the one child scan the agreement stats need, then the pure fold above. */
export async function getRoutingHealthData(
  window: AggregateWindow,
  version?: VersionFilter,
): Promise<RoutingHealthData> {
  const runs = await scanWorkflowRuns(window, version);
  const plannerSteps = await scanWorkflowStepOutputsByName(
    window,
    new Set(runs.map((run) => run.id)),
    PLANNER_STEP_NAME,
  );

  return buildRoutingHealthData({ window, runs, plannerSteps });
}
