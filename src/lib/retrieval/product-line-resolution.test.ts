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

/**
 * B0-873 — a `knowledge` document carries no `product_line_key`, so it can never be a candidate;
 * when it is nonetheless the probe's best match, locking would filter it (and every other
 * knowledge document) out of the anchored search in SQL. `skipLockWhenKnowledgeOutranks` refuses
 * the lock in that case. Opt-in, so every B0-693 case above still exercises the bare rules.
 */
describe('resolveProductLineFromMatches — B0-873 knowledge-top-hit guard', () => {
  const knowledge = (similarity: number) =>
    match({ productLineKey: '', similarity, document_kind: 'knowledge', document_title: 'VCT Green Certified' });

  it('refuses to lock when a knowledge chunk outranks the top product-line candidate', () => {
    const result = resolveProductLineFromMatches(
      [
        match({ productLineKey: 'line-a', similarity: 0.7 }),
        knowledge(0.75),
        match({ productLineKey: 'line-b', similarity: 0.4 }),
      ],
      { requireMarginForHighConfidence: true, skipLockWhenKnowledgeOutranks: true },
    );
    expect(result.lockReason).toBe('skipped_knowledge_top_hit');
    expect(result.lockedProductLineKey).toBeNull();
    // Candidates are still reported so the persisted lock decision stays diagnosable.
    expect(result.candidates.map((c) => c.productLineKey)).toEqual(['line-a', 'line-b']);
  });

  it('treats an exact tie as the knowledge document winning (>=, never >)', () => {
    const result = resolveProductLineFromMatches(
      [match({ productLineKey: 'line-a', similarity: 0.7 }), knowledge(0.7)],
      { requireMarginForHighConfidence: true, skipLockWhenKnowledgeOutranks: true },
    );
    expect(result.lockReason).toBe('skipped_knowledge_top_hit');
  });

  it('still locks when the product document outranks every knowledge chunk (B0-438 fixture shape)', () => {
    const result = resolveProductLineFromMatches(
      [match({ productLineKey: 'line-a', similarity: 0.71 }), knowledge(0.41)],
      { requireMarginForHighConfidence: true, skipLockWhenKnowledgeOutranks: true },
    );
    expect(result.lockReason).toBe('high_confidence');
    expect(result.lockedProductLineKey).toBe('line-a');
  });

  it('is opt-in: without the option the same matches lock exactly as before', () => {
    const result = resolveProductLineFromMatches(
      [match({ productLineKey: 'line-a', similarity: 0.7 }), knowledge(0.75)],
      { requireMarginForHighConfidence: true },
    );
    expect(result.lockReason).toBe('high_confidence');
    expect(result.lockedProductLineKey).toBe('line-a');
  });

  /**
   * Live VCT#17 numbers (2026-09-07, "what stripping and finish products should I use for my VCT
   * floor?"): the probe locked "Hard Film Floor Finish" at 0.578 while the best knowledge chunk
   * ("VCT Green Certified" chunk 7) scored 0.666 and every returned VCT knowledge chunk outscored
   * the lock. The anchored search then returned only Hard As Nails documents.
   */
  it('VCT#17 live numbers: the knowledge document wins and the lock is declined', () => {
    const result = resolveProductLineFromMatches(
      [
        match({ productLineKey: 'DBF2B1E5-FD1A-4E42-A3A5-D7C8F5C3B671', document_title: 'Hard Film Floor Finish', document_kind: 'product_line_profile', similarity: 0.578 }),
        knowledge(0.666),
        knowledge(0.664),
      ],
      { requireMarginForHighConfidence: true, skipLockWhenKnowledgeOutranks: true },
    );
    expect(result.lockReason).toBe('skipped_knowledge_top_hit');
    expect(result.lockedProductLineKey).toBeNull();
  });
});
