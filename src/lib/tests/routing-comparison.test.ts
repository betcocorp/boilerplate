import { describe, expect, it } from 'vitest';

import {
  buildConfusionMatrix,
  buildRouterDisagreementMatrix,
  buildRoutingComparisonFields,
  computeAmbiguousRouteRate,
  computeConfidenceDistribution,
  computeRoutingComparisonReport,
  computeRoutingComparisonSummary,
  normalizeKeywordRoute,
  resolveIntendedAgentLabel,
  type RoutingComparisonReportInput,
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
