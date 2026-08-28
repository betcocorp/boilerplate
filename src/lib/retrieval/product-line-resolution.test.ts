import { describe, expect, it } from 'vitest';

import { resolveProductLineFromMatches } from '~/lib/retrieval/product-line-resolution';
import type { RagSearchMatch } from '~/lib/rag/search';

function match(overrides: Partial<RagSearchMatch> & { productLineKey: string; similarity: number }): RagSearchMatch {
  return {
    chunk_id: `chunk-${overrides.productLineKey}-${overrides.similarity}`,
    chunk_key: 'k',
    chunk_index: 0,
    heading: null,
    chunk_text: 'text',
    section_path: null,
    section_type: null,
    token_count: null,
    document_id: `doc-${overrides.productLineKey}`,
    document_key: 'd',
    document_title: 'Title',
    entity_id: null,
    product_key: null,
    sku: null,
    source_pk: 'p',
    document_kind: 'sds',
    ...overrides,
    product_line_key: overrides.productLineKey,
    similarity: overrides.similarity,
  };
}

describe('resolveProductLineFromMatches', () => {
  it('locks on a clear, well-separated top score (default behavior unchanged)', () => {
    const result = resolveProductLineFromMatches([
      match({ productLineKey: 'line-a', similarity: 0.7 }),
      match({ productLineKey: 'line-b', similarity: 0.4 }),
    ]);
    expect(result.lockReason).toBe('high_confidence');
    expect(result.lockedProductLineKey).toBe('line-a');
  });

  it('locks via the absolute-threshold shortcut on a thin margin when requireMarginForHighConfidence is not set', () => {
    const result = resolveProductLineFromMatches([
      match({ productLineKey: 'line-a', similarity: 0.7 }),
      match({ productLineKey: 'line-b', similarity: 0.68 }),
    ]);
    expect(result.lockReason).toBe('high_confidence');
    expect(result.lockedProductLineKey).toBe('line-a');
  });

  it('B0-693: refuses to lock a high absolute score with a thin margin when requireMarginForHighConfidence is set', () => {
    const result = resolveProductLineFromMatches(
      [
        match({ productLineKey: 'line-a', similarity: 0.7 }),
        match({ productLineKey: 'line-b', similarity: 0.68 }),
      ],
      { requireMarginForHighConfidence: true },
    );
    expect(result.lockReason).toBe('skipped_ambiguous');
    expect(result.lockedProductLineKey).toBeNull();
  });

  it('B0-693: still locks under requireMarginForHighConfidence when the margin is genuinely clear', () => {
    const result = resolveProductLineFromMatches(
      [
        match({ productLineKey: 'line-a', similarity: 0.9 }),
        match({ productLineKey: 'line-b', similarity: 0.4 }),
      ],
      { requireMarginForHighConfidence: true },
    );
    expect(result.lockReason).toBe('high_confidence');
    expect(result.lockedProductLineKey).toBe('line-a');
  });

  it('B0-693: still locks under requireMarginForHighConfidence when there is no runner-up at all', () => {
    const result = resolveProductLineFromMatches(
      [match({ productLineKey: 'line-a', similarity: 0.7 })],
      { requireMarginForHighConfidence: true },
    );
    expect(result.lockReason).toBe('high_confidence');
    expect(result.lockedProductLineKey).toBe('line-a');
  });
});
