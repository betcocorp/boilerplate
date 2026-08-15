import { describe, expect, it } from 'vitest';

import {
  buildRoutingComparisonFields,
  computeRoutingComparisonReport,
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
