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
 * On by default; set BEX_PRODUCT_SUPPORT_RERANKER=false to disable without a redeploy.
 *
 * This is only a *request*, not a guarantee: B0-440 made `searchProductChunks` gate the actual
 * cost of reranking (the 5x candidate over-fetch, the rerank call, the `+reranked` strategy
 * label) on `isRerankerConfigured()` — i.e. on COHERE_API_KEY being present. With the key unset
 * this flag is inert and every search below behaves exactly as if reranking were off, so it stays
 * safe to leave on before the cross-encoder is provisioned.
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
  /**
   * Total time spent *inside* similarity searches: the sum of `similaritySearchMs` across every
   * search this call actually performed.
   *
   * B0-438 deliberately KEEPS these semantics rather than redefining them as wall clock. This
   * value propagates to `timingBreakdown.searchMs` (run-product-support-workflow.ts) and from
   * there into the golden-set harness and `/admin/observability`, and it is the metric B0-434 /
   * B0-435 state their acceptance criteria in ("p95 `searchMs` under 1s", "p50 at concurrency 1
   * within 2x of concurrency 0"). Redefining it mid-epic would make the epic's own before/after
   * measurements meaningless. The searches themselves are still sequential, so a sum remains an
   * honest measure of search cost.
   *
   * One correctness fix: it now also counts the B0-250 product-key fallback search, which the
   * previous sum silently omitted. That can only ever have under-reported.
   *
   * For "how long did the whole retrieval phase take", use `retrievalPhaseMs`.
   */
  searchMs: number;
  /**
   * B0-438 -- elapsed wall clock of the entire retrieval phase: query embedding, both searches,
   * candidate selection and document-body hydration. Strictly greater than `searchMs`, and the
   * number to watch when judging whether the B0-438 restructure actually helped, since the
   * overlapping/skipped work it removes lives outside the similarity searches.
   */
  retrievalPhaseMs: number;
  /** Per-search `similaritySearchMs` of the broad/initial pass. Meaning unchanged by B0-438. */
  initialSearchMs: number;
  /** Per-search `similaritySearchMs` of the anchored pass; null when no anchored search ran. */
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

/**
 * What `runProductKnowledgeQuery` produces. B0-438: `entityContextBlock` is deliberately NOT
 * part of it -- entity context and structured facts are independent enrichments of the final
 * curated sources, so `ragQueryForProductKnowledgeWithMeta` runs both concurrently instead of
 * having each of the four retrieval paths await entity context inline before returning.
 */
type ProductKnowledgeQueryBase = Omit<
  ProductKnowledgeQueryResult,
  'facts' | 'factsBlock' | 'entityContextBlock'
>;

/** Wall-clock stopwatch for the retrieval phase -- see `searchMs` on the summary above (B0-438). */
function retrievalElapsedMs(startedAt: number): number {
  return Number((performance.now() - startedAt).toFixed(1));
}

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

type CurationOptions = {
  limit: number;
  requiredDocumentKinds?: string[];
  maxPerDocument?: number;
};

/**
 * Selection half of curation: discontinued filter (B0-257) -> near-duplicate suppression
 * (B0-257 scope addition) -> the B0-259 slot-ordered top-N/diversity pass.
 *
 * Split out from hydration for B0-438. `curateUniqueDocumentSources` returns exactly one
 * `CuratedSource` per selected match, so `curated.length === selected.length` always -- which
 * means the broad-vs-anchored fallback decision (which compares only the two lengths) can be
 * made from the selected matches, and the *losing* pass never has to pay for full document-body
 * assembly. Selection order and membership are unchanged.
 */
async function selectCuratedSourceMatches(
  matches: RagSearchMatch[],
  options: CurationOptions,
): Promise<RagSearchMatch[]> {
  const eligibleMatches = await excludeDiscontinuedMatches(matches);
  // B0-257 (scope addition): retrieval backstop -- suppress lower-authority
  // near-duplicate chunks (same product + section_type, high cosine similarity)
  // before the top-N/diversity pass below, so e.g. a marketing blurb doesn't
  // edge out the SDS's version of the same hazard/first-aid content.
  const deduplicatedMatches = await suppressNearDuplicateMatches(eligibleMatches);

  return selectCuratedMatches(deduplicatedMatches, {
    limit: options.limit,
    maxPerDocument: options.maxPerDocument ?? 1,
    requiredDocumentKinds: options.requiredDocumentKinds,
  });
}

/**
 * Hydration half of curation: assemble the full document body and source provenance for each
 * already-selected match. This is the expensive half (full document text for every selected
 * document), so B0-438 runs it once, on the winning pass only.
 */
async function hydrateCuratedSources(selected: RagSearchMatch[]): Promise<CuratedSource[]> {
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

async function curateUniqueDocumentSources(
  matches: RagSearchMatch[],
  options: CurationOptions,
): Promise<CuratedSource[]> {
  return hydrateCuratedSources(await selectCuratedSourceMatches(matches, options));
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
  // B0-438: entity context and structured facts depend only on the final curated sources and
  // not on each other, so they run concurrently. Doing it here rather than inside
  // `runProductKnowledgeQuery` applies the same parallelisation to all four retrieval paths.
  // Rejection behaviour is unchanged: either enrichment failing still fails the whole call, as
  // it did when both were awaited in sequence.
  const [entityContextBlock, { facts, factsBlock }] = await Promise.all([
    entityContextBlockForSources(base.sources),
    factsForSources(base.sources),
  ]);
  return { ...base, entityContextBlock, facts, factsBlock };
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
  const retrievalStartedAt = performance.now();
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
    // Every similarity search performed on this path, so `searchMs` below counts the B0-250
    // fallback search too instead of silently under-reporting it.
    let searchMsTotal = result.timings.similaritySearchMs;
    if (curated.length === 0 && explicitProductKey) {
      const lineResult = await searchProductChunks({
        query: input.query,
        limit: SIMILARITY_CANDIDATE_FETCH_LIMIT,
        productLineKey: explicitKey,
        scope: 'all',
        useHybrid: true,
        useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
      });
      searchMsTotal += lineResult.timings.similaritySearchMs;
      curated = await curateUniqueDocumentSources(lineResult.matches, {
        limit,
        requiredDocumentKinds,
        maxPerDocument,
      });
      usedProductKeyFallback = true;
    }

    return {
      sources: curated,
      retrieval: {
        strategy: 'explicit_product_line',
        cacheSource: result.embeddingSource,
        searchMs: searchMsTotal,
        retrievalPhaseMs: retrievalElapsedMs(retrievalStartedAt),
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
      retrieval: {
        strategy: 'broad_resolution_disabled',
        cacheSource: result.embeddingSource,
        searchMs: result.timings.similaritySearchMs,
        retrievalPhaseMs: retrievalElapsedMs(retrievalStartedAt),
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

  // B0-438: start broad candidate selection now, but do not await it yet. The anchored search
  // needs only `resolution` (derived from the broad *matches*), so the two are independent and
  // overlap below instead of stacking two full round-trip chains on the critical path.
  const broadSelectedPromise = selectCuratedSourceMatches(broadResult.matches, {
    limit,
    requiredDocumentKinds: requiredDocumentKindsForQuery,
  });

  if (resolution.lockedProductLineKey == null) {
    const broadCurated = await hydrateCuratedSources(await broadSelectedPromise);
    return {
      sources: broadCurated,
      retrieval: {
        strategy: 'broad_only',
        cacheSource: broadResult.embeddingSource,
        searchMs: broadResult.timings.similaritySearchMs,
        retrievalPhaseMs: retrievalElapsedMs(retrievalStartedAt),
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

  const [broadSelected, anchoredResult] = await Promise.all([
    broadSelectedPromise,
    searchProductChunks({
      query: input.query,
      limit: SIMILARITY_CANDIDATE_FETCH_LIMIT,
      productLineKey: resolution.lockedProductLineKey,
      scope: 'all',
      useHybrid: true,
      useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
    }),
  ]);

  const anchoredSelected = await selectCuratedSourceMatches(anchoredResult.matches, {
    limit,
    requiredDocumentKinds: requiredDocumentKindsForQuery,
  });

  // Unchanged fallback policy, evaluated on the selected-match counts instead of the hydrated
  // sources. Identical by construction: hydration emits exactly one source per selected match
  // (B0-438), so `selected.length === curated.length` for both passes.
  const minimumAnchoredEvidence = Math.max(2, Math.ceil(limit / 2));
  const shouldUseBroadFallback =
    anchoredSelected.length === 0 ||
    (anchoredSelected.length < minimumAnchoredEvidence &&
      broadSelected.length > anchoredSelected.length);

  // B0-438: only the winning pass is hydrated. Assembling full document bodies for the pass
  // that is about to be discarded was the single largest piece of provably wasted retrieval work.
  const finalCurated = await hydrateCuratedSources(
    shouldUseBroadFallback ? broadSelected : anchoredSelected,
  );
  const strategy = shouldUseBroadFallback
    ? 'anchored_with_broad_fallback'
    : 'anchored_only';

  return {
    sources: finalCurated,
    retrieval: {
      strategy,
      cacheSource: anchoredResult.embeddingSource,
      searchMs:
        broadResult.timings.similaritySearchMs + anchoredResult.timings.similaritySearchMs,
      retrievalPhaseMs: retrievalElapsedMs(retrievalStartedAt),
      initialSearchMs: broadResult.timings.similaritySearchMs,
      anchoredSearchMs: anchoredResult.timings.similaritySearchMs,
      usedBroadFallback: shouldUseBroadFallback,
      usedProductKeyFallback: false,
      broadCuratedCount: broadSelected.length,
      anchoredCuratedCount: anchoredSelected.length,
      productLineResolution: resolution,
    },
  };
}
