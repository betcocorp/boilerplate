import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RagSearchMatch } from '~/lib/rag/search';
import type { ProductLineFacts } from '~/lib/retrieval/product-facts';

/**
 * B0-700 — "What is the dilution ratio for Ready-To-Use Multi-Purpose Cleaner?" resolved to NO
 * product line, yet the model answered with Betco Citrus Cleaner and Degreaser's dilution ratios,
 * disclosing the substitution rather than declining. Live trace (workflow run
 * 3e13adc4-2fd6-4dd4-a3da-42f641bee103): the speculative pre-fetch's broad, unlocked search top-
 * ranked "Citrus Kitchen Degreaser" at 0.677 vs. two other candidates at 0.669/0.667 — a spread
 * B0-693 (commit c95c2874) now correctly refuses to lock ("skipped_ambiguous"/no lock) — but the
 * structured `factsForSources` enrichment had NO awareness of the lock outcome at all: it built
 * `entityContextBlock`/`factsBlock` from whichever entities the (still merely CANDIDATE, unlocked)
 * curated sources happened to carry, exactly like `withholdUnanchoredSafetySources` used to do for
 * SDS pre-B0-556. This file locks in the fix: `factsForSources` is now gated by the SAME resolved-
 * line outcome, so no structured dilution/efficacy fact can be attributed to an entity that wasn't
 * provably the one this query resolved to.
 */

vi.mock('~/lib/rag/search', () => ({ searchProductChunks: vi.fn() }));
vi.mock('~/supabase/clients/service-role', () => ({ getSupabaseServiceRoleClient: vi.fn() }));
vi.mock('~/lib/retrieval/document-assembly', () => ({
  assembleNeighborChunkBodies: vi.fn(),
  chunkWindowKey: (r: { documentId: string; chunkIndex: number }) =>
    `${r.documentId}:${r.chunkIndex}`,
  fetchDocumentSourceRefs: vi.fn(),
}));
vi.mock('~/lib/rag/entity-context', () => ({
  fetchEntityContexts: vi.fn(async () => new Map()),
  buildEntityContextBlock: vi.fn(() => null),
}));
vi.mock('~/lib/retrieval/product-facts', () => ({
  fetchProductLineFacts: vi.fn(),
  buildFactsBlock: vi.fn(
    (facts: Map<string, ProductLineFacts>) => (facts.size > 0 ? 'FACTS_BLOCK_RENDERED' : null),
  ),
}));
// B0-757 (concurrent, unrelated ticket) moved the product-line-lock thresholds to a settings-table
// lookup consulted by the one production call site. Mocked here to the same numeric defaults that
// module documents as its fallback, so this test doesn't depend on a live settings table and stays
// stable regardless of that ticket's own in-progress state.
vi.mock('~/lib/settings/settings-service', () => ({
  getProductLineLockThresholds: vi.fn(async () => ({
    minLockSimilarity: 0.5,
    minLockMargin: 0.06,
    highConfidenceAbsolute: 0.64,
  })),
}));

import { searchProductChunks } from '~/lib/rag/search';
import { fetchProductLineFacts } from '~/lib/retrieval/product-facts';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import {
  assembleNeighborChunkBodies,
  fetchDocumentSourceRefs,
} from '~/lib/retrieval/document-assembly';

import { ragQueryForProductKnowledgeWithMeta } from '~/lib/retrieval/product-knowledge';

const RTU_MULTI_PURPOSE_LINE = '7603AB8B-9498-4BEA-A3BB-4672FB3E8606';
const CITRUS_DEGREASER_LINE = '375AF9DA-B2DB-4667-854F-5E3B43B2BC36';
const CITRUS_ENTITY = 'entity-citrus-degreaser';
const CITRUS_FACTS: ProductLineFacts = {
  entityId: CITRUS_ENTITY,
  dilutionOzPerGal: 3,
  dilutionDisplay: '2-4 oz/gal',
  coverageSqFt: 3200,
  chemistryClass: null,
  productApplication: null,
  productApplicationConfidence: null,
  epaRegistration: null,
  contactTimeSeconds: null,
  confidence: 1,
  efficacy: [],
};

function installSupabaseStub() {
  vi.mocked(getSupabaseServiceRoleClient).mockReturnValue({
    schema: () => ({
      from: () => ({
        select: () => ({ in: () => ({ filter: () => Promise.resolve({ data: [], error: null }) }) }),
      }),
      rpc: async () => ({ data: [], error: null }),
    }),
  } as unknown as ReturnType<typeof getSupabaseServiceRoleClient>);
}

function match(overrides: Partial<RagSearchMatch> & { chunk_id: string; document_id: string }): RagSearchMatch {
  return {
    chunk_key: `key-${overrides.chunk_id}`,
    chunk_index: 0,
    heading: null,
    chunk_text: `text for ${overrides.chunk_id}`,
    section_path: null,
    section_type: 'label',
    token_count: 20,
    document_key: `dockey-${overrides.document_id}`,
    document_title: `Document ${overrides.document_id}`,
    entity_id: `entity-${overrides.document_id}`,
    product_key: null,
    sku: null,
    product_line_key: null,
    source_pk: `pk-${overrides.document_id}`,
    document_kind: 'product_line_profile',
    similarity: 0.5,
    ...overrides,
  } as RagSearchMatch;
}

function searchResult(matches: RagSearchMatch[]) {
  return {
    matches,
    embeddingSource: 'new-embedding' as const,
    timings: { similaritySearchMs: 1 },
  } as unknown as Awaited<ReturnType<typeof searchProductChunks>>;
}

function stubSearches(byPass: { broad: RagSearchMatch[]; anchored?: RagSearchMatch[] }) {
  vi.mocked(searchProductChunks).mockImplementation(async (options) =>
    searchResult(options.productLineKey ? (byPass.anchored ?? []) : byPass.broad),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  installSupabaseStub();
  vi.mocked(assembleNeighborChunkBodies).mockImplementation(
    async (requests: Array<{ documentId: string; chunkIndex: number }>) =>
      new Map(
        requests.map((r) => [
          `${r.documentId}:${r.chunkIndex}`,
          { body: `assembled body for ${r.documentId}`, chunkCount: 1, truncated: false, estimatedTokens: 12, chunkIds: [`chunk-of-${r.documentId}`] },
        ]),
      ),
  );
  vi.mocked(fetchDocumentSourceRefs).mockResolvedValue(new Map());
  // Argument-aware: only returns facts for entity ids actually requested, mirroring the real
  // `fetchProductLineFacts` — a static mock would mask exactly the bug this file guards against
  // (facts leaking would look identical to facts correctly filtered to an empty request).
  vi.mocked(fetchProductLineFacts).mockImplementation(async (entityIds: string[]) => {
    const all = new Map([[CITRUS_ENTITY, CITRUS_FACTS]]);
    const requested = new Set(entityIds);
    return new Map([...all].filter(([id]) => requested.has(id)));
  });
});

describe('B0-700 — an unlocked/ambiguous query must not surface another product line\'s structured facts', () => {
  it('produces no factsBlock at all when nothing resolved (broad_only), even though a candidate source has facts', async () => {
    stubSearches({
      broad: [
        match({
          chunk_id: 'chunk-citrus',
          document_id: 'doc-citrus-degreaser',
          entity_id: CITRUS_ENTITY,
          product_line_key: CITRUS_DEGREASER_LINE,
          similarity: 0.677,
        }),
        match({
          chunk_id: 'chunk-other',
          document_id: 'doc-other-line',
          entity_id: 'entity-other-line',
          product_line_key: 'ANOTHER-LINE-KEY',
          similarity: 0.669,
        }),
      ],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'What is the dilution ratio for Ready-To-Use Multi-Purpose Cleaner?',
    });

    expect(result.retrieval.strategy).toBe('broad_only');
    expect(result.retrieval.productLineResolution?.lockedProductLineKey).toBeNull();
    // The reported defect: Citrus Cleaner and Degreaser's dilution must not reach the model as a
    // "Verified Product Facts" block, even though its document is still a visible candidate source.
    expect(result.sources.map((s) => s.documentId)).toContain('doc-citrus-degreaser');
    expect(result.facts.size).toBe(0);
    expect(result.factsBlock).toBeNull();
  });

  it('keeps facts for the locked line but strips an off-line sibling that arrived via the broad fallback', async () => {
    const lockedEntity = 'entity-rtu-locked';
    const lockedFacts: ProductLineFacts = { ...CITRUS_FACTS, entityId: lockedEntity, dilutionOzPerGal: 99 };
    vi.mocked(fetchProductLineFacts).mockImplementation(async (entityIds: string[]) => {
      const all = new Map([
        [CITRUS_ENTITY, CITRUS_FACTS],
        [lockedEntity, lockedFacts],
      ]);
      const requested = new Set(entityIds);
      return new Map([...all].filter(([id]) => requested.has(id)));
    });
    stubSearches({
      // A wide, unambiguous margin (0.95 vs. 0.80 — well over MIN_LOCK_MARGIN) so the RTU line
      // genuinely locks; the Citrus Degreaser doc is a much weaker broad-pass match, not a
      // close/ambiguous runner-up — it only reaches the model because `anchored: []` below forces
      // the broad-fallback path, exactly the B0-556 scenario this mirrors for structured facts.
      broad: [
        match({
          chunk_id: 'chunk-rtu-profile',
          document_id: 'doc-rtu-profile',
          entity_id: lockedEntity,
          product_line_key: RTU_MULTI_PURPOSE_LINE,
          similarity: 0.95,
        }),
        match({
          chunk_id: 'chunk-citrus-fallback',
          document_id: 'doc-citrus-degreaser',
          entity_id: CITRUS_ENTITY,
          product_line_key: CITRUS_DEGREASER_LINE,
          similarity: 0.8,
        }),
      ],
      anchored: [],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'What is the dilution ratio for Ready-To-Use Multi-Purpose Cleaner?',
    });

    expect(result.retrieval.strategy).toBe('anchored_with_broad_fallback');
    expect(result.retrieval.productLineResolution?.lockedProductLineKey).toBe(RTU_MULTI_PURPOSE_LINE);
    expect(result.facts.has(lockedEntity)).toBe(true);
    expect(result.facts.has(CITRUS_ENTITY)).toBe(false);
  });

  it('does not touch the explicit-key path even when a legitimately-anchored source has a null productLineKey', async () => {
    stubSearches({
      broad: [],
      anchored: [
        match({
          chunk_id: 'chunk-null-line-key',
          document_id: 'doc-null-line-key',
          entity_id: CITRUS_ENTITY,
          product_line_key: null, // RPC also matches on source_record.source_pk
          source_pk: RTU_MULTI_PURPOSE_LINE,
          similarity: 0.8,
        }),
      ],
    });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: 'dilution ratio',
      productLineKey: RTU_MULTI_PURPOSE_LINE,
    });

    expect(result.retrieval.strategy).toBe('explicit_product_line');
    expect(result.facts.has(CITRUS_ENTITY)).toBe(true);
    expect(result.factsBlock).toBe('FACTS_BLOCK_RENDERED');
  });
});
