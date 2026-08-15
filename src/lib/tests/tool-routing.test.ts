import { describe, expect, it } from 'vitest';

import type { ToolTraceEntry } from '~/lib/audit/trace';

import {
  computeToolRoutingReport,
  EXPECTED_TOOL_METADATA_KEY,
  extractExpectedTool,
  isKnownToolName,
  parseAgentStepToolTrace,
  type ToolRoutingReportInput,
} from './tool-routing';

function trace(...toolNames: string[]): ToolTraceEntry[] {
  return toolNames.map((toolName, index) => ({
    toolName,
    callId: `call-${index}`,
    argumentsPreview: '{}',
    outputPreview: 'ok',
    ok: true,
  }));
}

describe('extractExpectedTool', () => {
  it('reads the metadata.expected_tool key, trimmed', () => {
    expect(extractExpectedTool({ [EXPECTED_TOOL_METADATA_KEY]: '  get_efficacy_data  ' })).toBe(
      'get_efficacy_data',
    );
  });

  it('returns null for missing, blank, non-string, or malformed metadata', () => {
    expect(extractExpectedTool({})).toBeNull();
    expect(extractExpectedTool({ [EXPECTED_TOOL_METADATA_KEY]: '   ' })).toBeNull();
    expect(extractExpectedTool({ [EXPECTED_TOOL_METADATA_KEY]: 42 })).toBeNull();
    expect(extractExpectedTool(null)).toBeNull();
    expect(extractExpectedTool('not an object')).toBeNull();
    expect(extractExpectedTool(['array'])).toBeNull();
  });
});

describe('isKnownToolName', () => {
  it('recognizes the live 14 product-support tool names', () => {
    expect(isKnownToolName('search_product_docs')).toBe(true);
    expect(isKnownToolName('get_efficacy_data')).toBe(true);
  });

  it('rejects unknown / typo tool names', () => {
    expect(isKnownToolName('serach_product_docs')).toBe(false);
    expect(isKnownToolName('')).toBe(false);
  });
});

describe('parseAgentStepToolTrace', () => {
  it('parses a well-formed toolTrace array off the agent step output', () => {
    const output = { toolTrace: trace('search_product_docs', 'get_efficacy_data') };
    const parsed = parseAgentStepToolTrace(output);
    expect(parsed).toHaveLength(2);
    expect(parsed?.map((e) => e.toolName)).toEqual(['search_product_docs', 'get_efficacy_data']);
  });

  it('returns null when output has no toolTrace (e.g. early-decline runs)', () => {
    expect(parseAgentStepToolTrace({ responseIds: [] })).toBeNull();
    expect(parseAgentStepToolTrace(null)).toBeNull();
    expect(parseAgentStepToolTrace('not an object')).toBeNull();
  });

  it('returns null for a malformed toolTrace entry rather than throwing', () => {
    const output = { toolTrace: [{ toolName: 123, callId: 'x' }] };
    expect(parseAgentStepToolTrace(output)).toBeNull();
  });
});

describe('computeToolRoutingReport', () => {
  function item(overrides: Partial<ToolRoutingReportInput>): ToolRoutingReportInput {
    return {
      resultItemId: 'result-1',
      testItemId: 'item-1',
      rowIndex: 1,
      prompt: 'How much pH7Q per gallon?',
      expectedTool: null,
      toolTrace: null,
      ...overrides,
    };
  }

  it('counts call frequency across every item, scored or not', () => {
    const report = computeToolRoutingReport([
      item({
        resultItemId: 'r1',
        toolTrace: trace('search_product_docs'),
      }),
      item({
        resultItemId: 'r2',
        toolTrace: trace('search_product_docs', 'get_efficacy_data'),
      }),
    ]);

    expect(report.frequency).toEqual([
      { toolName: 'search_product_docs', callCount: 2, itemCount: 2, known: true },
      { toolName: 'get_efficacy_data', callCount: 1, itemCount: 1, known: true },
    ]);
  });

  it('scores routing accuracy only over items with an expected_tool set', () => {
    const report = computeToolRoutingReport([
      // Correctly routed: expected tool was called.
      item({
        resultItemId: 'r1',
        rowIndex: 1,
        expectedTool: 'get_efficacy_data',
        toolTrace: trace('get_efficacy_data'),
      }),
      // Misrouted: model called search_product_docs instead of the expected get_efficacy_data.
      item({
        resultItemId: 'r2',
        rowIndex: 2,
        prompt: 'What is the dilution for AF315?',
        expectedTool: 'get_efficacy_data',
        toolTrace: trace('search_product_docs'),
      }),
      // No expectation set — contributes to frequency only, never to accuracy or mismatches.
      item({
        resultItemId: 'r3',
        rowIndex: 3,
        expectedTool: null,
        toolTrace: trace('search_product_docs'),
      }),
    ]);

    expect(report.scoredItemCount).toBe(2);
    expect(report.matchedItemCount).toBe(1);
    expect(report.routingAccuracy).toBeCloseTo(0.5);
    expect(report.mismatches).toEqual([
      {
        resultItemId: 'r2',
        testItemId: 'item-1',
        rowIndex: 2,
        prompt: 'What is the dilution for AF315?',
        expectedTool: 'get_efficacy_data',
        calledTools: ['search_product_docs'],
      },
    ]);
  });

  it('treats a question with no tool called at all as a mismatch when scored', () => {
    const report = computeToolRoutingReport([
      item({ resultItemId: 'r1', expectedTool: 'get_efficacy_data', toolTrace: null }),
    ]);

    expect(report.matchedItemCount).toBe(0);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0].calledTools).toEqual([]);
  });

  it('returns null routingAccuracy when nothing in the run has an expectation', () => {
    const report = computeToolRoutingReport([
      item({ resultItemId: 'r1', toolTrace: trace('search_product_docs') }),
    ]);
    expect(report.scoredItemCount).toBe(0);
    expect(report.routingAccuracy).toBeNull();
    expect(report.mismatches).toEqual([]);
  });

  it('flags expected_tool values that are not one of the 14 live tool names', () => {
    const report = computeToolRoutingReport([
      item({ resultItemId: 'r1', expectedTool: 'serach_product_docs', toolTrace: trace('search_product_docs') }),
    ]);
    expect(report.unknownExpectedTools).toEqual(['serach_product_docs']);
  });

  it('sorts mismatches by row_index and frequency by call count desc then name', () => {
    const report = computeToolRoutingReport([
      item({ resultItemId: 'r2', rowIndex: 5, expectedTool: 'get_efficacy_data', toolTrace: trace('lookup_cross_reference') }),
      item({ resultItemId: 'r1', rowIndex: 2, expectedTool: 'get_safety_constraints', toolTrace: trace('lookup_cross_reference') }),
    ]);
    expect(report.mismatches.map((m) => m.rowIndex)).toEqual([2, 5]);
    expect(report.frequency).toEqual([
      { toolName: 'lookup_cross_reference', callCount: 2, itemCount: 2, known: true },
    ]);
  });
});
