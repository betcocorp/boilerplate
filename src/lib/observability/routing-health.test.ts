import { describe, expect, it } from 'vitest';

import {
  buildRoutingHealthData,
  buildSemanticRouterDistribution,
  buildSemanticRouterMetrics,
  LOW_CONFIDENCE_THRESHOLD,
  type RoutingPlannerScanRow,
} from '~/lib/observability/routing-health';

import type { AggregateWindow, RunScanRow } from '~/lib/observability/aggregates';

const WINDOW: AggregateWindow = {
  from: '2026-08-15T00:00:00.000Z',
  to: '2026-08-22T00:00:00.000Z',
};

let runSeq = 0;

function run(routingDecision: string | null, confidence: number | null = null): RunScanRow {
  runSeq += 1;
  return {
    id: `run-${runSeq}`,
    status: 'completed',
    confidence,
    created_at: '2026-08-20T12:00:00.000Z',
    updated_at: '2026-08-20T12:00:05.000Z',
    routing_decision: routingDecision,
    ttft_ms: null,
    total_tokens: null,
    prompt_tokens: null,
    cached_prompt_tokens: null,
  };
}

/** One `llm_intent_classifier_live` gate record on a planner step, shaped exactly as the live DB writes it. */
function liveGateStep(options: {
  verdict?: string;
  source?: string | null;
  confidence?: unknown;
  runId?: string;
}): RoutingPlannerScanRow {
  const inputs: Record<string, unknown> = {
    classifiedIntent: 'product',
    keywordRoutingDecision: 'product',
    classifierFallbackReason: null,
    classifierLatencyMs: 1200,
  };
  if (options.source !== null) {
    inputs.classifierSource = options.source ?? 'llm';
  }
  if (options.confidence !== undefined) {
    inputs.classifierConfidence = options.confidence;
  }

  return {
    workflow_run_id: options.runId ?? 'run-1',
    output: {
      gates: [
        {
          gate: 'llm_intent_classifier_live',
          inputs,
          thresholds: { model: 'gpt-4o-mini', timeoutMs: 5000 },
          verdict: options.verdict ?? 'agrees_with_keyword_router',
          effect: 'Routing cutover: the LLM classifier routed this turn to "product".',
        },
      ],
    },
  };
}

describe('buildRoutingHealthData — rows', () => {
  it('keeps ambiguous and unrouted as distinct rows and labels agents from the registry', () => {
    const data = buildRoutingHealthData({
      window: WINDOW,
      runs: [run('product'), run('product'), run('ambiguous'), run(null)],
      plannerSteps: [],
    });

    expect(data.rows).toEqual([
      {
        route: 'product',
        label: 'Betco Product Specialist',
        isAgent: true,
        count: 2,
        share: 0.5,
        avgConfidence: null,
      },
      {
        route: 'ambiguous',
        label: 'Ambiguous (no specialist)',
        isAgent: false,
        count: 1,
        share: 0.25,
        avgConfidence: null,
      },
      {
        route: 'unrouted',
        label: 'No decision recorded',
        isAgent: false,
        count: 1,
        share: 0.25,
        avgConfidence: null,
      },
    ]);
    expect(data.totalRuns).toBe(4);
    expect(data.windowFrom).toBe(WINDOW.from);
    expect(data.windowTo).toBe(WINDOW.to);
  });

  it('sorts rows desc by count and shares sum to ~1', () => {
    const data = buildRoutingHealthData({
      window: WINDOW,
      runs: [
        run('floor'),
        run('product'),
        run('product'),
        run('product'),
        run('dilution'),
        run('floor'),
        run(null),
      ],
      plannerSteps: [],
    });

    expect(data.rows.map((row) => row.route)).toEqual([
      'product',
      'floor',
      'dilution',
      'unrouted',
    ]);
    expect(data.rows.map((row) => row.count)).toEqual([3, 2, 1, 1]);
    expect(data.rows.reduce((sum, row) => sum + row.share, 0)).toBeCloseTo(1, 3);
  });

  it('averages run confidence per route and reports null when no run scored', () => {
    const data = buildRoutingHealthData({
      window: WINDOW,
      runs: [run('product', 0.9), run('product', 0.7), run('floor', null)],
      plannerSteps: [],
    });

    expect(data.rows.find((row) => row.route === 'product')?.avgConfidence).toBe(0.8);
    expect(data.rows.find((row) => row.route === 'floor')?.avgConfidence).toBeNull();
  });

  it('returns no rows and a zeroed agreement summary for an empty window', () => {
    const data = buildRoutingHealthData({ window: WINDOW, runs: [], plannerSteps: [] });

    expect(data.totalRuns).toBe(0);
    expect(data.rows).toEqual([]);
    expect(data.agreement).toEqual({
      comparableCount: 0,
      agreementCount: 0,
      agreementRate: null,
      meanLlmConfidence: null,
      llmConfidenceSampleSize: 0,
      lowConfidenceCount: 0,
      fallbackCount: 0,
    });
  });
});

describe('buildRoutingHealthData — router agreement', () => {
  it('excludes keyword_fallback rows from the mean and the low-confidence count, but counts them as fallbacks', () => {
    // `fallbackClassification` hard-codes confidence 0 whenever the LLM router is disabled,
    // times out or errors. Folding those in would drag the mean toward a number the classifier
    // never produced, and inflate "low confidence" with failures rather than guesses.
    const data = buildRoutingHealthData({
      window: WINDOW,
      runs: [],
      plannerSteps: [
        liveGateStep({ source: 'llm', confidence: 0.8 }),
        liveGateStep({ source: 'keyword_fallback', confidence: 0 }),
        liveGateStep({ source: 'keyword_fallback', confidence: 0 }),
      ],
    });

    expect(data.agreement.meanLlmConfidence).toBe(0.8); // not (0.8 + 0 + 0) / 3
    expect(data.agreement.llmConfidenceSampleSize).toBe(1);
    expect(data.agreement.lowConfidenceCount).toBe(0);
    expect(data.agreement.fallbackCount).toBe(2);
    // A degraded turn is not a comparison either, whatever verdict it carries.
    expect(data.agreement.comparableCount).toBe(1);
  });

  it('computes the agreement rate over llm-sourced records carrying a verdict', () => {
    const data = buildRoutingHealthData({
      window: WINDOW,
      runs: [],
      plannerSteps: [
        liveGateStep({ verdict: 'agrees_with_keyword_router', confidence: 0.85 }),
        liveGateStep({ verdict: 'agrees_with_keyword_router', confidence: 0.8 }),
        liveGateStep({ verdict: 'agrees_with_keyword_router', confidence: 0.7 }),
        liveGateStep({ verdict: 'disagrees_with_keyword_router', confidence: 0.65 }),
      ],
    });

    expect(data.agreement.comparableCount).toBe(4);
    expect(data.agreement.agreementCount).toBe(3);
    expect(data.agreement.agreementRate).toBe(0.75);
    expect(data.agreement.meanLlmConfidence).toBe(0.75);
    expect(data.agreement.llmConfidenceSampleSize).toBe(4);
  });

  it('reports agreementRate null — not 0 — when nothing is comparable', () => {
    const data = buildRoutingHealthData({
      window: WINDOW,
      runs: [run('product')],
      plannerSteps: [
        // Only fallback records: real traffic, but no router comparison in it.
        liveGateStep({ source: 'keyword_fallback', confidence: 0 }),
        // An llm record whose verdict is not one of the two agreement labels.
        liveGateStep({ verdict: 'not_applied', confidence: 0.6 }),
      ],
    });

    expect(data.agreement.comparableCount).toBe(0);
    expect(data.agreement.agreementCount).toBe(0);
    expect(data.agreement.agreementRate).toBeNull();
    // The unknown-verdict record still had a real llm confidence, so it feeds the mean.
    expect(data.agreement.meanLlmConfidence).toBe(0.6);
    expect(data.agreement.fallbackCount).toBe(1);
  });

  it('counts llm confidences below the threshold as low confidence', () => {
    const data = buildRoutingHealthData({
      window: WINDOW,
      runs: [],
      plannerSteps: [
        liveGateStep({ confidence: LOW_CONFIDENCE_THRESHOLD - 0.05 }),
        liveGateStep({ confidence: LOW_CONFIDENCE_THRESHOLD }), // boundary is NOT low
        liveGateStep({ confidence: 0.9 }),
      ],
    });

    expect(data.agreement.lowConfidenceCount).toBe(1);
    expect(data.agreement.llmConfidenceSampleSize).toBe(3);
  });

  it('degrades safely on malformed, absent or out-of-range gate payloads instead of throwing', () => {
    const data = buildRoutingHealthData({
      window: WINDOW,
      runs: [],
      plannerSteps: [
        { workflow_run_id: 'r1', output: null },
        { workflow_run_id: 'r2', output: 'not-an-object' },
        { workflow_run_id: 'r3', output: {} },
        { workflow_run_id: 'r4', output: { gates: 'nope' } },
        // Right gate id, but `inputs` is missing entirely — fails `gateRecordSchema`.
        { workflow_run_id: 'r5', output: { gates: [{ gate: 'llm_intent_classifier_live' }] } },
        // A different gate on the same step must be ignored.
        {
          workflow_run_id: 'r6',
          output: {
            gates: [
              {
                gate: 'keyword_routing',
                inputs: { classifierSource: 'llm', classifierConfidence: 0.1 },
                thresholds: {},
                verdict: 'agrees_with_keyword_router',
                effect: 'n/a',
              },
            ],
          },
        },
        // Live gate, llm source, but confidence is a string / out of range / absent.
        liveGateStep({ confidence: '0.8' }),
        liveGateStep({ confidence: 1.5 }),
        liveGateStep({ confidence: undefined }),
        // Live gate with no `classifierSource` at all — unattributable, so not comparable.
        liveGateStep({ source: null, confidence: 0.9 }),
      ],
    });

    expect(data.agreement).toEqual({
      // The three malformed-confidence live records still carry a valid llm verdict.
      comparableCount: 3,
      agreementCount: 3,
      agreementRate: 1,
      meanLlmConfidence: null,
      llmConfidenceSampleSize: 0,
      lowConfidenceCount: 0,
      fallbackCount: 0,
    });
  });

  it('reads a single `gate` key as well as the `gates` array', () => {
    const data = buildRoutingHealthData({
      window: WINDOW,
      runs: [],
      plannerSteps: [
        {
          workflow_run_id: 'r1',
          output: {
            gate: {
              gate: 'llm_intent_classifier_live',
              inputs: { classifierSource: 'llm', classifierConfidence: 0.5 },
              thresholds: {},
              verdict: 'disagrees_with_keyword_router',
              effect: 'n/a',
            },
          },
        },
      ],
    });

    expect(data.agreement.comparableCount).toBe(1);
    expect(data.agreement.agreementCount).toBe(0);
    expect(data.agreement.agreementRate).toBe(0);
    expect(data.agreement.meanLlmConfidence).toBe(0.5);
  });
});

/* -------------------------------------------------------------------------- *
 * B0-651 — semantic-router metrics (query-time reducers, NOT a metrics exporter)
 * -------------------------------------------------------------------------- */

/** One semantic-router gate record on a planner step, shaped exactly as the workflow writes it. */
function semanticGateStep(options: {
  mode?: 'live' | 'shadow';
  route?: string;
  path?: string;
  confidence?: number;
  margin?: number;
  similarity?: number;
  latencyMs?: number;
  embeddingMs?: number;
  scoringMs?: number;
  confidencePassed?: boolean;
  marginPassed?: boolean;
  error?: string | null;
  routingDecision?: string;
  runId?: string;
}): RoutingPlannerScanRow {
  const mode = options.mode ?? 'live';
  const route = options.route ?? 'product';
  const path = options.path ?? 'semantic';

  return {
    workflow_run_id: options.runId ?? 'run-semantic',
    output: {
      gates: [
        {
          gate: mode === 'live' ? 'semantic_router_live' : 'semantic_router_shadow',
          inputs: {
            semanticRoute: route,
            semanticConfidence: options.confidence ?? 0.7,
            semanticSimilarity: options.similarity ?? 0.7,
            semanticMargin: options.margin ?? 0.2,
            semanticPath: path,
            semanticScores: [{ route, similarity: options.similarity ?? 0.7 }],
            semanticLatencyMs: options.latencyMs ?? 100,
            semanticEmbeddingMs: options.embeddingMs ?? 95,
            semanticScoringMs: options.scoringMs ?? 5,
            semanticEmbeddingModel: 'text-embedding-3-large',
            semanticExamplesVersion: 'v1',
            semanticError: options.error ?? null,
            routingDecision: options.routingDecision ?? route,
            decidedBy: 'semantic_router',
          },
          thresholds: {
            confidenceThreshold: 0.5,
            marginThreshold: 0.1,
            confidenceThresholdPassed: options.confidencePassed ?? true,
            marginThresholdPassed: options.marginPassed ?? true,
            mode,
          },
          verdict: path === 'fallback' ? 'fell_back' : 'agrees_with_routing_decision',
          effect: 'n/a',
        },
      ],
    },
  };
}

describe('buildSemanticRouterDistribution', () => {
  it('returns all-null at zero samples, so "no data" never reads as a measured 0', () => {
    expect(buildSemanticRouterDistribution([], 0)).toEqual({
      sampleSize: 0,
      mean: null,
      p50: null,
      p95: null,
      p99: null,
      min: null,
      max: null,
    });
  });

  it('computes nearest-rank percentiles over unsorted input', () => {
    const stats = buildSemanticRouterDistribution([300, 100, 200, 400, 500], 0);
    expect(stats).toEqual({
      sampleSize: 5,
      mean: 300,
      p50: 300,
      p95: 500,
      p99: 500,
      min: 100,
      max: 500,
    });
  });

  it('clamps a negative sample at 0 instead of dropping it, keeping the denominator honest', () => {
    const stats = buildSemanticRouterDistribution([-5, 10, 20], 0);
    expect(stats.sampleSize).toBe(3);
    expect(stats.min).toBe(0);
    expect(stats.mean).toBe(10);
  });

  it('keeps score precision at 4 decimals', () => {
    const stats = buildSemanticRouterDistribution([0.62341, 0.7], 4);
    expect(stats.mean).toBe(0.6617);
    expect(stats.p50).toBe(0.6234);
  });
});

describe('buildSemanticRouterMetrics', () => {
  it('is empty (and fallbackRate null, not 0) when no semantic decision was recorded', () => {
    const metrics = buildSemanticRouterMetrics([liveGateStep({})]);
    expect(metrics.decisionCount).toBe(0);
    expect(metrics.semanticRouterFallbackRate).toBe(null);
    expect(metrics.semanticRouterRoute).toEqual([]);
    expect(metrics.semanticRouterLatencyMs.sampleSize).toBe(0);
  });

  it('counts routes labeled by path and splits live vs shadow', () => {
    const metrics = buildSemanticRouterMetrics([
      semanticGateStep({ route: 'product' }),
      semanticGateStep({ route: 'product' }),
      semanticGateStep({ route: 'floor' }),
      semanticGateStep({ route: 'ambiguous', path: 'fallback', error: 'embedding_failed' }),
      semanticGateStep({ mode: 'shadow', route: 'bathroom' }),
    ]);

    expect(metrics.decisionCount).toBe(5);
    expect(metrics.liveCount).toBe(4);
    expect(metrics.shadowCount).toBe(1);
    expect(metrics.semanticRouterRoute).toEqual([
      { route: 'product', path: 'semantic', count: 2 },
      { route: 'ambiguous', path: 'fallback', count: 1 },
      { route: 'bathroom', path: 'semantic', count: 1 },
      { route: 'floor', path: 'semantic', count: 1 },
    ]);
  });

  it('derives the fallback rate and names the reasons behind it', () => {
    const metrics = buildSemanticRouterMetrics([
      semanticGateStep({}),
      semanticGateStep({}),
      semanticGateStep({ path: 'fallback', error: 'embedding_request_failed' }),
      // A threshold miss carries no error string; it gets a named bucket rather than being dropped,
      // so the reasons always sum to `fallbackCount`.
      semanticGateStep({ path: 'fallback', error: null, confidencePassed: false }),
    ]);

    expect(metrics.fallbackCount).toBe(2);
    expect(metrics.semanticRouterFallbackRate).toBe(0.5);
    expect(metrics.fallbackReasons).toEqual([
      { reason: 'embedding_request_failed', count: 1 },
      { reason: 'thresholds_not_met', count: 1 },
    ]);
    expect(metrics.confidenceThresholdPassRate).toBe(0.75);
    expect(metrics.marginThresholdPassRate).toBe(1);
  });

  it('reports the honest latency split, never a blended number alone', () => {
    const metrics = buildSemanticRouterMetrics([
      semanticGateStep({ latencyMs: 4, embeddingMs: 0, scoringMs: 4 }),
      semanticGateStep({ latencyMs: 320, embeddingMs: 315, scoringMs: 5 }),
    ]);

    expect(metrics.semanticRouterLatencyMs).toMatchObject({ sampleSize: 2, p50: 4, max: 320 });
    // A warm cache hit legitimately measures 0ms of embedding — a real sample, not missing data.
    expect(metrics.semanticRouterEmbeddingMs).toMatchObject({ sampleSize: 2, min: 0, max: 315 });
    expect(metrics.semanticRouterScoringMs).toMatchObject({ sampleSize: 2, min: 4, max: 5 });
  });

  it('excludes fallback decisions from the confidence/margin distributions', () => {
    const metrics = buildSemanticRouterMetrics([
      semanticGateStep({ confidence: 0.8, margin: 0.3 }),
      // A degraded decision carries a fabricated 0 — counting it would drag both means down.
      semanticGateStep({ path: 'fallback', confidence: 0, margin: 0, error: 'boom' }),
    ]);

    expect(metrics.semanticRouterConfidence).toMatchObject({ sampleSize: 1, mean: 0.8 });
    expect(metrics.semanticRouterMargin).toMatchObject({ sampleSize: 1, mean: 0.3 });
  });

  it('measures agreement against the route the turn actually ran', () => {
    const metrics = buildSemanticRouterMetrics([
      semanticGateStep({ mode: 'shadow', route: 'bathroom', routingDecision: 'bathroom' }),
      semanticGateStep({ mode: 'shadow', route: 'bathroom', routingDecision: 'dilution' }),
    ]);

    expect(metrics.agreementWithRoutingDecision).toEqual({
      comparableCount: 2,
      agreementCount: 1,
      agreementRate: 0.5,
    });
  });

  it('is exposed on buildRoutingHealthData off the same planner scan', () => {
    const data = buildRoutingHealthData({
      window: WINDOW,
      runs: [],
      plannerSteps: [semanticGateStep({ route: 'floor' })],
    });

    expect(data.semanticRouter.decisionCount).toBe(1);
    expect(data.semanticRouter.semanticRouterRoute).toEqual([
      { route: 'floor', path: 'semantic', count: 1 },
    ]);
  });

  it('ignores a malformed planner row instead of throwing', () => {
    const metrics = buildSemanticRouterMetrics([
      { workflow_run_id: 'r', output: { gates: 'not-an-array' } },
      semanticGateStep({}),
    ]);
    expect(metrics.decisionCount).toBe(1);
  });
});
