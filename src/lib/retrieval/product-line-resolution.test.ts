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

  /**
   * B0-693 (general-query gap) — the exact similarity scores from workflow run
   * 61cc4ce9-bc1b-4d08-9b88-bc7d52c7365b: "What is the dilution ratio in oz per gallon for DAILY
   * DISINFECT?" (a general free-text query — `search_product_docs`'s freeform path never sets
   * `sectionType`, so the ONE production call site used to pass
   * `requireMarginForHighConfidence: sectionType !== null` = `false` here). The top hit
   * ("Sen Emerging Storm Con", an unrelated malodor-eliminator product) beat the absolute
   * threshold (0.64) with only a ~0.003 spread over the runner-up ("Sure Bet II") — thin enough
   * that `MIN_LOCK_MARGIN` (0.06) should refuse to corroborate it.
   */
  it('B0-693: without margin corroboration, the live incident numbers lock the WRONG product (documents the bug in isolation)', () => {
    const result = resolveProductLineFromMatches([
      match({ productLineKey: 'E5A06FEB-AABC-4BE1-B59D-6B45C68D2F21', label: 'Sen Emerging Storm Con', similarity: 0.687637705775389 }),
      match({ productLineKey: 'D0DD5B85-642D-4EFE-A373-2150AD69334B', label: 'Sure Bet II', similarity: 0.684335693938053 }),
      match({ productLineKey: '6FF09B18-B7DD-459A-9645-9FCA9F0C097D', label: 'AF 315', similarity: 0.681934920753929 }),
    ]);
    expect(result.lockReason).toBe('high_confidence');
    expect(result.lockedProductLineKey).toBe('E5A06FEB-AABC-4BE1-B59D-6B45C68D2F21');
  });

  it('B0-693: the same live incident numbers refuse to lock once margin corroboration is required for every query (the fix)', () => {
    const result = resolveProductLineFromMatches(
      [
        match({ productLineKey: 'E5A06FEB-AABC-4BE1-B59D-6B45C68D2F21', label: 'Sen Emerging Storm Con', similarity: 0.687637705775389 }),
        match({ productLineKey: 'D0DD5B85-642D-4EFE-A373-2150AD69334B', label: 'Sure Bet II', similarity: 0.684335693938053 }),
        match({ productLineKey: '6FF09B18-B7DD-459A-9645-9FCA9F0C097D', label: 'AF 315', similarity: 0.681934920753929 }),
      ],
      { requireMarginForHighConfidence: true },
    );
    expect(result.lockReason).toBe('skipped_ambiguous');
    expect(result.lockedProductLineKey).toBeNull();
  });
});
