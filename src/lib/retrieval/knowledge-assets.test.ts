import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * B0-529 — the retrieval behind `get_dispenser_asset` / `get_floor_asset`.
 *
 * The load-bearing properties are (a) the search is HARD-scoped to the knowledge corpus, (b) one
 * source per document, best match wins, and (c) regulated values in a body are passed through
 * byte-for-byte.
 */

vi.mock('~/lib/rag/search', () => ({
  searchProductChunks: vi.fn(),
}));

vi.mock('~/lib/retrieval/document-assembly', () => ({
  assembleDocumentBodies: vi.fn(),
  fetchDocumentSourceRefs: vi.fn(async () => new Map()),
}));

import { searchProductChunks } from '~/lib/rag/search';
import {
  assembleDocumentBodies,
  fetchDocumentSourceRefs,
} from '~/lib/retrieval/document-assembly';
import {
  buildKnowledgeAssetQuery,
  MAX_KNOWLEDGE_ASSET_RESULTS,
  retrieveKnowledgeAssets,
} from '~/lib/retrieval/knowledge-assets';

/** A coat-count line with the kind of regulated values these tools must never reformat. */
const COAT_COUNT_BODY =
  '## Application\nApply 4 coats of finish at 2000 sq ft/gal. Allow 30 minutes between coats.\nDilute 4 oz/gal for the top scrub step.';

function match(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    chunk_id: 'chunk-1',
    chunk_key: 'ck-1',
    chunk_index: 0,
    heading: 'Application',
    chunk_text: COAT_COUNT_BODY,
    section_path: null,
    section_type: null,
    token_count: 40,
    document_id: 'doc-1',
    document_key: 'dk-1',
    document_title: 'floor finish coats guide',
    entity_id: null,
    product_key: null,
    sku: null,
    product_line_key: null,
    source_pk: 'sp-1',
    document_kind: 'knowledge',
    similarity: 0.7,
    ...overrides,
  };
}

function searchResult(matches: ReturnType<typeof match>[]) {
  return {
    query: 'q',
    model: 'text-embedding-3-large',
    limit: 12,
    productLineKey: null,
    productKey: null,
    sectionType: null,
    surfaceType: null,
    scope: 'knowledge',
    minSimilarity: null,
    retrieval_strategy: 'hybrid',
    embeddingSource: 'new-embedding',
    timings: {
      totalMs: 1,
      queryEmbeddingMs: 1,
      queryRewriteMs: 0,
      cacheLookupMs: 0,
      embeddingCreateMs: 0,
      cachePersistMs: 0,
      similaritySearchMs: 0,
      rerankMs: 0,
    },
    matches,
  };
}

function assembled(documentId: string, body: string, truncated = false) {
  return {
    documentId,
    body,
    chunkCount: 2,
    totalChars: body.length,
    truncated,
    estimatedTokens: null,
    chunkIds: [`${documentId}-c0`, `${documentId}-c1`],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchDocumentSourceRefs).mockResolvedValue(new Map());
});

describe('buildKnowledgeAssetQuery', () => {
  it('joins the supplied fields and drops empty ones', () => {
    expect(buildKnowledgeAssetQuery(['VCT', undefined, ' coat count ', null, 'anchor'])).toBe(
      'VCT coat count anchor',
    );
  });

  it('collapses internal whitespace', () => {
    expect(buildKnowledgeAssetQuery(['vinyl   composition  tile'])).toBe(
      'vinyl composition tile',
    );
  });
});

describe('retrieveKnowledgeAssets (B0-529)', () => {
  it('hard-scopes the search to the knowledge corpus', async () => {
    vi.mocked(searchProductChunks).mockResolvedValue(
      searchResult([match()]) as unknown as Awaited<ReturnType<typeof searchProductChunks>>,
    );
    vi.mocked(assembleDocumentBodies).mockResolvedValue(
      new Map([['doc-1', assembled('doc-1', COAT_COUNT_BODY)]]),
    );

    await retrieveKnowledgeAssets({ query: 'how many coats on VCT' });

    expect(searchProductChunks).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'knowledge', useHybrid: true }),
    );
  });

  it('over-fetches candidate chunks so `limit` distinct DOCUMENTS are reachable', async () => {
    vi.mocked(searchProductChunks).mockResolvedValue(
      searchResult([match()]) as unknown as Awaited<ReturnType<typeof searchProductChunks>>,
    );
    vi.mocked(assembleDocumentBodies).mockResolvedValue(new Map());

    await retrieveKnowledgeAssets({ query: 'q', limit: 3 });

    const call = vi.mocked(searchProductChunks).mock.calls[0][0];
    expect(call.limit).toBeGreaterThan(3);
  });

  it('returns one source per document, keeping the best-scoring chunk', async () => {
    vi.mocked(searchProductChunks).mockResolvedValue(
      searchResult([
        match({ chunk_id: 'a', document_id: 'doc-1', similarity: 0.4 }),
        match({ chunk_id: 'b', document_id: 'doc-1', similarity: 0.9 }),
        match({ chunk_id: 'c', document_id: 'doc-2', similarity: 0.6 }),
      ]) as unknown as Awaited<ReturnType<typeof searchProductChunks>>,
    );
    vi.mocked(assembleDocumentBodies).mockResolvedValue(
      new Map([
        ['doc-1', assembled('doc-1', COAT_COUNT_BODY)],
        ['doc-2', assembled('doc-2', 'other')],
      ]),
    );

    const result = await retrieveKnowledgeAssets({ query: 'q' });

    expect(result.sources.map((s) => s.documentId)).toEqual(['doc-1', 'doc-2']);
    expect(result.sources[0].chunkId).toBe('b');
    expect(result.sources[0].similarity).toBe(0.9);
    expect(result.retrieval.selection.uniqueDocuments).toBe(2);
  });

  it('clamps `limit` to the documented ceiling', async () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      match({ chunk_id: `c${i}`, document_id: `doc-${i}`, similarity: 1 - i / 100 }),
    );
    vi.mocked(searchProductChunks).mockResolvedValue(
      searchResult(many) as unknown as Awaited<ReturnType<typeof searchProductChunks>>,
    );
    vi.mocked(assembleDocumentBodies).mockResolvedValue(new Map());

    const result = await retrieveKnowledgeAssets({ query: 'q', limit: 99 });

    expect(result.sources).toHaveLength(MAX_KNOWLEDGE_ASSET_RESULTS);
  });

  /** REGULATED DATA: coat counts, sq ft/gal, oz/gal and dwell times must survive byte-for-byte. */
  it('passes the assembled body through verbatim', async () => {
    vi.mocked(searchProductChunks).mockResolvedValue(
      searchResult([match()]) as unknown as Awaited<ReturnType<typeof searchProductChunks>>,
    );
    vi.mocked(assembleDocumentBodies).mockResolvedValue(
      new Map([['doc-1', assembled('doc-1', COAT_COUNT_BODY)]]),
    );

    const [source] = (await retrieveKnowledgeAssets({ query: 'q' })).sources;

    expect(source.documentBody).toBe(COAT_COUNT_BODY);
    expect(source.documentBody).toContain('4 coats');
    expect(source.documentBody).toContain('2000 sq ft/gal');
    expect(source.documentBody).toContain('4 oz/gal');
    expect(source.documentBody).toContain('30 minutes');
    expect(source.documentBodyTruncated).toBe(false);
  });

  it('reports truncation honestly rather than silently dropping a tail', async () => {
    vi.mocked(searchProductChunks).mockResolvedValue(
      searchResult([match()]) as unknown as Awaited<ReturnType<typeof searchProductChunks>>,
    );
    vi.mocked(assembleDocumentBodies).mockResolvedValue(
      new Map([['doc-1', assembled('doc-1', COAT_COUNT_BODY, true)]]),
    );

    const [source] = (await retrieveKnowledgeAssets({ query: 'q' })).sources;
    expect(source.documentBodyTruncated).toBe(true);
  });

  it('falls back to the matched chunk when assembly returns nothing for a document', async () => {
    vi.mocked(searchProductChunks).mockResolvedValue(
      searchResult([match()]) as unknown as Awaited<ReturnType<typeof searchProductChunks>>,
    );
    vi.mocked(assembleDocumentBodies).mockResolvedValue(new Map());

    const [source] = (await retrieveKnowledgeAssets({ query: 'q' })).sources;
    expect(source.documentBody).toBe(COAT_COUNT_BODY);
    expect(source.documentBodyChunkCount).toBe(1);
  });

  it('carries S3 provenance so a coat-count answer stays traceable', async () => {
    vi.mocked(searchProductChunks).mockResolvedValue(
      searchResult([match()]) as unknown as Awaited<ReturnType<typeof searchProductChunks>>,
    );
    vi.mocked(assembleDocumentBodies).mockResolvedValue(
      new Map([['doc-1', assembled('doc-1', COAT_COUNT_BODY)]]),
    );
    vi.mocked(fetchDocumentSourceRefs).mockResolvedValue(
      new Map([
        [
          'doc-1',
          { documentId: 'doc-1', s3Key: 'knowledge/floor.md', sourceUri: 's3://b/knowledge/floor.md' },
        ],
      ]),
    );

    const [source] = (await retrieveKnowledgeAssets({ query: 'q' })).sources;
    expect(source.s3Key).toBe('knowledge/floor.md');
    expect(source.sourceUri).toBe('s3://b/knowledge/floor.md');
  });

  /**
   * B0-1032 — a substrate-agnostic document with the best similarity must not take the slot from a
   * document tagged (by title) to the requested surface.
   */
  describe('substrate ranking preference (B0-1032)', () => {
    const CANDIDATES = [
      match({
        chunk_id: 'generic',
        document_id: 'generic-doc',
        document_title: 'floor maintenance frequency guide',
        similarity: 0.6978,
      }),
      match({
        chunk_id: 'vct-green',
        document_id: 'vct-green-doc',
        document_title: 'VCT Green Certified',
        similarity: 0.6773,
      }),
      match({
        chunk_id: 'vct-frequency',
        document_id: 'vct-frequency-doc',
        document_title: 'vct floor maintenance frequency betco standard',
        similarity: 0.6334,
      }),
    ];

    beforeEach(() => {
      vi.mocked(searchProductChunks).mockResolvedValue(
        searchResult(CANDIDATES) as unknown as Awaited<ReturnType<typeof searchProductChunks>>,
      );
      vi.mocked(assembleDocumentBodies).mockResolvedValue(new Map());
    });

    it('ranks the substrate-and-topic document ahead of the generic one', async () => {
      const result = await retrieveKnowledgeAssets({
        query: 'VCT top scrub and stripping frequency',
        limit: 3,
        substrate: { surfaceType: 'VCT', topic: 'top scrub and stripping frequency' },
      });

      const ids = result.sources.map((s) => s.documentId);
      expect(ids.indexOf('vct-frequency-doc')).toBeLessThan(ids.indexOf('generic-doc'));
      expect(ids[0]).toBe('vct-frequency-doc');
      expect(result.retrieval.selection.substratePreference?.boostedDocuments).toBe(2);
    });

    it('reorders only — the similarity it reports is the one retrieval produced', async () => {
      const result = await retrieveKnowledgeAssets({
        query: 'q',
        limit: 3,
        substrate: { surfaceType: 'VCT', topic: 'top scrub and stripping frequency' },
      });

      const byId = new Map(result.sources.map((s) => [s.documentId, s.similarity]));
      expect(byId.get('vct-frequency-doc')).toBe(0.6334);
      expect(byId.get('generic-doc')).toBe(0.6978);
      // Never a filter: every candidate document is still returned.
      expect(result.sources).toHaveLength(3);
    });

    it('asks for a deeper candidate pool only when a preference resolved', async () => {
      await retrieveKnowledgeAssets({ query: 'q', limit: 3 });
      expect(vi.mocked(searchProductChunks).mock.calls[0][0].limit).toBe(12);

      await retrieveKnowledgeAssets({ query: 'q', limit: 3, substrate: { surfaceType: 'VCT' } });
      expect(vi.mocked(searchProductChunks).mock.calls[1][0].limit).toBe(20);
    });

    it('is a no-op when the caller named no surface', async () => {
      const result = await retrieveKnowledgeAssets({
        query: 'q',
        limit: 3,
        substrate: { topic: 'top scrub frequency' },
      });

      expect(result.sources.map((s) => s.documentId)).toEqual([
        'generic-doc',
        'vct-green-doc',
        'vct-frequency-doc',
      ]);
      expect(result.retrieval.selection.substratePreference).toBeNull();
    });
  });

  it('rejects an empty query rather than searching the whole corpus', async () => {
    await expect(retrieveKnowledgeAssets({ query: '   ' })).rejects.toThrow(/query is required/);
    expect(searchProductChunks).not.toHaveBeenCalled();
  });
});
