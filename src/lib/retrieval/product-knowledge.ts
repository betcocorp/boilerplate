import { searchProductChunks, type RagSearchMatch } from '~/lib/rag/search';
import {
  buildEntityContextBlock,
  fetchEntityContexts,
} from '~/lib/rag/entity-context';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import {
  assembleDocumentBodies,
  fetchDocumentSourceRefs,
  type AssembledDocumentBody,
  type DocumentSourceRef,
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
import { suppressNearDuplicateMatches } from '~/lib/retrieval/near-duplicate-suppression';

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
  /**
   * B0-13: ordered `rag.document_chunk.id`s actually stitched into `documentBody`, so a
   * retrieval can be audited after the fact for exactly which chunks reached the model.
   * Falls back to the single matched chunk id when full-document assembly wasn't available.
   */
  documentBodyChunkIds: string[];
  /** Untruncated text of the matched chunk, for traceability and debugging. */
  matchedChunkText: string;
  similarity: number;
  documentKind: string;
  entityId: string | null;
  productLineKey: string | null;
  productKey: string | null;
  /** B0-257: source-document provenance for citing label/SDS PDFs by their raw S3 location. */
  s3Key: string | null;
  sourceUri: string | null;
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
  sourceRef: DocumentSourceRef | undefined,
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
    documentBodyChunkIds: body?.chunkIds ?? (fallbackBody ? [match.chunk_id] : []),
    matchedChunkText: match.chunk_text,
    similarity: match.similarity,
    documentKind: match.document_kind,
    entityId: match.entity_id,
    productLineKey: match.product_line_key,
    productKey: match.product_key,
    s3Key: sourceRef?.s3Key ?? null,
    sourceUri: sourceRef?.sourceUri ?? null,
  };
}

/**
 * B0-257 (discontinued-product filter): entities whose `metadata->>'status'` is
 * 'discontinued' are excluded from default (semantic) retrieval. Scoped to entity
 * status only (not e.g. legacy.products."Status", which uses unrelated AC/IN/0 codes
 * with no documented discontinued mapping -- verified live, see B0-246 notes) and only
 * to entities that actually carry the value (most are null/'UNKNOWN', left untouched).
 * Applied once here so every retrieval call site (search_product_docs, get_product_spec,
 * get_approved_usage_guidance, etc.) benefits without touching the match_corpus_chunks*
 * SQL RPCs, which have several call-site overloads across migrations -- an app-layer
 * filter is the lower-risk change for this ticket's scope.
 */
export async function fetchDiscontinuedEntityIds(entityIds: string[]): Promise<Set<string>> {
  const unique = [...new Set(entityIds.filter(Boolean))];
  if (unique.length === 0) {
    return new Set();
  }

  const rag = getSupabaseServiceRoleClient().schema('rag');
  const { data, error } = await rag
    .from('entity')
    .select('id')
    .in('id', unique)
    .filter('metadata->>status', 'eq', 'discontinued');

  if (error || !data) {
    // Degrade to "no filter" rather than block retrieval on a status-lookup failure.
    return new Set();
  }

  return new Set(data.map((row) => row.id));
}

async function excludeDiscontinuedMatches(matches: RagSearchMatch[]): Promise<RagSearchMatch[]> {
  const entityIds = matches.map((m) => m.entity_id).filter((id): id is string => id != null);
  if (entityIds.length === 0) {
    return matches;
  }
  const discontinued = await fetchDiscontinuedEntityIds(entityIds);
  if (discontinued.size === 0) {
    return matches;
  }
  return matches.filter((m) => !m.entity_id || !discontinued.has(m.entity_id));
}

async function curateUniqueDocumentSources(
  matches: RagSearchMatch[],
  options: {
    limit: number;
    requiredDocumentKinds?: string[];
    maxPerDocument?: number;
  },
): Promise<CuratedSource[]> {
  const eligibleMatches = await excludeDiscontinuedMatches(matches);
  // B0-257 (scope addition): retrieval backstop -- suppress lower-authority
  // near-duplicate chunks (same product + section_type, high cosine similarity)
  // before the top-N/diversity pass below, so e.g. a marketing blurb doesn't
  // edge out the SDS's version of the same hazard/first-aid content.
  const deduplicatedMatches = await suppressNearDuplicateMatches(eligibleMatches);

  const selected = selectCuratedMatches(deduplicatedMatches, {
    limit: options.limit,
    maxPerDocument: options.maxPerDocument ?? 1,
    requiredDocumentKinds: options.requiredDocumentKinds,
  });

  if (selected.length === 0) {
    return [];
  }

  const documentIds = selected.map((match) => match.document_id);
  const [bodies, sourceRefs] = await Promise.all([
    assembleDocumentBodies(documentIds),
    fetchDocumentSourceRefs(documentIds),
  ]);

  return selected.map((match) =>
    buildCuratedSource(match, bodies.get(match.document_id), sourceRefs.get(match.document_id)),
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
 * B0-259 conflict-reconciliation policy (source-of-truth precedence), applied wherever
 * multiple document kinds could answer the same question. This is deliberately encoded
 * as *retrieval-slot ordering* (below), not a prose guideline, so it's actually enforced:
 *
 *   1. `label`   — the EPA-registered/GHS product label. Source of truth for directions-
 *                  for-use, dilution/contact-time claims, hazard statements, and first-aid
 *                  instructions. The printed label is the legally operative document and
 *                  must win over marketing copy or a stale corpus profile when they disagree.
 *   2. `sds`     — safety/hazard/first-aid/PPE/composition detail not on the label itself.
 *   3. `product_line_profile` / `knowledge` — general usage guidance, marketing/catalog
 *                  copy. Authoritative for descriptive, non-regulated content (features,
 *                  positioning) ONLY -- never for dilution ratios, EPA claims, or hazard/
 *                  first-aid instructions.
 *   4. `efficacy` / `rag.product_line_fact` + `rag.product_efficacy` (structured facts,
 *                  see product-facts.ts) — authoritative for the exact numeric dilution /
 *                  contact-time / kill-claim VALUES specifically (get_efficacy_data tool);
 *                  used alongside, not instead of, the label's citation.
 *
 * `selectCuratedMatches()` (source-selection.ts) grants one guaranteed retrieval slot per
 * entry in `requiredDocumentKinds`, in array order, before falling back to plain similarity
 * ranking -- so putting `label` first for claim-type queries is what actually makes the
 * label outrank a competing marketing/profile chunk when both are candidates.
 */
const DEFAULT_REQUIRED_DOCUMENT_KINDS = ['product_line_profile', 'sds', 'knowledge', 'label'];
const LABEL_FIRST_REQUIRED_DOCUMENT_KINDS = ['label', 'sds', 'product_line_profile', 'knowledge'];

/** GHS/efficacy section types that represent label-governed claim content (see product-facts.ts / section-type-inference.ts for the full taxonomy). */
const CLAIM_LIKE_SECTION_TYPES = new Set([
  'organism_contact_time',
  'virucidal_activity',
  'fungistatic',
  'bactericidal_efficacy',
  'first_aid',
  'hazard',
  'handling_storage',
  'regulatory',
  'exposure_ppe',
]);

/**
 * Free-text signal for "this question is about a claim the label governs" -- broader than
 * `inferSectionTypeFromQuery` (which only fires on narrow GHS-section phrasing) so a plain
 * "what's the dilution ratio" or "is this EPA registered" question still gets the label-first
 * ordering even though it doesn't match a specific GHS section pattern.
 */
const CLAIM_LIKE_QUERY_PATTERN =
  /\b(dilut|oz\.?\s*\/?\s*gal|ounces? per gallon|mix ratio|ready.?to.?use|\bRTU\b|epa\s*reg|contact time|dwell time|kill\b|efficacy|hazard|first aid|corrosive|flammable|ppe|directions for use)\b/i;

function isClaimLikeQuery(query: string): boolean {
  return CLAIM_LIKE_QUERY_PATTERN.test(query);
}

function resolveRequiredDocumentKinds(query: string, sectionType: string | null): string[] {
  if (isClaimLikeQuery(query) || (sectionType && CLAIM_LIKE_SECTION_TYPES.has(sectionType))) {
    return LABEL_FIRST_REQUIRED_DOCUMENT_KINDS;
  }
  return DEFAULT_REQUIRED_DOCUMENT_KINDS;
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
    input.requiredDocumentKinds ?? resolveRequiredDocumentKinds(input.query, sectionType);

  if (explicitKey) {
    // B0-272 follow-up: `filter_section_type` is a hard SQL-level filter against
    // `rag.document_chunk.section_type`, which only ever carries fine-grained GHS
    // values (e.g. `organism_contact_time`) on SDS chunks -- label/knowledge chunks
    // are always the coarse `label`/`knowledge` bucket. Threading the inferred
    // section type into a `scope: 'all'` search silently zeroed out every label/
    // knowledge chunk whenever the query matched one of the SDS-oriented patterns
    // in `inferSectionTypeFromQuery` (e.g. "contact time", "dilution", "how to
    // store" -- all common label phrasing too), which is exactly what broke the
    // B0-272 prose fallback in practice. Do not filter scope:'all' searches by
    // section type; let curation/reranking do the narrowing instead.
    const result = await searchProductChunks({
      query: input.query,
      limit: SIMILARITY_CANDIDATE_FETCH_LIMIT,
      productLineKey: explicitKey,
      productKey: explicitProductKey ?? undefined,
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
      requiredDocumentKinds: resolveRequiredDocumentKinds(input.query, sectionType),
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
    scope: 'all',
    useHybrid: true,
    useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
  });

  const resolution = resolveProductLineFromMatches(broadResult.matches);
  const requiredDocumentKindsForQuery = resolveRequiredDocumentKinds(input.query, sectionType);
  const broadCurated = await curateUniqueDocumentSources(broadResult.matches, {
    limit,
    requiredDocumentKinds: requiredDocumentKindsForQuery,
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
    scope: 'all',
    useHybrid: true,
    useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
  });
  const anchoredCurated = await curateUniqueDocumentSources(anchoredResult.matches, {
    limit,
    requiredDocumentKinds: requiredDocumentKindsForQuery,
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
