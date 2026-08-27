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

  it('rejects an empty query rather than searching the whole corpus', async () => {
    await expect(retrieveKnowledgeAssets({ query: '   ' })).rejects.toThrow(/query is required/);
    expect(searchProductChunks).not.toHaveBeenCalled();
  });
});
