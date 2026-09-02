import { describe, expect, it } from 'vitest';

import {
  computeSignalAccuracyReport,
  extractExpectedGroundTruthString,
  extractProductMentionFromInputPayload,
  parseSignalsAnalysisGate,
  type SignalAccuracyItemInput,
} from './signal-accuracy';

function baseSignals(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'product',
    confidence: 0.9,
    betcoProduct: null,
    competitorBrand: null,
    competitorProduct: null,
    surfaceType: null,
    taskDescription: null,
    brandFamily: null,
    setting: null,
    productCategory: null,
    carriedProduct: null,
    suggestedTool: null,
    otherCompetitorProduct: null,
    crossReferenceIntent: false,
    competitorIsGenericChemistry: false,
    isConversionListAsk: false,
    answerShape: 'single_value',
    declineClass: null,
    regulatedSectionIntent: false,
    source: 'llm',
    fallbackReason: null,
    usage: null,
    model: null,
    resolvedProductLineKey: null,
    resolutionSource: null,
    selfReferenceVerdict: null,
    ...overrides,
  };
}

describe('extractExpectedGroundTruthString', () => {
  it('trims a non-blank string', () => {
    expect(extractExpectedGroundTruthString('  tile floor  ')).toBe('tile floor');
  });

  it('returns null for missing, blank, or non-string values', () => {
    expect(extractExpectedGroundTruthString('   ')).toBeNull();
    expect(extractExpectedGroundTruthString(null)).toBeNull();
    expect(extractExpectedGroundTruthString(undefined)).toBeNull();
    expect(extractExpectedGroundTruthString(42)).toBeNull();
  });
});

describe('extractProductMentionFromInputPayload', () => {
  it('reads input_payload.product_mention, trimmed', () => {
    expect(extractProductMentionFromInputPayload({ product_mention: '  pH7Q  ' })).toBe('pH7Q');
  });

  it('returns null when absent or the payload is malformed', () => {
    expect(extractProductMentionFromInputPayload({})).toBeNull();
    expect(extractProductMentionFromInputPayload(null)).toBeNull();
    expect(extractProductMentionFromInputPayload('not an object')).toBeNull();
    expect(extractProductMentionFromInputPayload([])).toBeNull();
  });
});

describe('parseSignalsAnalysisGate', () => {
  it('parses a well-formed signals_analysis gate off the orchestration_planner step output', () => {
    const output = {
      gates: [
        { gate: 'keyword_routing', inputs: {}, thresholds: {}, verdict: 'x', effect: 'y' },
        {
          gate: 'signals_analysis',
          inputs: { signals: baseSignals({ surfaceType: 'tile', brandFamily: 'betco' }) },
          thresholds: {},
          verdict: 'signals_analyzed',
          effect: 'x',
        },
      ],
    };
    const parsed = parseSignalsAnalysisGate(output);
    expect(parsed?.surfaceType).toBe('tile');
    expect(parsed?.brandFamily).toBe('betco');
  });

  it('returns null when there is no gates array, no signals_analysis entry, or the shape is malformed', () => {
    expect(parseSignalsAnalysisGate({ routing: {} })).toBeNull();
    expect(parseSignalsAnalysisGate(null)).toBeNull();
    expect(parseSignalsAnalysisGate('not an object')).toBeNull();
    expect(
      parseSignalsAnalysisGate({
        gates: [{ gate: 'keyword_routing', inputs: {}, thresholds: {}, verdict: 'x', effect: 'y' }],
      }),
    ).toBeNull();
  });

  it('returns null when inputs.signals fails schema validation', () => {
    const output = {
      gates: [
        {
          gate: 'signals_analysis',
          inputs: { signals: { intent: 'product_info' } }, // missing required fields
          thresholds: {},
          verdict: 'signals_analyzed',
          effect: 'x',
        },
      ],
    };
    expect(parseSignalsAnalysisGate(output)).toBeNull();
  });
});

describe('computeSignalAccuracyReport', () => {
  function item(overrides: Partial<SignalAccuracyItemInput>): SignalAccuracyItemInput {
    return {
      testItemId: 'item-1',
      rowIndex: 1,
      prompt: 'What surface is pH7Q used on?',
      expectedProductMention: null,
      expectedSurfaceType: null,
      expectedBrandFamily: null,
      expectedSetting: null,
      signals: null,
      ...overrides,
    };
  }

  it('scores an exact surfaceType match', () => {
    const report = computeSignalAccuracyReport([
      item({
        expectedSurfaceType: 'tile',
        signals: {
          betcoProduct: null,
          resolvedProductLineKey: null,
          surfaceType: 'tile',
          brandFamily: null,
          setting: null,
        },
      }),
    ]);
    expect(report.signals.surfaceType.scoredItemCount).toBe(1);
    expect(report.signals.surfaceType.matchedItemCount).toBe(1);
    expect(report.signals.surfaceType.precision).toBe(1);
    expect(report.signals.surfaceType.recall).toBe(1);
    expect(report.signals.surfaceType.mismatches).toEqual([]);
  });

  it('is case-insensitive for surfaceType/brandFamily/setting', () => {
    const report = computeSignalAccuracyReport([
      item({
        expectedBrandFamily: 'Betco',
        signals: {
          betcoProduct: null,
          resolvedProductLineKey: null,
          surfaceType: null,
          brandFamily: 'betco',
          setting: null,
        },
      }),
    ]);
    expect(report.signals.brandFamily.matchedItemCount).toBe(1);
  });

  it('records a mismatch when the extracted value disagrees with ground truth', () => {
    const report = computeSignalAccuracyReport([
      item({
        rowIndex: 5,
        expectedSetting: 'commercial',
        signals: {
          betcoProduct: null,
          resolvedProductLineKey: null,
          surfaceType: null,
          brandFamily: null,
          setting: 'residential',
        },
      }),
    ]);
    expect(report.signals.setting.scoredItemCount).toBe(1);
    expect(report.signals.setting.matchedItemCount).toBe(0);
    expect(report.signals.setting.precision).toBe(0);
    expect(report.signals.setting.recall).toBe(0);
    expect(report.signals.setting.mismatches).toEqual([
      {
        testItemId: 'item-1',
        rowIndex: 5,
        prompt: 'What surface is pH7Q used on?',
        expected: 'commercial',
        actual: 'residential',
      },
    ]);
  });

  it('excludes items with null ground truth from scoring entirely', () => {
    const report = computeSignalAccuracyReport([
      item({
        expectedSurfaceType: null,
        signals: {
          betcoProduct: null,
          resolvedProductLineKey: null,
          surfaceType: 'tile',
          brandFamily: null,
          setting: null,
        },
      }),
    ]);
    expect(report.signals.surfaceType.scoredItemCount).toBe(0);
    expect(report.signals.surfaceType.matchedItemCount).toBe(0);
    expect(report.signals.surfaceType.precision).toBeNull();
    expect(report.signals.surfaceType.recall).toBeNull();
    expect(report.signals.surfaceType.mismatches).toEqual([]);
  });

  it('excludes items with no signals gate present (null actual) from the denominator, never counting them as a miss', () => {
    const report = computeSignalAccuracyReport([
      item({ expectedSurfaceType: 'tile', signals: null }),
    ]);
    expect(report.signals.surfaceType.scoredItemCount).toBe(0);
    expect(report.signals.surfaceType.mismatches).toEqual([]);
  });

  it('treats a gate-present-but-field-null extraction as a genuine miss (not excluded)', () => {
    const report = computeSignalAccuracyReport([
      item({
        rowIndex: 2,
        expectedSurfaceType: 'tile',
        signals: {
          betcoProduct: null,
          resolvedProductLineKey: null,
          surfaceType: null, // gate ran, but this field came back null
          brandFamily: null,
          setting: null,
        },
      }),
    ]);
    expect(report.signals.surfaceType.scoredItemCount).toBe(1);
    expect(report.signals.surfaceType.matchedItemCount).toBe(0);
    expect(report.signals.surfaceType.recall).toBe(0);
    // precision denominator (extracted-non-null count) is 0, so precision is null, not 0/0.
    expect(report.signals.surfaceType.precision).toBeNull();
    expect(report.signals.surfaceType.mismatches).toHaveLength(1);
    expect(report.signals.surfaceType.mismatches[0].actual).toBeNull();
  });

  describe('product_mention dual-match logic', () => {
    it('matches on betcoProduct alone', () => {
      const report = computeSignalAccuracyReport([
        item({
          expectedProductMention: 'pH7Q',
          signals: {
            betcoProduct: 'pH7Q Neutral Disinfectant',
            resolvedProductLineKey: null,
            surfaceType: null,
            brandFamily: null,
            setting: null,
          },
        }),
      ]);
      expect(report.signals.productMention.matchedItemCount).toBe(1);
    });

    it('matches on resolvedProductLineKey alone, even when betcoProduct disagrees', () => {
      const report = computeSignalAccuracyReport([
        item({
          expectedProductMention: 'pH7Q',
          signals: {
            betcoProduct: 'Best Sent Lemon Zest',
            resolvedProductLineKey: 'ph7q',
            surfaceType: null,
            brandFamily: null,
            setting: null,
          },
        }),
      ]);
      expect(report.signals.productMention.matchedItemCount).toBe(1);
    });

    it('is a miss when neither field matches', () => {
      const report = computeSignalAccuracyReport([
        item({
          rowIndex: 9,
          expectedProductMention: 'pH7Q',
          signals: {
            betcoProduct: 'Fight Bac RTU',
            resolvedProductLineKey: 'fight-bac',
            surfaceType: null,
            brandFamily: null,
            setting: null,
          },
        }),
      ]);
      expect(report.signals.productMention.matchedItemCount).toBe(0);
      expect(report.signals.productMention.mismatches).toEqual([
        {
          testItemId: 'item-1',
          rowIndex: 9,
          prompt: 'What surface is pH7Q used on?',
          expected: 'pH7Q',
          actual: 'Fight Bac RTU',
        },
      ]);
    });

    it('excluded from the denominator (not a miss) when the gate is absent', () => {
      const report = computeSignalAccuracyReport([
        item({ expectedProductMention: 'pH7Q', signals: null }),
      ]);
      expect(report.signals.productMention.scoredItemCount).toBe(0);
      expect(report.signals.productMention.mismatches).toEqual([]);
    });
  });

  it('scores each of the four signals independently within the same item set', () => {
    const report = computeSignalAccuracyReport([
      item({
        rowIndex: 1,
        expectedProductMention: 'pH7Q',
        expectedSurfaceType: 'tile',
        expectedBrandFamily: null, // unlabeled — excluded from brandFamily only
        expectedSetting: 'commercial',
        signals: {
          betcoProduct: 'pH7Q',
          resolvedProductLineKey: null,
          surfaceType: 'tile',
          brandFamily: 'betco',
          setting: 'residential', // wrong
        },
      }),
    ]);
    expect(report.signals.productMention.matchedItemCount).toBe(1);
    expect(report.signals.surfaceType.matchedItemCount).toBe(1);
    expect(report.signals.brandFamily.scoredItemCount).toBe(0);
    expect(report.signals.setting.matchedItemCount).toBe(0);
    expect(report.signals.setting.mismatches).toHaveLength(1);
  });

  it('sorts mismatches by row_index', () => {
    const report = computeSignalAccuracyReport([
      item({
        testItemId: 'a',
        rowIndex: 5,
        expectedSurfaceType: 'tile',
        signals: {
          betcoProduct: null,
          resolvedProductLineKey: null,
          surfaceType: 'grout',
          brandFamily: null,
          setting: null,
        },
      }),
      item({
        testItemId: 'b',
        rowIndex: 2,
        expectedSurfaceType: 'vct',
        signals: {
          betcoProduct: null,
          resolvedProductLineKey: null,
          surfaceType: 'grout',
          brandFamily: null,
          setting: null,
        },
      }),
    ]);
    expect(report.signals.surfaceType.mismatches.map((m) => m.rowIndex)).toEqual([2, 5]);
  });
});
