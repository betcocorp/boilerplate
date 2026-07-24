import { searchProductChunks, type RagSearchMatch } from '~/lib/rag/search';
import {
  buildEntityContextBlock,
  fetchEntityContexts,
} from '~/lib/rag/entity-context';

import {
  assembleDocumentBodies,
  type AssembledDocumentBody,
} from '~/lib/retrieval/document-assembly';
import {
  resolveProductLineFromMatches,
  type ProductLineResolutionResult,
} from '~/lib/retrieval/product-line-resolution';
import {
  selectCuratedMatches,
  trimSnippet,
} from '~/lib/retrieval/source-selection';
import {
  buildFactsBlock,
  fetchProductLineFacts,
  type ProductLineFacts,
} from '~/lib/retrieval/product-facts';

/**
 * The new RAG strategy returns at most this many sources, where each source is a
 * full document (assembled from every one of its chunks) rather than a single
 * fragmented chunk. The matches behind each source come from different parent
 * documents to maximize topical coverage.
 */
const DEFAULT_UNIQUE_DOCUMENT_LIMIT = 3;

/**
 * The first-pass similarity search needs to return enough candidates that we have
 * a fighting chance of producing N unique-document matches.
 */
const SIMILARITY_CANDIDATE_FETCH_LIMIT = 20;

/**
 * Enable cross-encoder reranking (rag/rerank.ts) on the product-support retrieval path (B0-280).
 * On by default; set BEX_PRODUCT_SUPPORT_RERANKER=false to disable without a redeploy. If the
 * reranker endpoint is unavailable, searchProductChunks falls back to cosine order automatically,
 * so enabling this is safe even before the cross-encoder is provisioned.
 */
const PRODUCT_SUPPORT_RERANK_ENABLED =
  process.env.BEX_PRODUCT_SUPPORT_RERANKER !== 'false';

export type CuratedSource = {
  documentId: string;
  /** Identifier of the chunk that produced the top similarity match for this document. */
  chunkId: string;
  title: string;
  /**
   * Short preview text derived from the matched chunk. Safe for storage / UI display
   * (capped under the SourceRef snippet length budget).
   */
  snippet: string;
  /**
   * Full document body, assembled from every chunk of the parent document and
   * passed to the LLM as grounding context. May be truncated if the document is
   * extremely large; in that case `documentBodyTruncated` is true.
   */
  documentBody: string;
  documentBodyChars: number;
  documentBodyChunkCount: number;
  documentBodyTruncated: boolean;
  documentBodyTokenEstimate: number | null;
  /** Untruncated text of the matched chunk, for traceability and debugging. */
  matchedChunkText: string;
  similarity: number;
  documentKind: string;
  entityId: string | null;
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
  /** True when an explicit product-key-scoped search returned no evidence and was retried at the line level (B0-250). */
  usedProductKeyFallback: boolean;
  broadCuratedCount: number;
  anchoredCuratedCount: number;
  productLineResolution?: ProductLineResolutionResult;
};

export type ProductKnowledgeQueryResult = {
  sources: CuratedSource[];
  entityContextBlock: string | null;
  /** Structured product facts (dilution/efficacy) keyed by entity id. */
  facts: Map<string, ProductLineFacts>;
  /** Rendered, grounding-ready facts block (null when no entity has facts). */
  factsBlock: string | null;
  retrieval: ProductKnowledgeRetrievalSummary;
};

type ProductKnowledgeQueryBase = Omit<
  ProductKnowledgeQueryResult,
  'facts' | 'factsBlock'
>;

function buildCuratedSource(
  match: RagSearchMatch,
  body: AssembledDocumentBody | undefined,
): CuratedSource {
  const fallbackBody = match.chunk_text;
  const documentBody = body && body.body.length > 0 ? body.body : fallbackBody;

  return {
    documentId: match.document_id,
    chunkId: match.chunk_id,
    title: match.document_title || match.heading || match.document_key,
    snippet: trimSnippet(match.chunk_text, 900),
    documentBody,
    documentBodyChars: documentBody.length,
    documentBodyChunkCount: body?.chunkCount ?? (fallbackBody ? 1 : 0),
    documentBodyTruncated: body?.truncated ?? false,
    documentBodyTokenEstimate: body?.estimatedTokens ?? null,
    matchedChunkText: match.chunk_text,
    similarity: match.similarity,
    documentKind: match.document_kind,
    entityId: match.entity_id,
    productLineKey: match.product_line_key,
    productKey: match.product_key,
  };
}

async function curateUniqueDocumentSources(
  matches: RagSearchMatch[],
  options: {
    limit: number;
    requiredDocumentKinds?: string[];
    maxPerDocument?: number;
  },
): Promise<CuratedSource[]> {
  const selected = selectCuratedMatches(matches, {
    limit: options.limit,
    maxPerDocument: options.maxPerDocument ?? 1,
    requiredDocumentKinds: options.requiredDocumentKinds,
  });

  if (selected.length === 0) {
    return [];
  }

  const documentIds = selected.map((match) => match.document_id);
  const bodies = await assembleDocumentBodies(documentIds);

  return selected.map((match) =>
    buildCuratedSource(match, bodies.get(match.document_id)),
  );
}

async function entityContextBlockForSources(sources: CuratedSource[]): Promise<string | null> {
  const entityIds = sources.map((s) => s.entityId).filter((id): id is string => id != null);
  const map = await fetchEntityContexts(entityIds);
  return buildEntityContextBlock(map);
}

async function factsForSources(
  sources: CuratedSource[],
): Promise<{ facts: Map<string, ProductLineFacts>; factsBlock: string | null }> {
  const entityIds = sources
    .map((s) => s.entityId)
    .filter((id): id is string => id != null);
  const facts = await fetchProductLineFacts(entityIds);
  const titles = new Map(
    sources
      .filter((s) => s.entityId != null)
      .map((s) => [s.entityId as string, s.title] as const),
  );
  return { facts, factsBlock: buildFactsBlock(facts, titles) };
}

/**
 * Public entry: run the curated document query, then enrich the result with
 * structured product facts (dilution/efficacy) joined on the resolved entities.
 */
export async function ragQueryForProductKnowledgeWithMeta(
  input: Parameters<typeof runProductKnowledgeQuery>[0],
): Promise<ProductKnowledgeQueryResult> {
  const base = await runProductKnowledgeQuery(input);
  const { facts, factsBlock } = await factsForSources(base.sources);
  return { ...base, facts, factsBlock };
}

export async function ragQueryForProductKnowledge(input: {
  query: string;
  limit?: number;
  productLineKey?: string | null;
  productKey?: string | null;
  skipProductLineResolution?: boolean;
}): Promise<CuratedSource[]> {
  const result = await ragQueryForProductKnowledgeWithMeta(input);
  return result.sources;
}

async function runProductKnowledgeQuery(input: {
  query: string;
  /**
   * Maximum number of unique-document sources to return. Each source represents
   * a full document, not a single chunk. Defaults to 3.
   */
  limit?: number;
  productLineKey?: string | null;
  /** Resolved product-tier key (B0-248 SKU/InvtID alias), if the caller anchored to a specific product. */
  productKey?: string | null;
  /** When true, skip candidate resolution (caller already anchored the query, e.g. by product id). */
  skipProductLineResolution?: boolean;
  /** Restrict retrieval to chunks belonging to a specific GHS section. Null = no filter. */
  sectionType?: string | null;
  /** Diversity cap per parent document (default 1). Raise for single-product depth. */
  maxPerDocument?: number;
  /** Override which document kinds are guaranteed a slot. Default: profile + sds + knowledge. */
  requiredDocumentKinds?: string[];
}): Promise<ProductKnowledgeQueryBase> {
  const limit = input.limit ?? DEFAULT_UNIQUE_DOCUMENT_LIMIT;
  const explicitKey = input.productLineKey?.trim() || null;
  const explicitProductKey = input.productKey?.trim() || null;
  const sectionType = input.sectionType?.trim() || null;
  const maxPerDocument = input.maxPerDocument;
  const requiredDocumentKinds =
    input.requiredDocumentKinds ?? ['product_line_profile', 'sds', 'knowledge', 'label'];

  if (explicitKey) {
    const result = await searchProductChunks({
      query: input.query,
      limit: SIMILARITY_CANDIDATE_FETCH_LIMIT,
      productLineKey: explicitKey,
      productKey: explicitProductKey ?? undefined,
      sectionType: sectionType ?? undefined,
      scope: 'all',
      useHybrid: true,
      useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
    });

    let curated = await curateUniqueDocumentSources(result.matches, {
      limit,
      requiredDocumentKinds,
      maxPerDocument,
    });

    // B0-250: thin coverage at the product tier -- fall back to the line-scoped search
    // rather than surfacing nothing (there is no product-tier chunked content yet, so this
    // mainly guards against a resolved product_key that doesn't validate as a variant).
    let usedProductKeyFallback = false;
    if (curated.length === 0 && explicitProductKey) {
      const lineResult = await searchProductChunks({
        query: input.query,
        limit: SIMILARITY_CANDIDATE_FETCH_LIMIT,
        productLineKey: explicitKey,
        sectionType: sectionType ?? undefined,
        scope: 'all',
        useHybrid: true,
        useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
      });
      curated = await curateUniqueDocumentSources(lineResult.matches, {
        limit,
        requiredDocumentKinds,
        maxPerDocument,
      });
      usedProductKeyFallback = true;
    }

    return {
      sources: curated,
      entityContextBlock: await entityContextBlockForSources(curated),
      retrieval: {
        strategy: 'explicit_product_line',
        cacheSource: result.embeddingSource,
        searchMs: result.timings.similaritySearchMs,
        initialSearchMs: result.timings.similaritySearchMs,
        anchoredSearchMs: result.timings.similaritySearchMs,
        usedBroadFallback: false,
        usedProductKeyFallback,
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
      limit: SIMILARITY_CANDIDATE_FETCH_LIMIT,
      productKey: explicitProductKey ?? undefined,
      sectionType: sectionType ?? undefined,
      scope: 'products',
      useHybrid: true,
      useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
    });

    const curated = await curateUniqueDocumentSources(result.matches, {
      limit,
      maxPerDocument,
    });

    return {
      sources: curated,
      entityContextBlock: await entityContextBlockForSources(curated),
      retrieval: {
        strategy: 'broad_resolution_disabled',
        cacheSource: result.embeddingSource,
        searchMs: result.timings.similaritySearchMs,
        initialSearchMs: result.timings.similaritySearchMs,
        anchoredSearchMs: null,
        usedBroadFallback: false,
        usedProductKeyFallback: false,
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

  const broadResult = await searchProductChunks({
    query: input.query,
    limit: SIMILARITY_CANDIDATE_FETCH_LIMIT,
    sectionType: sectionType ?? undefined,
    scope: 'all',
    useHybrid: true,
    useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
  });

  const resolution = resolveProductLineFromMatches(broadResult.matches);
  const broadCurated = await curateUniqueDocumentSources(broadResult.matches, {
    limit,
    requiredDocumentKinds: ['product_line_profile', 'sds', 'knowledge', 'label'],
  });

  if (resolution.lockedProductLineKey == null) {
    return {
      sources: broadCurated,
      entityContextBlock: await entityContextBlockForSources(broadCurated),
      retrieval: {
        strategy: 'broad_only',
        cacheSource: broadResult.embeddingSource,
        searchMs: broadResult.timings.similaritySearchMs,
        initialSearchMs: broadResult.timings.similaritySearchMs,
        anchoredSearchMs: null,
        usedBroadFallback: false,
        usedProductKeyFallback: false,
        broadCuratedCount: broadCurated.length,
        anchoredCuratedCount: 0,
        productLineResolution: resolution,
      },
    };
  }

  const anchoredResult = await searchProductChunks({
    query: input.query,
    limit: SIMILARITY_CANDIDATE_FETCH_LIMIT,
    productLineKey: resolution.lockedProductLineKey,
    sectionType: sectionType ?? undefined,
    scope: 'all',
    useHybrid: true,
    useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
  });
  const anchoredCurated = await curateUniqueDocumentSources(anchoredResult.matches, {
    limit,
    requiredDocumentKinds: ['product_line_profile', 'sds', 'knowledge', 'label'],
  });

  const minimumAnchoredEvidence = Math.max(2, Math.ceil(limit / 2));
  const shouldUseBroadFallback =
    anchoredCurated.length === 0 ||
    (anchoredCurated.length < minimumAnchoredEvidence &&
      broadCurated.length > anchoredCurated.length);

  const finalCurated = shouldUseBroadFallback ? broadCurated : anchoredCurated;
  const strategy = shouldUseBroadFallback
    ? 'anchored_with_broad_fallback'
    : 'anchored_only';
  const totalSearchMs =
    broadResult.timings.similaritySearchMs + anchoredResult.timings.similaritySearchMs;

  return {
    sources: finalCurated,
    entityContextBlock: await entityContextBlockForSources(finalCurated),
    retrieval: {
      strategy,
      cacheSource: anchoredResult.embeddingSource,
      searchMs: totalSearchMs,
      initialSearchMs: broadResult.timings.similaritySearchMs,
      anchoredSearchMs: anchoredResult.timings.similaritySearchMs,
      usedBroadFallback: shouldUseBroadFallback,
      usedProductKeyFallback: false,
      broadCuratedCount: broadCurated.length,
      anchoredCuratedCount: anchoredCurated.length,
      productLineResolution: resolution,
    },
  };
}
