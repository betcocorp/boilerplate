import { describe, expect, it, vi } from 'vitest';

import type { ToolTraceEntry } from '~/lib/audit/trace';
import {
  buildComparisonPreloadedEvidence,
  buildComparisonSearchArgumentsJson,
  extractComparisonCandidates,
  resolveComparisonEntities,
  runComparisonRetrieval,
  type ComparisonEntity,
  type ResolveProductEntity,
} from '~/lib/workflows/product-support/comparison-retrieval';

function trace(overrides: Partial<ToolTraceEntry> = {}): ToolTraceEntry {
  return {
    toolName: 'search_product_docs',
    callId: 'comparison-search-0-run_1',
    argumentsPreview: '',
    outputPreview: '',
    ok: true,
    durationMs: 90,
    ...overrides,
  };
}

describe('extractComparisonCandidates (B0-890)', () => {
  it('splits "difference between X and Y" phrasing', () => {
    expect(
      extractComparisonCandidates("What's the difference between pH7Q and pH7Q Dual?"),
    ).toEqual(['pH7Q', 'pH7Q Dual']);
  });

  it('splits "X vs Y" phrasing', () => {
    expect(extractComparisonCandidates('pH7Q vs pH7Q Dual')).toEqual(['pH7Q', 'pH7Q Dual']);
  });

  it('splits "X versus Y" phrasing', () => {
    expect(extractComparisonCandidates('Symplicity versus Symplicity Concentrate')).toEqual([
      'Symplicity',
      'Symplicity Concentrate',
    ]);
  });

  it('splits "X compared to Y" phrasing', () => {
    expect(extractComparisonCandidates('Speedex compared to Speedex Concentrate')).toEqual([
      'Speedex',
      'Speedex Concentrate',
    ]);
  });

  it('splits "X or Y" phrasing', () => {
    expect(extractComparisonCandidates('pH7Q or pH7Q Dual')).toEqual(['pH7Q', 'pH7Q Dual']);
  });

  it('strips a trailing clause from the second candidate', () => {
    expect(extractComparisonCandidates('Speedex vs Speedex Concentrate for restrooms')).toEqual([
      'Speedex',
      'Speedex Concentrate',
    ]);
  });

  it('strips leading question filler from the first candidate', () => {
    expect(extractComparisonCandidates('What is AF79 vs AF79 Concentrate?')).toEqual([
      'AF79',
      'AF79 Concentrate',
    ]);
  });

  it('returns null for a message with no comparison connector', () => {
    expect(extractComparisonCandidates('What is the dilution ratio for pH7Q?')).toBeNull();
  });

  it('returns null for an empty message', () => {
    expect(extractComparisonCandidates('   ')).toBeNull();
  });
});

describe('resolveComparisonEntities (B0-890)', () => {
  function fakeResolver(map: Record<string, string | null>): ResolveProductEntity {
    return async (name) => ({
      productLineKey: map[name] ?? null,
      productKey: null,
      resolutionSource: map[name] ? 'title_exact' : null,
    });
  }

  it('resolves two distinct product lines for a validated comparison', async () => {
    const result = await resolveComparisonEntities(
      "What's the difference between pH7Q and pH7Q Dual?",
      fakeResolver({ pH7Q: 'line-ph7q', 'pH7Q Dual': 'line-ph7q-dual' }),
    );

    expect(result).not.toBeNull();
    expect(result?.[0].productLineKey).toBe('line-ph7q');
    expect(result?.[1].productLineKey).toBe('line-ph7q-dual');
  });

  it('returns null (regression: no fan-out) when only one side resolves', async () => {
    const result = await resolveComparisonEntities(
      'Should I use bleach or a quat disinfectant on this floor?',
      fakeResolver({}),
    );
    expect(result).toBeNull();
  });

  it('returns null when a single-product question happens to contain "or"', async () => {
    // Regression: "or" is a valid connector, but a genuine single-product question must never
    // trigger the two-entity fan-out just because it contains the word.
    const result = await resolveComparisonEntities(
      'What is the dilution ratio for pH7Q, or is it ready to use?',
      fakeResolver({ pH7Q: 'line-ph7q' }),
    );
    expect(result).toBeNull();
  });

  it('returns null when both sides resolve to the SAME product line', async () => {
    const result = await resolveComparisonEntities(
      'pH7Q vs pH7Q',
      fakeResolver({ pH7Q: 'line-ph7q' }),
    );
    expect(result).toBeNull();
  });

  it('returns null for a non-comparison message without ever resolving anything', async () => {
    const resolver = vi.fn(fakeResolver({}));
    const result = await resolveComparisonEntities('What is the dilution ratio for pH7Q?', resolver);
    expect(result).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });
});

describe('runComparisonRetrieval (B0-890)', () => {
  const entities: [ComparisonEntity, ComparisonEntity] = [
    { name: 'pH7Q', productLineKey: 'line-ph7q', productKey: null, resolutionSource: 'title_exact' },
    {
      name: 'pH7Q Dual',
      productLineKey: 'line-ph7q-dual',
      productKey: null,
      resolutionSource: 'title_exact',
    },
  ];

  it('fires exactly TWO scoped search_product_docs calls, one per resolved entity', async () => {
    const execute = vi.fn(async (call: { name: string; argumentsJson: string; callId: string }) => ({
      output: JSON.stringify({ ok: true, sources: [{ documentId: `doc-${call.callId}` }] }),
      trace: trace({ callId: call.callId, argumentsPreview: call.argumentsJson }),
    }));

    const { results } = await runComparisonRetrieval({ entities, runId: 'run_1', execute });

    expect(execute).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);

    expect(execute).toHaveBeenNthCalledWith(1, {
      name: 'search_product_docs',
      argumentsJson: buildComparisonSearchArgumentsJson('pH7Q'),
      callId: 'comparison-search-0-run_1',
      speculative: true,
      productLineLockOverride: { productLineKey: 'line-ph7q', resolutionSource: 'title_exact' },
    });
    expect(execute).toHaveBeenNthCalledWith(2, {
      name: 'search_product_docs',
      argumentsJson: buildComparisonSearchArgumentsJson('pH7Q Dual'),
      callId: 'comparison-search-1-run_1',
      speculative: true,
      productLineLockOverride: { productLineKey: 'line-ph7q-dual', resolutionSource: 'title_exact' },
    });
  });

  it('combines both result sets into one labelled pre-fetched evidence block', async () => {
    const execute = vi.fn(async (call: { callId: string }) => ({
      output: JSON.stringify({ ok: true, doc: call.callId }),
      trace: trace({ callId: call.callId }),
    }));

    const { results } = await runComparisonRetrieval({ entities, runId: 'run_1', execute });
    const evidence = buildComparisonPreloadedEvidence({ entities, results });

    expect(evidence.label).toContain('pH7Q');
    expect(evidence.label).toContain('pH7Q Dual');
    expect(evidence.text).toContain('Retrieval for "pH7Q"');
    expect(evidence.text).toContain('Retrieval for "pH7Q Dual"');
    expect(evidence.text).toContain('comparison-search-0-run_1');
    expect(evidence.text).toContain('comparison-search-1-run_1');
  });
});
