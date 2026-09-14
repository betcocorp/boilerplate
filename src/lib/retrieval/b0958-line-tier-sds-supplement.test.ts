import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RagSearchMatch } from '~/lib/rag/search';

/**
 * B0-958 — "Is BestScent Lemon Zest still good after sitting in storage for a year?" (run
 * 61e80e45, row 18) missed the tier-1 concept "cite the SDS" although line `226` ("Concentrated
 * Deodorizing Liquid") carries ten current SDS. Verified live 2026-09-14:
 *
 *   - the product-tier entity "Best Scent Lemon Zest" resolves via `product_tier_title_exact` to
 *     `product_line_key 67385609-…` with `product_key 22604`;
 *   - `match_corpus_chunks_hybrid(…, filter_product_line_key = that line, filter_product_key =
 *     '22604')` returns ONLY the product's own label (6 chunks). The SDS titled `226`, `226 AC`,
 *     `226 DIL`… hang off the LINE-tier entity, whose `product_key` is NULL, so the RPC's
 *     product-key predicate structurally excludes them;
 *   - the same call without `filter_product_key` returns the SDS family.
 *
 * Fix under test: the explicit-key path runs a line-scoped pass alongside the SKU-scoped one and,
 * when the SKU pool is missing a required kind that only exists at the line tier (`sds`,
 * `product_line_profile`), merges the line pool in before curation (`usedLineKindSupplement`, the
 * B0-556 flag that was documented but never set). Both passes are filtered by the same line key in
 * SQL, so no other product line's document can enter.
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
  fetchEntityContexts: vi.fn(),
  buildEntityContextBlock: vi.fn(() => null),
}));
vi.mock('~/lib/retrieval/product-facts', () => ({
  fetchProductLineFacts: vi.fn(),
  buildFactsBlock: vi.fn(() => null),
}));

import { searchProductChunks } from '~/lib/rag/search';
import { fetchEntityContexts } from '~/lib/rag/entity-context';
import {
  assembleNeighborChunkBodies,
  fetchDocumentSourceRefs,
} from '~/lib/retrieval/document-assembly';
import { fetchProductLineFacts } from '~/lib/retrieval/product-facts';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import { ragQueryForProductKnowledgeWithMeta } from '~/lib/retrieval/product-knowledge';

/** Real values from the live `rag` schema (see the module doc). */
const LINE_226 = '67385609-6E07-4B67-B1F2-203E4A28B2BB';
const LEMON_ZEST_PRODUCT_KEY = '22604';
const LEMON_ZEST_LABEL_DOC = 'bf334e7b-515c-43ff-9861-f3d12066b0ca';
const SDS_226_DOC = '3ef4fc9e-fb95-4f8b-ae02-a91c7e059e14';
const PROFILE_226_DOC = 'ebbad3b1-b857-4356-a3f7-93e108989009';

const SAFETY_QUERY = 'Best Scent Lemon Zest safety hazards PPE SDS precautions first aid';

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

function match(
  overrides: Partial<RagSearchMatch> & { chunk_id: string; document_id: string },
): RagSearchMatch {
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
    product_line_key: LINE_226,
    source_pk: `pk-${overrides.document_id}`,
    document_kind: 'label',
    similarity: 0.5,
    ...overrides,
  } as RagSearchMatch;
}

const lemonZestLabel = match({
  chunk_id: 'chunk-label',
  document_id: LEMON_ZEST_LABEL_DOC,
  document_kind: 'label',
  document_title: 'Best Scent Lemon Zest',
  product_key: LEMON_ZEST_PRODUCT_KEY,
  similarity: 0.66,
});

const sds226 = match({
  chunk_id: 'chunk-sds-226',
  document_id: SDS_226_DOC,
  document_kind: 'sds',
  section_type: 'handling_storage',
  document_title: '226',
  chunk_text: 'Product: 226\nSection 7. Handling and storage…',
  similarity: 0.58,
});

const profile226 = match({
  chunk_id: 'chunk-profile-226',
  document_id: PROFILE_226_DOC,
  document_kind: 'product_line_profile',
  document_title: 'Concentrated Deodorizing Liquid',
  similarity: 0.52,
});

function searchResult(matches: RagSearchMatch[]) {
  return {
    matches,
    embeddingSource: 'new-embedding' as const,
    timings: { similaritySearchMs: 1 },
    lexicalOnlyCandidateCount: 0,
  } as unknown as Awaited<ReturnType<typeof searchProductChunks>>;
}

/**
 * SKU pass = productLineKey + productKey; line pass = productLineKey only; anything else
 * (unlocked knowledge supplement, broad probe) returns nothing.
 */
function stubSearches(byPass: { sku: RagSearchMatch[]; line: RagSearchMatch[] }) {
  vi.mocked(searchProductChunks).mockImplementation(async (options) => {
    if (options.productLineKey && options.productKey) return searchResult(byPass.sku);
    if (options.productLineKey) return searchResult(byPass.line);
    return searchResult([]);
  });
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
            body: `assembled body for ${r.documentId}`,
            chunkCount: 1,
            truncated: false,
            estimatedTokens: 12,
            chunkIds: [`chunk-of-${r.documentId}`],
          },
        ]),
      ),
  );
  vi.mocked(fetchDocumentSourceRefs).mockResolvedValue(new Map());
  vi.mocked(fetchEntityContexts).mockResolvedValue(new Map());
  vi.mocked(fetchProductLineFacts).mockResolvedValue(new Map());
});

function runLemonZest() {
  return ragQueryForProductKnowledgeWithMeta({
    query: SAFETY_QUERY,
    productLineKey: LINE_226,
    productKey: LEMON_ZEST_PRODUCT_KEY,
    productLineKeySource: 'product_tier_title_exact',
    sectionType: null,
  });
}

describe('B0-958 — a product-tier name reaches its line-tier SDS', () => {
  it('merges the line-scoped pool when the SKU pool has no SDS, and the SDS is cited', async () => {
    stubSearches({ sku: [lemonZestLabel], line: [sds226, profile226] });

    const result = await runLemonZest();

    expect(result.retrieval.strategy).toBe('explicit_product_line');
    expect(result.retrieval.usedLineKindSupplement).toBe(true);
    expect(result.retrieval.usedProductKeyFallback).toBe(false);
    const byKind = new Map(result.sources.map((s) => [s.documentKind, s.documentId]));
    expect(byKind.get('label')).toBe(LEMON_ZEST_LABEL_DOC);
    expect(byKind.get('sds')).toBe(SDS_226_DOC);
    // Every source is on the resolved line — the supplement cannot introduce another line's doc.
    for (const source of result.sources) {
      expect(source.productLineKey).toBe(LINE_226);
    }
  });

  it('runs the line pass with the same line key and NO product key, concurrently (one call each)', async () => {
    stubSearches({ sku: [lemonZestLabel], line: [sds226] });

    await runLemonZest();

    const calls = vi.mocked(searchProductChunks).mock.calls.map(([options]) => options);
    const skuCalls = calls.filter((o) => o.productLineKey === LINE_226 && o.productKey);
    const lineCalls = calls.filter((o) => o.productLineKey === LINE_226 && !o.productKey);
    expect(skuCalls).toHaveLength(1);
    expect(lineCalls).toHaveLength(1);
    expect(lineCalls[0]?.productKey).toBeUndefined();
    expect(lineCalls[0]?.scope).toBe('all');
  });

  it('does not merge when the SKU pool already carries the line-tier kinds', async () => {
    stubSearches({ sku: [lemonZestLabel, sds226, profile226], line: [sds226, profile226] });

    const result = await runLemonZest();

    expect(result.retrieval.usedLineKindSupplement).toBe(false);
    expect(result.sources.map((s) => s.documentId)).toContain(SDS_226_DOC);
  });

  it('keeps the B0-250 fallback: an empty SKU pool hands over to the line pool wholesale', async () => {
    stubSearches({ sku: [], line: [sds226, profile226] });

    const result = await runLemonZest();

    expect(result.retrieval.usedProductKeyFallback).toBe(true);
    expect(result.retrieval.usedLineKindSupplement).toBe(false);
    expect(result.sources.map((s) => s.documentId)).toContain(SDS_226_DOC);
    // The line pass already ran concurrently; the fallback must not issue a second one.
    const lineCalls = vi
      .mocked(searchProductChunks)
      .mock.calls.filter(([o]) => o.productLineKey === LINE_226 && !o.productKey);
    expect(lineCalls).toHaveLength(1);
  });

  it('issues no line pass at all when no product key was resolved (line-tier anchor)', async () => {
    stubSearches({ sku: [], line: [sds226, profile226] });

    const result = await ragQueryForProductKnowledgeWithMeta({
      query: SAFETY_QUERY,
      productLineKey: LINE_226,
      productKey: null,
      productLineKeySource: 'alias_exact',
      sectionType: null,
    });

    expect(result.retrieval.usedLineKindSupplement).toBe(false);
    expect(vi.mocked(searchProductChunks)).toHaveBeenCalledTimes(1);
  });
});
