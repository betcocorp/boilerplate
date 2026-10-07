import { describe, expect, it } from 'vitest';

import {
  computeAliasResolutionReport,
  extractAliasResolutionCallsFromToolTrace,
} from '~/lib/tests/alias-routing';

import type { ToolTraceEntry } from '~/lib/audit/trace';

/**
 * B0-488 — coverage for the alias-resolution hit-rate reducer, mirroring
 * `~/lib/tests/tool-routing.test.ts`'s style (pure-function unit tests over hand-built
 * `ToolTraceEntry[]` fixtures rather than a live workflow run).
 */

function toolCall(outputPreview: string, overrides: Partial<ToolTraceEntry> = {}): ToolTraceEntry {
  return {
    toolName: 'search_product_docs',
    callId: 'call-1',
    argumentsPreview: '{}',
    outputPreview,
    ok: true,
    durationMs: 10,
    argumentsTruncated: false,
    outputTruncated: false,
    ...overrides,
  };
}

describe('extractAliasResolutionCallsFromToolTrace', () => {
  it('extracts an attempted alias-exact outcome from a well-formed tool output', () => {
    const trace = [
      toolCall(JSON.stringify({ ok: true, aliasResolution: { attempted: true, outcome: 'alias_exact' } })),
    ];

    expect(extractAliasResolutionCallsFromToolTrace(trace)).toEqual([
      { toolName: 'search_product_docs', outcome: 'alias_exact' },
    ]);
  });

  it('skips calls where aliasResolution.attempted is false (nothing to resolve)', () => {
    const trace = [
      toolCall(JSON.stringify({ ok: true, aliasResolution: { attempted: false, outcome: null } })),
    ];

    expect(extractAliasResolutionCallsFromToolTrace(trace)).toEqual([]);
  });

  it('skips calls with no aliasResolution field at all (tools that never resolve a product, or pre-B0-488 rows)', () => {
    const trace = [toolCall(JSON.stringify({ ok: true, adapter: 'category_router_v1' }))];

    expect(extractAliasResolutionCallsFromToolTrace(trace)).toEqual([]);
  });

  it('skips a call whose outputPreview is truncated mid-JSON rather than throwing', () => {
    const truncated = JSON.stringify({ ok: true, aliasResolution: { attempted: true, outcome: 'alias_exact' } }).slice(
      0,
      20,
    );
    const trace = [toolCall(truncated)];

    expect(extractAliasResolutionCallsFromToolTrace(trace)).toEqual([]);
  });

  it('skips an aliasResolution value with an unrecognized outcome string', () => {
    const trace = [
      toolCall(JSON.stringify({ ok: true, aliasResolution: { attempted: true, outcome: 'something_new' } })),
    ];

    expect(extractAliasResolutionCallsFromToolTrace(trace)).toEqual([]);
  });

  it('returns [] for a null trace (no agent-step output on file for this item)', () => {
    expect(extractAliasResolutionCallsFromToolTrace(null)).toEqual([]);
  });

  it('handles multiple calls in one trace, keeping only the attempted ones', () => {
    const trace = [
      toolCall(JSON.stringify({ aliasResolution: { attempted: true, outcome: 'alias_fuzzy' } }), {
        toolName: 'get_product_spec',
      }),
      toolCall(JSON.stringify({ aliasResolution: { attempted: false, outcome: null } }), {
        toolName: 'search_product_docs',
      }),
      toolCall(JSON.stringify({ aliasResolution: { attempted: true, outcome: 'ambiguous_alias' } }), {
        toolName: 'get_safety_constraints',
      }),
    ];

    expect(extractAliasResolutionCallsFromToolTrace(trace)).toEqual([
      { toolName: 'get_product_spec', outcome: 'alias_fuzzy' },
      { toolName: 'get_safety_constraints', outcome: 'ambiguous_alias' },
    ]);
  });
});

describe('computeAliasResolutionReport', () => {
  it('returns all-null rates when nothing in the run attempted a resolution', () => {
    const report = computeAliasResolutionReport([null, []]);

    expect(report).toEqual({
      totalAttempts: 0,
      counts: { alias_exact: 0, alias_fuzzy: 0, no_alias_match: 0, ambiguous_alias: 0 },
      hitRate: null,
      ambiguousRate: null,
    });
  });

  it('computes hit rate as (alias_exact + alias_fuzzy) / totalAttempts across every item', () => {
    const traces = [
      [toolCall(JSON.stringify({ aliasResolution: { attempted: true, outcome: 'alias_exact' } }))],
      [toolCall(JSON.stringify({ aliasResolution: { attempted: true, outcome: 'alias_fuzzy' } }))],
      [toolCall(JSON.stringify({ aliasResolution: { attempted: true, outcome: 'no_alias_match' } }))],
      [toolCall(JSON.stringify({ aliasResolution: { attempted: true, outcome: 'ambiguous_alias' } }))],
      null,
    ];

    const report = computeAliasResolutionReport(traces);

    expect(report.totalAttempts).toBe(4);
    expect(report.counts).toEqual({
      alias_exact: 1,
      alias_fuzzy: 1,
      no_alias_match: 1,
      ambiguous_alias: 1,
    });
    expect(report.hitRate).toBe(0.5);
    expect(report.ambiguousRate).toBe(0.25);
  });
});
