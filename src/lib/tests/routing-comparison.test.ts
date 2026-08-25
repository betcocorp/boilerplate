import { describe, expect, it } from 'vitest';

import {
  buildConfusionMatrix,
  buildRouterDisagreementMatrix,
  buildRoutingComparisonFields,
  computeAmbiguousRouteRate,
  computeConfidenceDistribution,
  computeLatencyDistribution,
  computeRouterLatencyProfile,
  computeRoutingAgreement,
  computeRoutingComparisonReport,
  computeRoutingComparisonSummary,
  computeSemanticFallbackRate,
  computeSemanticFalsePositiveRate,
  computeSemanticLatencyProfile,
  computeSemanticRoutingAccuracy,
  computeSemanticRoutingAccuracyByRoute,
  computeSemanticRoutingReport,
  computeThreeWayAgreement,
  normalizeKeywordRoute,
  resolveIntendedAgentLabel,
  type RoutingComparisonReportInput,
  type SemanticRoutingItem,
} from './routing-comparison';

describe('normalizeKeywordRoute', () => {
  it('passes through a matched SME agent id', () => {
    expect(normalizeKeywordRoute({ agent: 'floor' })).toBe('floor');
  });

  it('collapses agent: null (no signal / empty message) to "ambiguous"', () => {
    expect(normalizeKeywordRoute({ agent: null })).toBe('ambiguous');
  });
});

describe('resolveIntendedAgentLabel', () => {
  it('prefers the per-item ground truth over the suite-level tag', () => {
    expect(
      resolveIntendedAgentLabel({ itemIntendedAgent: 'bathroom', testIntendedAgent: 'floor' }),
    ).toBe('bathroom');
  });

  it('falls back to the suite-level tag when the item has none', () => {
    expect(resolveIntendedAgentLabel({ itemIntendedAgent: null, testIntendedAgent: 'floor' })).toBe(
      'floor',
    );
    expect(
      resolveIntendedAgentLabel({ itemIntendedAgent: '   ', testIntendedAgent: 'floor' }),
    ).toBe('floor');
  });

  it('returns null when neither is set', () => {
    expect(resolveIntendedAgentLabel({ itemIntendedAgent: null, testIntendedAgent: null })).toBeNull();
    expect(
      resolveIntendedAgentLabel({ itemIntendedAgent: undefined, testIntendedAgent: '  ' }),
    ).toBeNull();
  });
});

describe('buildRoutingComparisonFields', () => {
  it('normalizes the keyword route and passes the LLM classification through', () => {
    const fields = buildRoutingComparisonFields({
      keywordDecision: { agent: 'dilution' },
      llmClassification: { intent: 'product', confidence: 0.82 },
      intendedAgentLabel: 'dilution',
    });

    expect(fields).toEqual({
      keyword_route: 'dilution',
      llm_route: 'product',
      routing_confidence: 0.82,
      intended_agent_label: 'dilution',
      keyword_route_latency_ms: null,
      llm_route_latency_ms: null,
    });
  });

  it('collapses a null keyword agent to "ambiguous"', () => {
    const fields = buildRoutingComparisonFields({
      keywordDecision: { agent: null },
      llmClassification: { intent: 'ambiguous', confidence: 0 },
      intendedAgentLabel: null,
    });

    expect(fields.keyword_route).toBe('ambiguous');
    expect(fields.intended_agent_label).toBeNull();
  });

  it('B0-524 — passes through per-router latency when measured', () => {
    const fields = buildRoutingComparisonFields({
      keywordDecision: { agent: 'floor' },
      llmClassification: { intent: 'floor', confidence: 0.9 },
      intendedAgentLabel: 'floor',
      keywordRouteLatencyMs: 3,
      llmRouteLatencyMs: 412,
    });

    expect(fields.keyword_route_latency_ms).toBe(3);
    expect(fields.llm_route_latency_ms).toBe(412);
  });
});

describe('computeRouterLatencyProfile', () => {
  it('computes median/p95 per router and excludes null samples', () => {
    const profile = computeRouterLatencyProfile([
      { keywordRouteLatencyMs: 1, llmRouteLatencyMs: 100 },
      { keywordRouteLatencyMs: 2, llmRouteLatencyMs: 200 },
      { keywordRouteLatencyMs: 3, llmRouteLatencyMs: null },
      { keywordRouteLatencyMs: null, llmRouteLatencyMs: 400 },
    ]);

    expect(profile.keyword.sampleCount).toBe(3);
    expect(profile.keyword.medianMs).toBe(2);
    expect(profile.llm.sampleCount).toBe(3);
    expect(profile.llm.medianMs).toBe(200);
  });

  it('returns null stats when there are no samples at all', () => {
    const profile = computeRouterLatencyProfile([{ keywordRouteLatencyMs: null, llmRouteLatencyMs: null }]);

    expect(profile.keyword).toEqual({ sampleCount: 0, medianMs: null, p95Ms: null });
    expect(profile.llm).toEqual({ sampleCount: 0, medianMs: null, p95Ms: null });
  });
});

describe('computeRoutingComparisonReport', () => {
  function item(overrides: Partial<RoutingComparisonReportInput>): RoutingComparisonReportInput {
    return {
      resultItemId: 'result-1',
      testItemId: 'item-1',
      rowIndex: 1,
      prompt: 'How do I calibrate the dispenser?',
      intendedAgentLabel: null,
      routingDecision: null,
      keywordRoute: null,
      llmRoute: null,
      ...overrides,
    };
  }

  it('scores each router only over items with a ground-truth label', () => {
    const report = computeRoutingComparisonReport([
      // Both routers correct.
      item({
        resultItemId: 'r1',
        rowIndex: 1,
        intendedAgentLabel: 'dilution',
        routingDecision: 'dilution',
        keywordRoute: 'dilution',
        llmRoute: 'dilution',
      }),
      // Keyword wrong, LLM correct.
      item({
        resultItemId: 'r2',
        rowIndex: 2,
        intendedAgentLabel: 'bathroom',
        routingDecision: 'product',
        keywordRoute: 'product',
        llmRoute: 'bathroom',
      }),
      // No ground truth — contributes to agreement only, not accuracy.
      item({
        resultItemId: 'r3',
        rowIndex: 3,
        intendedAgentLabel: null,
        routingDecision: 'floor',
        keywordRoute: 'floor',
        llmRoute: 'floor',
      }),
    ]);

    expect(report.scoredItemCount).toBe(2);
    expect(report.keywordMatchedCount).toBe(1);
    expect(report.llmMatchedCount).toBe(2);
    expect(report.actualMatchedCount).toBe(1);
    expect(report.keywordAccuracy).toBeCloseTo(0.5);
    expect(report.llmAccuracy).toBeCloseTo(1);
    expect(report.actualAccuracy).toBeCloseTo(0.5);
  });

  it('lists a scored item as a mismatch when either router misses ground truth', () => {
    const report = computeRoutingComparisonReport([
      item({
        resultItemId: 'r2',
        rowIndex: 2,
        prompt: 'What is the dilution for AF315?',
        intendedAgentLabel: 'bathroom',
        routingDecision: 'product',
        keywordRoute: 'product',
        llmRoute: 'bathroom',
      }),
    ]);

    expect(report.mismatches).toEqual([
      {
        resultItemId: 'r2',
        testItemId: 'item-1',
        rowIndex: 2,
        prompt: 'What is the dilution for AF315?',
        intendedAgentLabel: 'bathroom',
        keywordRoute: 'product',
        llmRoute: 'bathroom',
        routingDecision: 'product',
      },
    ]);
  });

  it('computes agreement rate across every item with both routes present, scored or not', () => {
    const report = computeRoutingComparisonReport([
      item({ resultItemId: 'r1', keywordRoute: 'floor', llmRoute: 'floor' }),
      item({ resultItemId: 'r2', keywordRoute: 'floor', llmRoute: 'product' }),
      item({ resultItemId: 'r3', keywordRoute: null, llmRoute: 'product' }),
    ]);

    expect(report.agreementCount).toBe(1);
    expect(report.agreementRate).toBeCloseTo(0.5);
  });

  it('returns null accuracy/agreement when nothing in the run qualifies', () => {
    const report = computeRoutingComparisonReport([item({ resultItemId: 'r1' })]);
    expect(report.scoredItemCount).toBe(0);
    expect(report.keywordAccuracy).toBeNull();
    expect(report.llmAccuracy).toBeNull();
    expect(report.actualAccuracy).toBeNull();
    expect(report.agreementRate).toBeNull();
    expect(report.mismatches).toEqual([]);
  });

  it('sorts mismatches by row_index', () => {
    const report = computeRoutingComparisonReport([
      item({ resultItemId: 'r2', rowIndex: 5, intendedAgentLabel: 'floor', keywordRoute: 'product', llmRoute: 'product' }),
      item({ resultItemId: 'r1', rowIndex: 2, intendedAgentLabel: 'bathroom', keywordRoute: 'product', llmRoute: 'product' }),
    ]);
    expect(report.mismatches.map((m) => m.rowIndex)).toEqual([2, 5]);
  });
});

// B0-502 — RoutingAccuracyBoard reducers.

describe('buildConfusionMatrix', () => {
  const items = [
    { intendedAgentLabel: 'floor', keywordRoute: 'floor', llmRoute: 'floor' },
    { intendedAgentLabel: 'floor', keywordRoute: 'product', llmRoute: 'floor' },
    { intendedAgentLabel: 'bathroom', keywordRoute: 'bathroom', llmRoute: 'bathroom' },
    // No ground truth — excluded from both matrices.
    { intendedAgentLabel: null, keywordRoute: 'dilution', llmRoute: 'dilution' },
  ];

  it('builds ground-truth-rows x predicted-columns counts for the keyword router', () => {
    const matrix = buildConfusionMatrix(items, 'keyword');
    expect(matrix.groundTruthLabels).toEqual(['bathroom', 'floor']);
    expect(matrix.predictedLabels).toEqual(['bathroom', 'floor', 'product']);
    expect(matrix.counts.floor.floor).toBe(1);
    expect(matrix.counts.floor.product).toBe(1);
    expect(matrix.counts.bathroom.bathroom).toBe(1);
    expect(matrix.totalCount).toBe(3);
  });

  it('builds a separate matrix for the LLM router (perfect here)', () => {
    const matrix = buildConfusionMatrix(items, 'llm');
    expect(matrix.predictedLabels).toEqual(['bathroom', 'floor']);
    expect(matrix.counts.floor.floor).toBe(2);
    expect(matrix.counts.bathroom.bathroom).toBe(1);
    expect(matrix.totalCount).toBe(3);
  });

  it('returns an empty matrix when nothing has ground truth', () => {
    const matrix = buildConfusionMatrix(
      [{ intendedAgentLabel: null, keywordRoute: 'floor', llmRoute: 'floor' }],
      'keyword',
    );
    expect(matrix.groundTruthLabels).toEqual([]);
    expect(matrix.totalCount).toBe(0);
  });
});

describe('computeAmbiguousRouteRate', () => {
  it('rates keyword and llm ambiguous outcomes independently', () => {
    const report = computeAmbiguousRouteRate([
      { keywordRoute: 'ambiguous', llmRoute: 'floor' },
      { keywordRoute: 'floor', llmRoute: 'ambiguous' },
      { keywordRoute: 'floor', llmRoute: 'floor' },
      { keywordRoute: null, llmRoute: null },
    ]);
    expect(report.keywordPresentCount).toBe(3);
    expect(report.llmPresentCount).toBe(3);
    expect(report.keywordAmbiguousCount).toBe(1);
    expect(report.llmAmbiguousCount).toBe(1);
    expect(report.keywordAmbiguousRate).toBeCloseTo(1 / 3);
    expect(report.llmAmbiguousRate).toBeCloseTo(1 / 3);
  });

  it('returns null rates when a router never reported at all', () => {
    const report = computeAmbiguousRouteRate([{ keywordRoute: null, llmRoute: null }]);
    expect(report.keywordAmbiguousRate).toBeNull();
    expect(report.llmAmbiguousRate).toBeNull();
  });
});

describe('computeConfidenceDistribution', () => {
  it('buckets confidence values into 5 fixed 0.2-wide bins (lower-inclusive, last bin also holds 1.0)', () => {
    // 0, 0.19 -> [0.0-0.2); 0.2 -> [0.2-0.4); 0.55 -> [0.4-0.6); 0.8, 1 -> [0.8-1.0].
    const distribution = computeConfidenceDistribution([0, 0.19, 0.2, 0.55, 0.8, 1]);
    expect(distribution.buckets.map((b) => b.count)).toEqual([2, 1, 1, 0, 2]);
    expect(distribution.missingCount).toBe(0);
    expect(distribution.totalCount).toBe(6);
  });

  it('counts null/undefined/non-finite values as missing, not zero-confidence', () => {
    const distribution = computeConfidenceDistribution([null, undefined, NaN, 0.5]);
    expect(distribution.missingCount).toBe(3);
    expect(distribution.buckets.reduce((sum, b) => sum + b.count, 0)).toBe(1);
  });

  it('clamps out-of-range values instead of throwing', () => {
    const distribution = computeConfidenceDistribution([-0.5, 1.5]);
    expect(distribution.buckets[0].count).toBe(1);
    expect(distribution.buckets[distribution.buckets.length - 1].count).toBe(1);
  });

  it('returns all-zero buckets for an empty input', () => {
    const distribution = computeConfidenceDistribution([]);
    expect(distribution.buckets.every((b) => b.count === 0)).toBe(true);
    expect(distribution.totalCount).toBe(0);
  });
});

// B0-509 — RoutingComparisonDashboard reducers.

describe('buildRouterDisagreementMatrix', () => {
  it('counts keyword-vs-llm pairings and the disagreement rate', () => {
    const matrix = buildRouterDisagreementMatrix([
      { keywordRoute: 'floor', llmRoute: 'floor' },
      { keywordRoute: 'floor', llmRoute: 'product' },
      { keywordRoute: 'bathroom', llmRoute: 'bathroom' },
      { keywordRoute: null, llmRoute: 'floor' },
    ]);
    expect(matrix.keywordLabels).toEqual(['bathroom', 'floor']);
    expect(matrix.llmLabels).toEqual(['bathroom', 'floor', 'product']);
    expect(matrix.counts.floor.floor).toBe(1);
    expect(matrix.counts.floor.product).toBe(1);
    expect(matrix.comparableCount).toBe(3);
    expect(matrix.disagreementCount).toBe(1);
    expect(matrix.disagreementRate).toBeCloseTo(1 / 3);
  });

  it('returns null disagreement rate when nothing is comparable', () => {
    const matrix = buildRouterDisagreementMatrix([{ keywordRoute: null, llmRoute: 'floor' }]);
    expect(matrix.comparableCount).toBe(0);
    expect(matrix.disagreementRate).toBeNull();
  });
});

describe('computeRoutingComparisonSummary', () => {
  it('computes cutover-readiness stats across cross-run rows', () => {
    const summary = computeRoutingComparisonSummary([
      { intendedAgentLabel: 'floor', routingDecision: 'floor', keywordRoute: 'floor', llmRoute: 'floor' },
      {
        intendedAgentLabel: 'bathroom',
        routingDecision: 'product',
        keywordRoute: 'product',
        llmRoute: 'bathroom',
      },
      { intendedAgentLabel: null, routingDecision: 'floor', keywordRoute: 'floor', llmRoute: 'floor' },
    ]);
    expect(summary.scoredItemCount).toBe(2);
    expect(summary.keywordAccuracy).toBeCloseTo(0.5);
    expect(summary.llmAccuracy).toBeCloseTo(1);
    expect(summary.actualAccuracy).toBeCloseTo(0.5);
    expect(summary.comparableCount).toBe(3);
    expect(summary.agreementRate).toBeCloseTo(2 / 3);
  });

  it('returns nulls when there is nothing to score or compare', () => {
    const summary = computeRoutingComparisonSummary([]);
    expect(summary.scoredItemCount).toBe(0);
    expect(summary.keywordAccuracy).toBeNull();
    expect(summary.llmAccuracy).toBeNull();
    expect(summary.actualAccuracy).toBeNull();
    expect(summary.agreementRate).toBeNull();
  });
});

// B0-652 — semantic-router (third router) instrumentation and reducers.

describe('buildRoutingComparisonFields — semantic decision (B0-652)', () => {
  it('omits the semantic columns entirely when no semantic decision is passed', () => {
    const fields = buildRoutingComparisonFields({
      keywordDecision: { agent: 'floor' },
      llmClassification: { intent: 'floor', confidence: 0.9 },
      intendedAgentLabel: 'floor',
    });

    expect('semantic_route' in fields).toBe(false);
    expect('routing_agreement' in fields).toBe(false);
  });

  it('maps a semantic decision onto the semantic_* columns and derives routing_agreement', () => {
    const fields = buildRoutingComparisonFields({
      keywordDecision: { agent: 'floor' },
      llmClassification: { intent: 'floor', confidence: 0.9 },
      intendedAgentLabel: 'floor',
      keywordRouteLatencyMs: 2,
      llmRouteLatencyMs: 300,
      semanticDecision: {
        route: 'floor',
        confidence: 0.71,
        margin: 0.12,
        path: 'semantic',
        latencyMs: 180,
        embeddingMs: 176,
        scoringMs: 4,
      },
    });

    expect(fields.semantic_route).toBe('floor');
    expect(fields.semantic_confidence).toBe(0.71);
    expect(fields.semantic_margin).toBe(0.12);
    expect(fields.semantic_path).toBe('semantic');
    expect(fields.semantic_route_latency_ms).toBe(180);
    expect(fields.semantic_embedding_ms).toBe(176);
    expect(fields.semantic_scoring_ms).toBe(4);
    expect(fields.routing_agreement).toBe('all_agree');
  });

  it('records nulls (not zeros) for latency components the decision did not report', () => {
    const fields = buildRoutingComparisonFields({
      keywordDecision: { agent: null },
      llmClassification: { intent: 'ambiguous', confidence: 0 },
      intendedAgentLabel: null,
      semanticDecision: { route: 'ambiguous', confidence: 0.2, margin: 0.01, path: 'fallback' },
    });

    expect(fields.semantic_route_latency_ms).toBeNull();
    expect(fields.semantic_embedding_ms).toBeNull();
    expect(fields.semantic_scoring_ms).toBeNull();
  });
});

describe('computeRoutingAgreement', () => {
  it('reports all_agree when all three routers match', () => {
    expect(
      computeRoutingAgreement({ keywordRoute: 'floor', llmRoute: 'floor', semanticRoute: 'floor' }),
    ).toBe('all_agree');
  });

  it('names the agreeing pair when the third differs', () => {
    expect(
      computeRoutingAgreement({ keywordRoute: 'floor', llmRoute: 'floor', semanticRoute: 'product' }),
    ).toBe('keyword_llm');
    expect(
      computeRoutingAgreement({ keywordRoute: 'floor', llmRoute: 'product', semanticRoute: 'floor' }),
    ).toBe('keyword_semantic');
    expect(
      computeRoutingAgreement({ keywordRoute: 'product', llmRoute: 'floor', semanticRoute: 'floor' }),
    ).toBe('llm_semantic');
  });

  it('reports all_differ only when three present routes are mutually distinct', () => {
    expect(
      computeRoutingAgreement({ keywordRoute: 'floor', llmRoute: 'product', semanticRoute: 'bathroom' }),
    ).toBe('all_differ');
  });

  it('treats two present, matching routes as agreement and two differing as all_differ', () => {
    expect(
      computeRoutingAgreement({ keywordRoute: 'floor', llmRoute: null, semanticRoute: 'floor' }),
    ).toBe('all_agree');
    expect(
      computeRoutingAgreement({ keywordRoute: 'floor', llmRoute: null, semanticRoute: 'product' }),
    ).toBe('all_differ');
  });

  it('returns null when fewer than two routes are present (nothing to compare)', () => {
    expect(
      computeRoutingAgreement({ keywordRoute: 'floor', llmRoute: null, semanticRoute: undefined }),
    ).toBeNull();
    expect(
      computeRoutingAgreement({ keywordRoute: null, llmRoute: null, semanticRoute: null }),
    ).toBeNull();
  });
});

describe('computeRoutingComparisonReport — semantic route (B0-652)', () => {
  function item(overrides: Partial<RoutingComparisonReportInput>): RoutingComparisonReportInput {
    return {
      resultItemId: 'r1',
      testItemId: 'item-1',
      rowIndex: 1,
      prompt: 'p',
      intendedAgentLabel: null,
      routingDecision: null,
      keywordRoute: null,
      llmRoute: null,
      ...overrides,
    };
  }

  it('scores the semantic router over its own denominator', () => {
    const report = computeRoutingComparisonReport([
      item({ intendedAgentLabel: 'floor', keywordRoute: 'floor', llmRoute: 'floor', semanticRoute: 'floor' }),
      item({
        rowIndex: 2,
        intendedAgentLabel: 'bathroom',
        keywordRoute: 'bathroom',
        llmRoute: 'bathroom',
        semanticRoute: 'product',
      }),
      // Scored for keyword/llm but never semantically instrumented.
      item({ rowIndex: 3, intendedAgentLabel: 'floor', keywordRoute: 'floor', llmRoute: 'floor' }),
    ]);

    expect(report.scoredItemCount).toBe(3);
    expect(report.semanticScoredItemCount).toBe(2);
    expect(report.semanticMatchedCount).toBe(1);
    expect(report.semanticAccuracy).toBeCloseTo(0.5);
    expect(report.keywordAccuracy).toBeCloseTo(1);
  });

  it('adds an item to mismatches when only the semantic router missed', () => {
    const report = computeRoutingComparisonReport([
      item({
        intendedAgentLabel: 'floor',
        routingDecision: 'floor',
        keywordRoute: 'floor',
        llmRoute: 'floor',
        semanticRoute: 'product',
      }),
    ]);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0].semanticRoute).toBe('product');
  });

  it('leaves semanticAccuracy null when no item carries a semantic route', () => {
    const report = computeRoutingComparisonReport([
      item({ intendedAgentLabel: 'floor', keywordRoute: 'floor', llmRoute: 'floor' }),
    ]);
    expect(report.semanticScoredItemCount).toBe(0);
    expect(report.semanticAccuracy).toBeNull();
  });
});

describe('buildConfusionMatrix — semantic router key (B0-652)', () => {
  it('builds a matrix from semanticRoute when asked for the semantic router', () => {
    const matrix = buildConfusionMatrix(
      [
        { intendedAgentLabel: 'floor', keywordRoute: 'product', llmRoute: 'product', semanticRoute: 'floor' },
        { intendedAgentLabel: 'floor', keywordRoute: 'floor', llmRoute: 'floor', semanticRoute: 'product' },
        // No semantic instrumentation — excluded from the semantic matrix only.
        { intendedAgentLabel: 'floor', keywordRoute: 'floor', llmRoute: 'floor' },
      ],
      'semantic',
    );
    expect(matrix.totalCount).toBe(2);
    expect(matrix.counts.floor.floor).toBe(1);
    expect(matrix.counts.floor.product).toBe(1);
  });
});

describe('computeSemanticRoutingAccuracy (strict vs plausible_agents-lenient)', () => {
  const items: SemanticRoutingItem[] = [
    // Exactly right.
    { intendedAgentLabel: 'floor', plausibleAgentLabels: ['floor'], semanticRoute: 'floor' },
    // Near miss the golden set deliberately allows.
    {
      intendedAgentLabel: 'bathroom',
      plausibleAgentLabels: ['bathroom', 'product'],
      semanticRoute: 'product',
    },
    // Wrong under both modes.
    { intendedAgentLabel: 'dilution', plausibleAgentLabels: ['dilution'], semanticRoute: 'floor' },
    // Unlabeled — excluded entirely.
    { intendedAgentLabel: null, plausibleAgentLabels: ['floor'], semanticRoute: 'floor' },
    // Labeled but the router never reported — excluded, not counted wrong.
    { intendedAgentLabel: 'floor', plausibleAgentLabels: ['floor'], semanticRoute: null },
  ];

  it('scores strict and lenient over the same denominator', () => {
    const accuracy = computeSemanticRoutingAccuracy(items);
    expect(accuracy.scoredItemCount).toBe(3);
    expect(accuracy.strictMatchedCount).toBe(1);
    expect(accuracy.lenientMatchedCount).toBe(2);
    expect(accuracy.strictAccuracy).toBeCloseTo(1 / 3);
    expect(accuracy.lenientAccuracy).toBeCloseTo(2 / 3);
  });

  it('falls back to the strict test when an item carries no plausible list', () => {
    const accuracy = computeSemanticRoutingAccuracy([
      { intendedAgentLabel: 'floor', semanticRoute: 'product' },
      { intendedAgentLabel: 'floor', plausibleAgentLabels: [], semanticRoute: 'product' },
    ]);
    expect(accuracy.lenientMatchedCount).toBe(0);
    expect(accuracy.lenientAccuracy).toBe(0);
  });

  it('returns null accuracies when nothing is scorable', () => {
    const accuracy = computeSemanticRoutingAccuracy([
      { intendedAgentLabel: null, semanticRoute: 'floor' },
    ]);
    expect(accuracy.scoredItemCount).toBe(0);
    expect(accuracy.strictAccuracy).toBeNull();
    expect(accuracy.lenientAccuracy).toBeNull();
  });
});

describe('computeSemanticRoutingAccuracyByRoute', () => {
  it('groups by ground truth, sorted, omitting routes with no scorable items', () => {
    const byRoute = computeSemanticRoutingAccuracyByRoute([
      { intendedAgentLabel: 'floor', semanticRoute: 'floor' },
      { intendedAgentLabel: 'floor', semanticRoute: 'product' },
      { intendedAgentLabel: 'bathroom', plausibleAgentLabels: ['bathroom', 'product'], semanticRoute: 'product' },
      { intendedAgentLabel: 'dilution', semanticRoute: null },
    ]);

    expect(byRoute.map((r) => r.groundTruthLabel)).toEqual(['bathroom', 'floor']);
    expect(byRoute[0].strictAccuracy).toBe(0);
    expect(byRoute[0].lenientAccuracy).toBe(1);
    expect(byRoute[1].itemCount).toBe(2);
    expect(byRoute[1].strictAccuracy).toBeCloseTo(0.5);
  });
});

describe('computeSemanticFalsePositiveRate', () => {
  it('counts only confident (path=semantic) wrong routes, over the confident denominator', () => {
    const report = computeSemanticFalsePositiveRate([
      // Confident and right.
      { intendedAgentLabel: 'floor', semanticRoute: 'floor', semanticPath: 'semantic' },
      // Confident and WRONG — the false positive.
      { intendedAgentLabel: 'bathroom', semanticRoute: 'product', semanticPath: 'semantic' },
      // Wrong but the router already said it wasn't sure — not a false positive.
      { intendedAgentLabel: 'dilution', semanticRoute: 'ambiguous', semanticPath: 'fallback' },
      // Unlabeled — out of scope.
      { intendedAgentLabel: null, semanticRoute: 'product', semanticPath: 'semantic' },
    ]);

    expect(report.confidentItemCount).toBe(2);
    expect(report.falsePositiveCount).toBe(1);
    expect(report.falsePositiveRate).toBeCloseTo(0.5);
    expect(report.scoredItemCount).toBe(3);
    expect(report.falsePositiveRateOfScored).toBeCloseTo(1 / 3);
  });

  it('returns null rates when nothing was measurable', () => {
    const report = computeSemanticFalsePositiveRate([
      { intendedAgentLabel: 'floor', semanticRoute: 'floor' },
    ]);
    expect(report.falsePositiveRate).toBeNull();
    expect(report.falsePositiveRateOfScored).toBeNull();
  });
});

describe('computeSemanticFallbackRate', () => {
  it('rates fallbacks over every item with a path, labeled or not', () => {
    const report = computeSemanticFallbackRate([
      { intendedAgentLabel: 'floor', semanticRoute: 'floor', semanticPath: 'semantic' },
      { intendedAgentLabel: null, semanticRoute: 'ambiguous', semanticPath: 'fallback' },
      { intendedAgentLabel: 'floor', semanticRoute: 'ambiguous', semanticPath: 'fallback' },
      { intendedAgentLabel: 'floor', semanticRoute: null },
    ]);
    expect(report.pathPresentCount).toBe(3);
    expect(report.fallbackCount).toBe(2);
    expect(report.fallbackRate).toBeCloseTo(2 / 3);
  });

  it('returns a null rate when the router was never consulted', () => {
    expect(
      computeSemanticFallbackRate([{ intendedAgentLabel: 'floor', semanticRoute: null }]).fallbackRate,
    ).toBeNull();
  });
});

describe('computeLatencyDistribution / computeSemanticLatencyProfile', () => {
  it('reports p50/p95/p99 plus min/max, excluding non-finite samples', () => {
    const distribution = computeLatencyDistribution([5, 1, 3, 2, 4]);
    expect(distribution.sampleCount).toBe(5);
    expect(distribution.p50Ms).toBe(3);
    expect(distribution.p95Ms).toBe(5);
    expect(distribution.p99Ms).toBe(5);
    expect(distribution.minMs).toBe(1);
    expect(distribution.maxMs).toBe(5);
  });

  it('returns all-null stats for an empty sample set', () => {
    expect(computeLatencyDistribution([])).toEqual({
      sampleCount: 0,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      minMs: null,
      maxMs: null,
    });
  });

  it('splits total/embedding/scoring so a cold embedding cannot be mistaken for scoring cost', () => {
    const profile = computeSemanticLatencyProfile([
      {
        intendedAgentLabel: 'floor',
        semanticRoute: 'floor',
        semanticRouteLatencyMs: 200,
        semanticEmbeddingMs: 196,
        semanticScoringMs: 4,
      },
      {
        intendedAgentLabel: 'floor',
        semanticRoute: 'floor',
        semanticRouteLatencyMs: 6,
        semanticEmbeddingMs: 0,
        semanticScoringMs: 6,
      },
      // Not measured — must not be counted as 0ms.
      { intendedAgentLabel: 'floor', semanticRoute: 'floor' },
    ]);

    expect(profile.total.sampleCount).toBe(2);
    expect(profile.scoring.sampleCount).toBe(2);
    expect(profile.scoring.p95Ms).toBe(6);
    expect(profile.embedding.maxMs).toBe(196);
  });
});

describe('computeThreeWayAgreement', () => {
  it('counts every agreement label and the all-agree rate over comparable items', () => {
    const report = computeThreeWayAgreement([
      { keywordRoute: 'floor', llmRoute: 'floor', semanticRoute: 'floor' },
      { keywordRoute: 'floor', llmRoute: 'floor', semanticRoute: 'product' },
      { keywordRoute: 'floor', llmRoute: 'product', semanticRoute: 'bathroom' },
      // Only one route present — excluded, not a disagreement.
      { keywordRoute: 'floor', llmRoute: null, semanticRoute: null },
    ]);

    expect(report.comparableCount).toBe(3);
    expect(report.counts.all_agree).toBe(1);
    expect(report.counts.keyword_llm).toBe(1);
    expect(report.counts.all_differ).toBe(1);
    expect(report.allAgreeRate).toBeCloseTo(1 / 3);
  });

  it('returns a null rate when nothing is comparable', () => {
    const report = computeThreeWayAgreement([
      { keywordRoute: null, llmRoute: null, semanticRoute: 'floor' },
    ]);
    expect(report.comparableCount).toBe(0);
    expect(report.allAgreeRate).toBeNull();
  });
});

describe('computeSemanticRoutingReport', () => {
  it('bundles accuracy, per-route accuracy, false positives, fallback and latency', () => {
    const report = computeSemanticRoutingReport([
      {
        intendedAgentLabel: 'floor',
        plausibleAgentLabels: ['floor'],
        semanticRoute: 'floor',
        semanticPath: 'semantic',
        semanticScoringMs: 3,
      },
      {
        intendedAgentLabel: 'bathroom',
        plausibleAgentLabels: ['bathroom', 'product'],
        semanticRoute: 'product',
        semanticPath: 'semantic',
        semanticScoringMs: 5,
      },
    ]);

    expect(report.accuracy.strictAccuracy).toBeCloseTo(0.5);
    expect(report.accuracy.lenientAccuracy).toBeCloseTo(1);
    expect(report.accuracyByRoute).toHaveLength(2);
    expect(report.falsePositives.falsePositiveRate).toBeCloseTo(0.5);
    expect(report.fallback.fallbackRate).toBe(0);
    expect(report.latency.scoring.p95Ms).toBe(5);
  });
});
