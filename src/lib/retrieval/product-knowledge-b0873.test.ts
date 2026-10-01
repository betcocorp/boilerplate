import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RagSearchMatch } from '~/lib/rag/search';

/**
 * B0-873 / B0-874 — a product-line lock filters retrieval to one line in SQL, and `knowledge`
 * documents carry no `product_line_key`, so a procedural question that locked a line ("How long
 * does it take to get a wall-mounted dispenser like FastDraw Pro up and running?") reached the
 * model with one product-profile chunk and never saw the knowledge document that answers it.
 *
 * Three behaviours, every one of them gated on `proceduralIntent` so no existing caller changes:
 *  1. line-filtered paths merge an UNLOCKED `scope: 'knowledge'` search into the pool before
 *     curation (never for a label-governed question);
 *  2. the broad probe declines to lock when a knowledge chunk outranks the top candidate
 *     (this one is NOT gated on `proceduralIntent` — see `skipLockWhenKnowledgeOutranks`);
 *  3. the single highest-similarity source, when it is a knowledge document, is widened to the
 *     sibling chunks similarity already ranked (B0-874) without touching other documents' slots.
 *
 * Mock scaffolding mirrors `product-knowledge-b0438.test.ts`.
 */

vi.mock('~/lib/rag/search', () => ({ searchProductChunks: vi.fn() }));
vi.mock('~/supabase/clients/service-role', () => ({ getSupabaseServiceRoleClient: vi.fn() }));
vi.mock('~/lib/retrieval/document-assembly', () => ({
  assembleNeighborChunkBodies: vi.fn(),
  assembleChunkIndexSetBody: vi.fn(),
  chunkWindowKey: (r: { documentId: string; chunkIndex: number }) => `${r.documentId}:${r.chunkIndex}`,
  fetchDocumentSourceRefs: vi.fn(),
  fetchProductLineWebUrls: vi.fn(),
}));
vi.mock('~/lib/rag/entity-context', () => ({
  fetchEntityContexts: vi.fn(),
  buildEntityContextBlock: vi.fn(() => null),
}));
vi.mock('~/lib/retrieval/product-facts', () => ({
  fetchProductLineFacts: vi.fn(),
  buildFactsBlock: vi.fn(() => null),
}));
vi.mock('~/lib/settings/settings-service', () => ({
  getProductLineLockThresholds: vi.fn(async () => ({
    minLockSimilarity: 0.5,
    minLockMargin: 0.06,
    highConfidenceAbsolute: 0.64,
  })),
  getBooleanSetting: vi.fn(async (_key: string, fallback: boolean) => fallback),
}));

import { searchProductChunks } from '~/lib/rag/search';
import { fetchEntityContexts } from '~/lib/rag/entity-context';
import {
  assembleChunkIndexSetBody,
  assembleNeighborChunkBodies,
  fetchDocumentSourceRefs,
  fetchProductLineWebUrls,
} from '~/lib/retrieval/document-assembly';
import { fetchProductLineFacts } from '~/lib/retrieval/product-facts';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import { ragQueryForProductKnowledgeWithMeta } from '~/lib/retrieval/product-knowledge';

const LINE = '333';
const OTHER_LINE = '512';

function installSupabaseStub() {
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    schema: () => ({
      from: () => ({
        select: () => ({
          in: () => ({
            filter: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
      rpc: async () => ({ data: [], error: null }),
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
}

function match(overrides: Partial<RagSearchMatch> & { chunk_id: string }): RagSearchMatch {
  const id = overrides.chunk_id;
  return {
    chunk_id: id,
    chunk_key: `key-${id}`,
    chunk_index: 0,
    heading: null,
    chunk_text: `text for ${id}`,
    section_path: null,
    section_type: 'label',
    token_count: 20,
    document_id: `doc-${id}`,
    document_key: `dockey-${id}`,
    document_title: `Document ${id}`,
    entity_id: `entity-${id}`,
    product_key: null,
    sku: null,
    product_line_key: LINE,
    source_pk: `pk-${id}`,
    document_kind: 'product_line_profile',
    similarity: 0.5,
    ...overrides,
  };
}

/** A knowledge chunk exactly as the corpus stores it: no entity, no product line. */
function knowledge(overrides: Partial<RagSearchMatch> & { chunk_id: string }): RagSearchMatch {
  return match({
    document_kind: 'knowledge',
    section_type: 'knowledge',
    entity_id: null,
    product_line_key: null,
    ...overrides,
  });
}

function searchResult(matches: RagSearchMatch[]) {
  return {
    matches,
    embeddingSource: 'new-embedding' as const,
    timings: { similaritySearchMs: 10 },
  } as unknown as Awaited<ReturnType<typeof searchProductChunks>>;
}

/**
 * Routes the mocked search by what production asks for: `scope: 'knowledge'` is the B0-873
 * supplement; a product line is the anchored/explicit pass (with `productKey` for the SKU-scoped
 * first attempt); anything else is the broad probe.
 */
function stubSearches(byPass: {
  broad?: RagSearchMatch[];
  line?: RagSearchMatch[];
  productKeyScoped?: RagSearchMatch[];
  knowledge?: RagSearchMatch[];
}) {
  vi.mocked(searchProductChunks).mockImplementation(async (options) => {
    if (options.scope === 'knowledge') return searchResult(byPass.knowledge ?? []);
    if (options.productLineKey && options.productKey) {
      return searchResult(byPass.productKeyScoped ?? byPass.line ?? []);
    }
    if (options.productLineKey) return searchResult(byPass.line ?? []);
    return searchResult(byPass.broad ?? []);
  });
}

function identity(sources: { documentId: string; chunkId: string }[]) {
  return sources.map((s) => `${s.documentId}/${s.chunkId}`);
}

function knowledgeSearchCalls() {
  return vi.mocked(searchProductChunks).mock.calls.filter(([o]) => o.scope === 'knowledge');
}

beforeEach(() => {
  vi.clearAllMocks();
  installSupabaseStub();
  vi.mocked(assembleNeighborChunkBodies).mockImplementation(
    async (requests: Array<{ documentId: string; chunkIndex: number }>) =>
      new Map(
        requests.map((r) => [
          `${r.documentId}:${r.chunkIndex}`,
          {
            documentId: r.documentId,
            body: `assembled body for ${r.documentId}`,
            chunkCount: 1,
            totalChars: 10,
            truncated: false,
            estimatedTokens: 12,
            chunkIds: [`chunk-of-${r.documentId}`],
          },
        ]),
      ),
  );
  vi.mocked(assembleChunkIndexSetBody).mockResolvedValue({
    documentId: 'unused',
    body: '',
    chunkCount: 0,
    totalChars: 0,
    truncated: false,
    estimatedTokens: null,
    chunkIds: [],
  });
  vi.mocked(fetchDocumentSourceRefs).mockResolvedValue(new Map());
  vi.mocked(fetchProductLineWebUrls).mockResolvedValue(new Map());
  vi.mocked(fetchEntityContexts).mockResolvedValue(new Map());
  vi.mocked(fetchProductLineFacts).mockResolvedValue(new Map());
});

const PROCEDURAL_QUERY = 'how long does it take to get the wall-mounted dispenser up and running';
// Matches `isClaimLikeQuery` ("contact time") — label-governed, so no unlocked knowledge may be merged.
const REGULATED_PROCEDURAL_QUERY = 'how long is the contact time for this product';

describe('B0-873 — unlocked knowledge supplement on the explicit-key path', () => {
  const lineMatches = [match({ chunk_id: 'l1', similarity: 0.55 })];
  const knowledgeMatches = [
    knowledge({ chunk_id: 'k1', similarity: 0.83 }),
    knowledge({ chunk_id: 'k2', similarity: 0.6 }),
  ];

  it('merges an unlocked knowledge search into a procedural, non-regulated locked retrieval', async () => {
    stubSearches({ line: lineMatches, knowledge: knowledgeMatches });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: PROCEDURAL_QUERY,
      productLineKey: LINE,
      productLineKeySource: 'alias_fuzzy_trgm',
      limit: 6,
      proceduralIntent: true,
    });

    expect(vi.mocked(searchProductChunks)).toHaveBeenCalledTimes(2);
    const [knowledgeCall] = knowledgeSearchCalls();
    expect(knowledgeCall?.[0].productLineKey).toBeUndefined();
    expect(knowledgeCall?.[0].productKey).toBeUndefined();

    // The locked line's own evidence is still there; the knowledge documents join it on merit.
    expect(identity(result.sources)).toEqual(['doc-l1/l1', 'doc-k1/k1', 'doc-k2/k2']);
    expect(result.retrieval.strategy).toBe('explicit_product_line');
    expect(result.retrieval.productLineResolution?.lockReason).toBe('explicit_filter');
    expect(result.retrieval.usedKnowledgeSupplement).toBe(true);
    expect(result.retrieval.knowledgeSupplementCuratedCount).toBe(2);
    // The supplement's search time is counted, not silently omitted (B0-438 `searchMs` semantics).
    expect(result.retrieval.searchMs).toBe(20);
    // Line-only, on purpose — the recommendation gate was calibrated against this score.
    expect(result.retrieval.rawTopSimilarity).toBe(0.55);
  });

  it('never merges unlocked knowledge into a label-governed question, procedural phrasing or not', async () => {
    stubSearches({ line: lineMatches, knowledge: knowledgeMatches });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: REGULATED_PROCEDURAL_QUERY,
      productLineKey: LINE,
      limit: 6,
      proceduralIntent: true,
    });

    expect(knowledgeSearchCalls()).toHaveLength(0);
    expect(identity(result.sources)).toEqual(['doc-l1/l1']);
    expect(result.retrieval.usedKnowledgeSupplement).toBe(false);
    expect(result.retrieval.knowledgeSupplementCuratedCount).toBe(0);
  });

  it('is inert without proceduralIntent: one search, same sources as before', async () => {
    stubSearches({ line: lineMatches, knowledge: knowledgeMatches });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: PROCEDURAL_QUERY,
      productLineKey: LINE,
      limit: 6,
    });

    expect(vi.mocked(searchProductChunks)).toHaveBeenCalledTimes(1);
    expect(identity(result.sources)).toEqual(['doc-l1/l1']);
    expect(result.retrieval.usedKnowledgeSupplement).toBe(false);
    expect(result.retrieval.knowledgeSiblingExpansion).toBeNull();
  });

  it('keeps the B0-250 product-key fallback keyed on LINE evidence, so a knowledge hit cannot mask an empty SKU search', async () => {
    stubSearches({ productKeyScoped: [], line: lineMatches, knowledge: knowledgeMatches });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: PROCEDURAL_QUERY,
      productLineKey: LINE,
      productKey: 'SKU-1',
      limit: 6,
      proceduralIntent: true,
    });

    expect(result.retrieval.usedProductKeyFallback).toBe(true);
    expect(identity(result.sources)).toEqual(['doc-l1/l1', 'doc-k1/k1', 'doc-k2/k2']);
    expect(result.retrieval.usedKnowledgeSupplement).toBe(true);
  });
});

describe('B0-873 — broad probe declines to lock when a knowledge document is the top hit', () => {
  it('goes broad_only with skipped_knowledge_top_hit and keeps the knowledge document', async () => {
    stubSearches({
      broad: [
        match({ chunk_id: 'p1', similarity: 0.7 }),
        knowledge({ chunk_id: 'k1', similarity: 0.75 }),
        match({ chunk_id: 'p2', similarity: 0.4, product_line_key: OTHER_LINE }),
      ],
      line: [match({ chunk_id: 'a1', similarity: 0.9 })],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'what stripping and finish products should I use for my VCT floor',
    });

    expect(vi.mocked(searchProductChunks)).toHaveBeenCalledTimes(1);
    expect(result.retrieval.strategy).toBe('broad_only');
    expect(result.retrieval.productLineResolution?.lockReason).toBe('skipped_knowledge_top_hit');
    expect(result.retrieval.productLineResolution?.lockedProductLineKey).toBeNull();
    expect(result.retrieval.explicitKeySource).toBeNull();
    expect(identity(result.sources)).toContain('doc-k1/k1');
  });

  it('still locks (anchored_only) when the product document outranks every knowledge chunk', async () => {
    stubSearches({
      broad: [
        match({ chunk_id: 'p1', similarity: 0.71 }),
        knowledge({ chunk_id: 'k1', similarity: 0.41 }),
      ],
      line: [
        match({ chunk_id: 'a1', similarity: 0.9, document_kind: 'label' }),
        match({ chunk_id: 'a2', similarity: 0.8, document_kind: 'sds', section_type: 'hazard' }),
      ],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({ query: 'triforce contact time' });

    expect(result.retrieval.strategy).toBe('anchored_only');
    expect(result.retrieval.productLineResolution?.lockReason).toBe('high_confidence');
    expect(result.retrieval.productLineResolution?.lockedProductLineKey).toBe(LINE);
  });
});

describe('B0-873 — unlocked knowledge supplement on the broad-probe-locked (anchored) path', () => {
  it('merges the supplement into the anchored pool and reports it', async () => {
    stubSearches({
      broad: [
        match({ chunk_id: 'p1', similarity: 0.71 }),
        knowledge({ chunk_id: 'k1', similarity: 0.41 }),
      ],
      line: [
        match({ chunk_id: 'a1', similarity: 0.9, document_kind: 'label' }),
        match({ chunk_id: 'a2', similarity: 0.8, document_kind: 'sds', section_type: 'hazard' }),
      ],
      knowledge: [knowledge({ chunk_id: 'k9', similarity: 0.7 })],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'what steps should I follow to apply this finish',
      limit: 6,
      proceduralIntent: true,
    });

    expect(vi.mocked(searchProductChunks)).toHaveBeenCalledTimes(3);
    expect(result.retrieval.strategy).toBe('anchored_only');
    expect(result.retrieval.usedKnowledgeSupplement).toBe(true);
    expect(result.retrieval.knowledgeSupplementCuratedCount).toBe(1);
    expect(identity(result.sources)).toContain('doc-k9/k9');
    expect(identity(result.sources)).toContain('doc-a1/a1');
    expect(result.retrieval.searchMs).toBe(30);
  });

  it('does not run the supplement at all when nothing locks', async () => {
    stubSearches({
      broad: [match({ chunk_id: 'p1', similarity: 0.45 })],
      knowledge: [knowledge({ chunk_id: 'k9', similarity: 0.7 })],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'what steps should I follow to apply this finish',
      proceduralIntent: true,
    });

    expect(result.retrieval.strategy).toBe('broad_only');
    expect(knowledgeSearchCalls()).toHaveLength(0);
    expect(result.retrieval.usedKnowledgeSupplement).toBe(false);
  });
});

describe('B0-874 — sibling expansion of the top knowledge source', () => {
  /**
   * SZ#11 shape: one FAQ document contributes chunk 10 to the curated set (the winner under
   * `maxPerDocument: 1`), while chunks 1 and 2 of the same document sit in the pool just below it.
   */
  const faqPool = [
    knowledge({ chunk_id: 'k10', document_id: 'doc-K', document_title: 'FAQ Guide', chunk_index: 10, similarity: 0.8 }),
    knowledge({ chunk_id: 'k1', document_id: 'doc-K', document_title: 'FAQ Guide', chunk_index: 1, similarity: 0.79 }),
    knowledge({ chunk_id: 'k2', document_id: 'doc-K', document_title: 'FAQ Guide', chunk_index: 2, similarity: 0.5 }),
    knowledge({ chunk_id: 'o1', document_id: 'doc-O', document_title: 'Other Guide', chunk_index: 0, similarity: 0.6 }),
  ];

  it('re-assembles the top knowledge source from its pooled sibling indexes, leaving other sources alone', async () => {
    stubSearches({ broad: faqPool });
    vi.mocked(assembleChunkIndexSetBody).mockResolvedValue({
      documentId: 'doc-K',
      body: 'expanded FAQ body',
      chunkCount: 7,
      totalChars: 17,
      truncated: false,
      estimatedTokens: 300,
      chunkIds: ['K0', 'K1', 'K2', 'K3', 'K4', 'K8', 'K9'],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'what humidity and temperature should the gym be at',
      limit: 6,
      proceduralIntent: true,
    });

    expect(result.retrieval.strategy).toBe('broad_only');
    // Still one slot per document — depth for one document, not a `maxPerDocument` increase.
    expect(identity(result.sources)).toEqual(['doc-K/k10', 'doc-O/o1']);

    expect(vi.mocked(assembleChunkIndexSetBody)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(assembleChunkIndexSetBody)).toHaveBeenCalledWith(
      { documentId: 'doc-K', chunkIndexes: [1, 2, 10] },
      { radius: 2, maxChars: 8_000 },
    );

    const [faq, other] = result.sources;
    expect(faq?.documentBody).toBe('expanded FAQ body');
    expect(faq?.documentBodyChunkCount).toBe(7);
    expect(faq?.documentBodyChunkIds).toEqual(['K0', 'K1', 'K2', 'K3', 'K4', 'K8', 'K9']);
    expect(faq?.documentBodyTokenEstimate).toBe(300);
    // Matched-chunk identity and score are preserved for citation/telemetry.
    expect(faq?.chunkId).toBe('k10');
    expect(faq?.similarity).toBe(0.8);
    expect(other?.documentBody).toBe('assembled body for doc-O');
    expect(other?.documentBodyChunkIds).toEqual(['chunk-of-doc-O']);

    expect(result.retrieval.knowledgeSiblingExpansion).toEqual({
      documentId: 'doc-K',
      title: 'FAQ Guide',
      chunkIndexes: [1, 2, 10],
    });
  });

  it('does not expand when the highest-similarity source is not a knowledge document', async () => {
    stubSearches({
      broad: [
        match({ chunk_id: 'p1', similarity: 0.45 }),
        knowledge({ chunk_id: 'k1', similarity: 0.4 }),
      ],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'how often should I recoat',
      proceduralIntent: true,
    });

    expect(result.retrieval.productLineResolution?.lockReason).toBe('skipped_low_confidence');
    expect(vi.mocked(assembleChunkIndexSetBody)).not.toHaveBeenCalled();
    expect(result.retrieval.knowledgeSiblingExpansion).toBeNull();
  });

  /**
   * SZ#11 is NOT procedural by phrasing (`classifyRetrievalIntent` returns the bare default), yet
   * three chunks of the FAQ guide sit in the pool. The ranking's own corroboration triggers the
   * expansion.
   */
  it('expands without proceduralIntent when two or more pooled chunks corroborate the document', async () => {
    stubSearches({ broad: faqPool });
    vi.mocked(assembleChunkIndexSetBody).mockResolvedValue({
      documentId: 'doc-K',
      body: 'expanded FAQ body',
      chunkCount: 5,
      totalChars: 17,
      truncated: false,
      estimatedTokens: 200,
      chunkIds: ['K0', 'K1', 'K2', 'K3', 'K10'],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'what humidity and temperature should the gym be at',
    });

    expect(vi.mocked(assembleChunkIndexSetBody)).toHaveBeenCalledWith(
      { documentId: 'doc-K', chunkIndexes: [1, 2, 10] },
      { radius: 2, maxChars: 8_000 },
    );
    expect(result.retrieval.knowledgeSiblingExpansion?.chunkIndexes).toEqual([1, 2, 10]);
    expect(result.sources[0]?.documentBody).toBe('expanded FAQ body');
  });

  it('does not expand without proceduralIntent when only one chunk of the top document is pooled', async () => {
    stubSearches({
      broad: [
        knowledge({ chunk_id: 'k10', document_id: 'doc-K', chunk_index: 10, similarity: 0.8 }),
        knowledge({ chunk_id: 'o1', document_id: 'doc-O', chunk_index: 0, similarity: 0.6 }),
      ],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'what humidity and temperature should the gym be at',
    });

    expect(vi.mocked(assembleChunkIndexSetBody)).not.toHaveBeenCalled();
    expect(result.retrieval.knowledgeSiblingExpansion).toBeNull();
    expect(result.sources[0]?.documentBody).toBe('assembled body for doc-K');
  });

  it('expands a single pooled chunk only under proceduralIntent', async () => {
    stubSearches({
      broad: [
        knowledge({ chunk_id: 'k10', document_id: 'doc-K', chunk_index: 10, similarity: 0.8 }),
        knowledge({ chunk_id: 'o1', document_id: 'doc-O', chunk_index: 0, similarity: 0.6 }),
      ],
    });
    vi.mocked(assembleChunkIndexSetBody).mockResolvedValue({
      documentId: 'doc-K',
      body: 'expanded body',
      chunkCount: 5,
      totalChars: 13,
      truncated: false,
      estimatedTokens: 100,
      chunkIds: ['K8', 'K9', 'K10', 'K11', 'K12'],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'how often should this be done',
      proceduralIntent: true,
    });

    expect(vi.mocked(assembleChunkIndexSetBody)).toHaveBeenCalledWith(
      { documentId: 'doc-K', chunkIndexes: [10] },
      { radius: 2, maxChars: 8_000 },
    );
    expect(result.retrieval.knowledgeSiblingExpansion?.chunkIndexes).toEqual([10]);
  });

  it('leaves the source untouched when the expansion would not add a chunk', async () => {
    stubSearches({ broad: faqPool });
    vi.mocked(assembleChunkIndexSetBody).mockResolvedValue({
      documentId: 'doc-K',
      body: 'same single chunk',
      chunkCount: 1,
      totalChars: 17,
      truncated: false,
      estimatedTokens: 12,
      chunkIds: ['K10'],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'what humidity and temperature should the gym be at',
      proceduralIntent: true,
    });

    expect(result.retrieval.knowledgeSiblingExpansion).toBeNull();
    expect(result.sources[0]?.documentBody).toBe('assembled body for doc-K');
  });
});
