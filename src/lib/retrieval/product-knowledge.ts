import { searchProductChunks, type RagSearchMatch } from '~/lib/rag/search';

import {
  resolveProductLineFromMatches,
  type ProductLineResolutionResult,
} from '~/lib/retrieval/product-line-resolution';
import {
  selectCuratedMatches,
  trimSnippet,
} from '~/lib/retrieval/source-selection';

export type CuratedSource = {
  documentId: string;
  chunkId: string;
  title: string;
  snippet: string;
  similarity: number;
  documentKind: string;
  productLineKey: string | null;
  productKey: string | null;
};

export type ProductKnowledgeRetrievalSummary = {
  cacheSource:
    | 'exact-cache-hit'
    | 'rewritten-cache-hit'
    | 'approximate-query-hit'
    | 'approximate-rewritten-hit'
    | 'new-embedding';
  strategy:
    | 'explicit_product_line'
    | 'broad_resolution_disabled'
    | 'broad_only'
    | 'anchored_only'
    | 'anchored_with_broad_fallback';
  searchMs: number;
  initialSearchMs: number;
  anchoredSearchMs: number | null;
  usedBroadFallback: boolean;
  broadCuratedCount: number;
  anchoredCuratedCount: number;
  productLineResolution?: ProductLineResolutionResult;
};

export type ProductKnowledgeQueryResult = {
  sources: CuratedSource[];
  retrieval: ProductKnowledgeRetrievalSummary;
};

function toCurated(m: RagSearchMatch): CuratedSource {
  return {
    documentId: m.document_id,
    chunkId: m.chunk_id,
    title: m.document_title || m.heading || m.document_key,
    snippet: trimSnippet(m.chunk_text, 900),
    similarity: m.similarity,
    documentKind: m.document_kind,
    productLineKey: m.product_line_key,
    productKey: m.product_key,
  };
}

export async function ragQueryForProductKnowledge(input: {
  query: string;
  limit?: number;
  productLineKey?: string | null;
  skipProductLineResolution?: boolean;
}): Promise<CuratedSource[]> {
  const result = await ragQueryForProductKnowledgeWithMeta(input);
  return result.sources;
}

export async function ragQueryForProductKnowledgeWithMeta(input: {
  query: string;
  limit?: number;
  productLineKey?: string | null;
  /** When true, skip candidate resolution (caller already anchored the query, e.g. by product id). */
  skipProductLineResolution?: boolean;
}): Promise<ProductKnowledgeQueryResult> {
  const limit = input.limit ?? 8;
  const explicitKey = input.productLineKey?.trim() || null;

  if (explicitKey) {
    const result = await searchProductChunks({
      query: input.query,
      limit,
      productLineKey: explicitKey,
      scope: 'all',
    });

    const curated = selectCuratedMatches(result.matches, {
      limit,
      requiredDocumentKinds: ['product_line_profile', 'sds'],
      maxPerDocument: 2,
    });

    return {
      sources: curated.map(toCurated),
      retrieval: {
        strategy: 'explicit_product_line',
        cacheSource: result.embeddingSource,
        searchMs: result.timings.similaritySearchMs,
        initialSearchMs: result.timings.similaritySearchMs,
        anchoredSearchMs: result.timings.similaritySearchMs,
        usedBroadFallback: false,
        broadCuratedCount: curated.length,
        anchoredCuratedCount: curated.length,
        productLineResolution: {
          candidates: [],
          lockedProductLineKey: explicitKey,
          lockReason: 'explicit_filter',
        },
      },
    };
  }

  if (input.skipProductLineResolution) {
    const result = await searchProductChunks({
      query: input.query,
      limit,
      scope: 'products',
    });

    const curated = selectCuratedMatches(result.matches, {
      limit,
      maxPerDocument: 2,
    });

    return {
      sources: curated.map(toCurated),
      retrieval: {
        strategy: 'broad_resolution_disabled',
        cacheSource: result.embeddingSource,
        searchMs: result.timings.similaritySearchMs,
        initialSearchMs: result.timings.similaritySearchMs,
        anchoredSearchMs: null,
        usedBroadFallback: false,
        broadCuratedCount: curated.length,
        anchoredCuratedCount: 0,
        productLineResolution: {
          candidates: [],
          lockedProductLineKey: null,
          lockReason: 'resolution_disabled',
        },
      },
    };
  }

  const probeLimit = Math.min(20, Math.max(limit * 2, 12));
  const broadResult = await searchProductChunks({
    query: input.query,
    limit: probeLimit,
    scope: 'all',
  });

  const resolution = resolveProductLineFromMatches(broadResult.matches);
  const broadCurated = selectCuratedMatches(broadResult.matches, {
    limit,
    requiredDocumentKinds: ['product_line_profile', 'sds'],
    maxPerDocument: 2,
  });

  if (resolution.lockedProductLineKey == null) {
    return {
      sources: broadCurated.map(toCurated),
      retrieval: {
        strategy: 'broad_only',
        cacheSource: broadResult.embeddingSource,
        searchMs: broadResult.timings.similaritySearchMs,
        initialSearchMs: broadResult.timings.similaritySearchMs,
        anchoredSearchMs: null,
        usedBroadFallback: false,
        broadCuratedCount: broadCurated.length,
        anchoredCuratedCount: 0,
        productLineResolution: resolution,
      },
    };
  }

  const anchoredLimit = Math.min(24, Math.max(limit * 3, 12));
  const anchoredResult = await searchProductChunks({
    query: input.query,
    limit: anchoredLimit,
    productLineKey: resolution.lockedProductLineKey,
    scope: 'all',
  });
  const anchoredCurated = selectCuratedMatches(anchoredResult.matches, {
    limit,
    requiredDocumentKinds: ['product_line_profile', 'sds'],
    maxPerDocument: 2,
  });

  const minimumAnchoredEvidence = Math.max(2, Math.ceil(limit / 2));
  const shouldUseBroadFallback =
    anchoredCurated.length === 0 ||
    (anchoredCurated.length < minimumAnchoredEvidence &&
      broadCurated.length > anchoredCurated.length);

  const finalCurated: RagSearchMatch[] = shouldUseBroadFallback
    ? broadCurated
    : anchoredCurated;
  const strategy = shouldUseBroadFallback
    ? 'anchored_with_broad_fallback'
    : 'anchored_only';
  const totalSearchMs =
    broadResult.timings.similaritySearchMs + anchoredResult.timings.similaritySearchMs;

  return {
    sources: finalCurated.map(toCurated),
    retrieval: {
      strategy,
      cacheSource: anchoredResult.embeddingSource,
      searchMs: totalSearchMs,
      initialSearchMs: broadResult.timings.similaritySearchMs,
      anchoredSearchMs: anchoredResult.timings.similaritySearchMs,
      usedBroadFallback: shouldUseBroadFallback,
      broadCuratedCount: broadCurated.length,
      anchoredCuratedCount: anchoredCurated.length,
      productLineResolution: resolution,
    },
  };
}
