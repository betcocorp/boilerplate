import { describe, expect, it } from 'vitest';

import { extractSimilarityRollupFromToolOutputs } from '~/lib/workflows/product-support/run-product-support-workflow';

/**
 * B0-490 — `extractSimilarityRollupFromToolOutputs` is the pure aggregation step that replaced
 * `sources.reduce(...)` as the source of the `topSimilarity` fed to `evaluateRecommendationGate`.
 * It reads only `entry.ok` / `entry.output`, so a minimal tool-output stub (no real `ToolTraceEntry`
 * needed) is enough to exercise it directly, without the workflow's DB/OpenAI dependencies.
 */

function toolOutput(input: {
  ok?: boolean;
  retrieval?: Record<string, unknown> | null;
  extra?: Record<string, unknown>;
}) {
  return {
    toolName: 'search_product_docs',
    ok: input.ok ?? true,
    output: JSON.stringify({
      ok: true,
      ...(input.retrieval !== undefined ? { retrieval: input.retrieval } : {}),
      ...input.extra,
    }),
    trace: {
      toolName: 'search_product_docs',
      callId: 'call_1',
      argumentsPreview: '{}',
      outputPreview: '{}',
      ok: input.ok ?? true,
    },
  };
}

describe('extractSimilarityRollupFromToolOutputs (B0-490)', () => {
  it('reports raw strictly above selected when curation reduced the top score', () => {
    const rollup = extractSimilarityRollupFromToolOutputs([
      toolOutput({
        retrieval: { rawTopSimilarity: 0.91, selectedTopSimilarity: 0.58, droppedByFilterCount: 6 },
      }),
    ]);

    expect(rollup).toEqual({
      rawTopSimilarity: 0.91,
      selectedTopSimilarity: 0.58,
      droppedByFilterCount: 6,
    });
    expect(rollup.rawTopSimilarity!).toBeGreaterThan(rollup.selectedTopSimilarity!);
  });

  it('reports raw equal to selected when nothing was dropped', () => {
    const rollup = extractSimilarityRollupFromToolOutputs([
      toolOutput({
        retrieval: { rawTopSimilarity: 0.74, selectedTopSimilarity: 0.74, droppedByFilterCount: 0 },
      }),
    ]);

    expect(rollup.rawTopSimilarity).toBe(rollup.selectedTopSimilarity);
    expect(rollup.droppedByFilterCount).toBe(0);
  });

  it('rolls up the max raw/selected and the summed dropped count across multiple search calls', () => {
    const rollup = extractSimilarityRollupFromToolOutputs([
      toolOutput({
        retrieval: { rawTopSimilarity: 0.4, selectedTopSimilarity: 0.4, droppedByFilterCount: 3 },
      }),
      toolOutput({
        retrieval: { rawTopSimilarity: 0.82, selectedTopSimilarity: 0.6, droppedByFilterCount: 5 },
      }),
    ]);

    expect(rollup).toEqual({
      rawTopSimilarity: 0.82,
      selectedTopSimilarity: 0.6,
      droppedByFilterCount: 8,
    });
  });

  it('returns all-null on the empty-match case: no tool calls at all', () => {
    expect(extractSimilarityRollupFromToolOutputs([])).toEqual({
      rawTopSimilarity: null,
      selectedTopSimilarity: null,
      droppedByFilterCount: null,
    });
  });

  it('returns all-null when no successful call carried a retrieval block (e.g. cross-reference-only turn)', () => {
    const rollup = extractSimilarityRollupFromToolOutputs([
      toolOutput({ retrieval: undefined, extra: { matches: [] } }),
      toolOutput({ ok: false, retrieval: { rawTopSimilarity: 0.9, selectedTopSimilarity: 0.9, droppedByFilterCount: 0 } }),
    ]);

    expect(rollup).toEqual({
      rawTopSimilarity: null,
      selectedTopSimilarity: null,
      droppedByFilterCount: null,
    });
  });

  it('ignores malformed JSON output rather than throwing', () => {
    const malformed = {
      toolName: 'search_product_docs',
      ok: true,
      output: '{not json',
      trace: {
        toolName: 'search_product_docs',
        callId: 'call_bad',
        argumentsPreview: '{}',
        outputPreview: '{not json',
        ok: true,
      },
    };

    expect(() => extractSimilarityRollupFromToolOutputs([malformed])).not.toThrow();
    expect(extractSimilarityRollupFromToolOutputs([malformed])).toEqual({
      rawTopSimilarity: null,
      selectedTopSimilarity: null,
      droppedByFilterCount: null,
    });
  });
});
