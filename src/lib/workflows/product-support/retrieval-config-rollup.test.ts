import { describe, expect, it } from 'vitest';

import type { ToolTraceEntry } from '~/lib/audit/trace';
import { extractRetrievalConfigFromToolTrace } from '~/lib/workflows/product-support/run-product-support-workflow';

/**
 * B0-493 — `extractRetrievalConfigFromToolTrace` rolls every search-backed tool call's persisted
 * `retrieval` block up to one run-level record: agreement -> the shared value, disagreement ->
 * null + the field name listed in `mixed`. Pure function of the resolved tool trace, so a minimal
 * `ToolTraceEntry` stub (only `retrieval` matters here) is enough to exercise it directly.
 */

function entry(retrieval?: ToolTraceEntry['retrieval']): ToolTraceEntry {
  return {
    toolName: 'search_product_docs',
    callId: 'call_1',
    argumentsPreview: '{}',
    outputPreview: '{}',
    ok: true,
    ...(retrieval ? { retrieval } : {}),
  };
}

function retrieval(overrides: Partial<NonNullable<ToolTraceEntry['retrieval']>> = {}) {
  return {
    model: 'text-embedding-3-large',
    limit: 20,
    scope: 'all',
    productLineKey: null,
    productKey: null,
    sectionType: null,
    minSimilarity: null,
    retrievalStrategy: 'hybrid+reranked',
    embeddingSource: 'new-embedding',
    timings: {
      totalMs: 100,
      queryEmbeddingMs: 10,
      queryRewriteMs: 5,
      cacheLookupMs: 2,
      embeddingCreateMs: 40,
      cachePersistMs: 3,
      similaritySearchMs: 30,
      rerankMs: 10,
    },
    selection: {
      limit: 3,
      minSimilarity: 0.2,
      maxPerDocument: 1,
      requiredDocumentKinds: ['product_line_profile', 'sds', 'knowledge', 'label'],
    },
    ...overrides,
  };
}

describe('extractRetrievalConfigFromToolTrace (B0-493)', () => {
  it('labels a run with the agreed retrieval configuration when every search call matches', () => {
    const summary = extractRetrievalConfigFromToolTrace([
      entry(retrieval()),
      entry(retrieval()),
    ]);

    expect(summary).toEqual({
      embeddingModel: 'text-embedding-3-large',
      retrievalStrategy: 'hybrid+reranked',
      embeddingSource: 'new-embedding',
      scope: 'all',
      minSimilarity: 0.2,
      mixed: [],
    });
  });

  it('surfaces the silently-defaulted 0.2 floor as an applied value, not an absence', () => {
    const summary = extractRetrievalConfigFromToolTrace([entry(retrieval())]);
    expect(summary.minSimilarity).toBe(0.2);
  });

  it('marks a field mixed (and nulls it) when two calls disagree, keeping the rest labelled', () => {
    const summary = extractRetrievalConfigFromToolTrace([
      entry(retrieval({ embeddingSource: 'exact-cache-hit' })),
      entry(retrieval({ embeddingSource: 'new-embedding' })),
    ]);

    expect(summary.embeddingSource).toBeNull();
    expect(summary.mixed).toEqual(['embeddingSource']);
    // Fields that agreed are unaffected by the one that didn't.
    expect(summary.embeddingModel).toBe('text-embedding-3-large');
    expect(summary.retrievalStrategy).toBe('hybrid+reranked');
  });

  it('reports multiple disagreeing fields', () => {
    const summary = extractRetrievalConfigFromToolTrace([
      entry(retrieval({ scope: 'products', retrievalStrategy: 'vector' })),
      entry(retrieval({ scope: 'all', retrievalStrategy: 'hybrid' })),
    ]);

    expect(summary.scope).toBeNull();
    expect(summary.retrievalStrategy).toBeNull();
    expect(summary.mixed.sort()).toEqual(['retrievalStrategy', 'scope']);
  });

  it('is all-null with no mixed fields when no call carried a retrieval block', () => {
    const summary = extractRetrievalConfigFromToolTrace([
      entry(undefined),
      { ...entry(undefined), toolName: 'lookup_cross_reference' },
    ]);

    expect(summary).toEqual({
      embeddingModel: null,
      retrievalStrategy: null,
      embeddingSource: null,
      scope: null,
      minSimilarity: null,
      mixed: [],
    });
  });

  it('is all-null on an empty trace', () => {
    expect(extractRetrievalConfigFromToolTrace([])).toEqual({
      embeddingModel: null,
      retrievalStrategy: null,
      embeddingSource: null,
      scope: null,
      minSimilarity: null,
      mixed: [],
    });
  });
});
