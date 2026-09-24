import { searchProductChunks, type RagSearchMatch, type RagSearchResult } from '~/lib/rag/search';
import {
  buildEntityContextBlock,
  fetchEntityContexts,
  type ProductEntityResolutionSource,
} from '~/lib/rag/entity-context';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import {
  assembleChunkIndexSetBody,
  assembleNeighborChunkBodies,
  chunkWindowKey,
  fetchDocumentSourceRefs,
  fetchProductLineWebUrls,
  type AssembledDocumentBody,
  type DocumentSourceRef,
} from '~/lib/retrieval/document-assembly';
import {
  resolveProductLineFromMatches,
  type ProductLineResolutionResult,
} from '~/lib/retrieval/product-line-resolution';
import { getProductLineLockThresholds } from '~/lib/settings/settings-service';
import {
  DEFAULT_MIN_SIMILARITY,
  selectCuratedMatches,
  trimSnippet,
} from '~/lib/retrieval/source-selection';
import {
  buildFactsBlock,
  fetchProductLineFacts,
  type ProductLineFacts,
} from '~/lib/retrieval/product-facts';
import { suppressNearDuplicateMatches } from '~/lib/retrieval/near-duplicate-suppression';
import { MODEL_DOCUMENT_BODY_MAX_CHARS } from '~/lib/tools/model-tool-payload';

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
// B0-494 — exported so `run-product-support-workflow.ts` can record the effective value in its
// per-run runtime-config snapshot, rather than a second, possibly-drifting read of the same flag.
export const PRODUCT_SUPPORT_RERANK_ENABLED =
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
   * Grounding text passed to the LLM. B0-547: assembled from the matched chunk plus
   * `NEIGHBOR_CHUNK_RADIUS` chunks immediately before/after it in the parent document (NOT the
   * whole document — see `assembleNeighborChunkBodies`). May still be truncated against the
   * per-source char budget in the rare case a chunk itself is huge; `documentBodyTruncated`
   * reflects that.
   */
  documentBody: string;
  documentBodyChars: number;
  documentBodyChunkCount: number;
  documentBodyTruncated: boolean;
  documentBodyTokenEstimate: number | null;
  /**
   * B0-13: ordered `rag.document_chunk.id`s actually stitched into `documentBody`, so a
   * retrieval can be audited after the fact for exactly which chunks reached the model.
   * Falls back to the single matched chunk id when windowed assembly wasn't available.
   */
  documentBodyChunkIds: string[];
  // B0-548: `matchedChunkText` (the untruncated matched chunk) used to live here too, but it was
  // always a substring of `documentBody` (or, when body assembly fell back to the single chunk,
  // byte-identical to it) with no downstream reader — `snippet` already covers the short-preview
  // use case. Removed rather than trimmed to keep exactly one canonical grounding field.
  similarity: number;
  /**
   * The cross-encoder's verdict on this chunk for this query (`RagSearchMatch.rerank_score` /
   * `rerank_rank`), carried through because `selectCuratedMatches` re-sorts by `similarity` and
   * would otherwise erase the reranked order before anything persists it. Null when the reranker
   * did not run, and on synthetic sources (verified facts, lab reports) that never went through
   * retrieval at all.
   */
  rerankScore: number | null;
  rerankRank: number | null;
  documentKind: string;
  entityId: string | null;
  productLineKey: string | null;
  productKey: string | null;
  /** B0-257: source-document provenance for citing label/SDS PDFs by their raw S3 location. */
  s3Key: string | null;
  sourceUri: string | null;
  /**
   * B0-1075: derived betco.com product-page URL (`rag.product_line_web_url`, B0-1074) for this
   * source's own `productLineKey`. Null whenever `productLineKey` is null or the line has no
   * web-visible item -- never inferred from a query's resolved line (B0-700 anchoring rule).
   */
  productPageUrl: string | null;
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
  /**
   * B0-556 — true when the explicit product-key-scoped search came back missing one or more of the
   * required document kinds and a line-scoped search (same `productLineKey`, no `productKey`) was
   * merged in to restore that coverage. The product-key predicate in the corpus RPCs is an AND
   * (`e.product_key = key OR d.metadata variant match`), and SDS / product_line_profile documents
   * hang off line-tier entities whose `product_key` is NULL — so a SKU-resolved anchor used to
   * structurally exclude the resolved line's own SDS (the B0-556 misattribution vector: with no
   * anchored SDS in the payload, the model escalated to unanchored freeform searches that could
   * surface another product's SDS). Both passes are filtered by the same resolved
   * `productLineKey`, so the merge can never introduce a cross-line document.
   */
  usedLineKindSupplement: boolean;
  /**
   * B0-873 — true when a procedural/knowledge-shaped question (`proceduralIntent`) reached a
   * LINE-FILTERED path (`explicit_product_line`, or `anchored_only` after a broad-probe lock) and
   * an UNLOCKED `scope: 'knowledge'` search was merged into that pass's candidate pool before
   * curation. `knowledge`-kind documents carry no `product_line_key` (verified live: every one of
   * them has `entity_id IS NULL`), so the SQL line filter can only ever drop them — "How long does
   * it take to get FastDraw Pro up and running?" alias-locked the FastDraw Pro line and reached the
   * model with one product-profile chunk while the knowledge document answering it was never
   * searched. Never set for a label-governed question (`isLabelGovernedQuery`): regulated values
   * stay grounded on the locked line's label/SDS only. False on every unlocked path, where the
   * broad pass already sees knowledge documents.
   */
  usedKnowledgeSupplement: boolean;
  /** B0-873 — final sources that came from the unlocked knowledge pass. 0 when it did not run. */
  knowledgeSupplementCuratedCount: number;
  /**
   * B0-874 — when the highest-similarity curated source is a `knowledge` document AND either the
   * question is procedural (`proceduralIntent`) or the ranking itself corroborates the document
   * (two or more of its chunks in the winning candidate pool), that ONE source's `documentBody` is
   * re-assembled from every chunk of the same document present in the pool plus
   * `KNOWLEDGE_SIBLING_RADIUS` chunks around each (`assembleChunkIndexSetBody`), instead of the
   * default ±1 window around the single matched chunk. Records which document and which pool chunk
   * indexes seeded the expansion; null when no expansion happened. Other sources' slots are
   * untouched — this is depth for one document, not a `maxPerDocument` increase (B0-759 measured
   * that and rejected it).
   */
  knowledgeSiblingExpansion: {
    documentId: string;
    title: string;
    chunkIndexes: number[];
  } | null;
  /**
   * B0-556 — SDS-kind sources withheld because they were not provably on the resolved product
   * line. Non-zero means the answer was deliberately denied regulated safety evidence rather than
   * grounded on another product line's SDS. Always 0 on the line-filtered paths.
   */
  withheldUnanchoredSdsCount: number;
  broadCuratedCount: number;
  anchoredCuratedCount: number;
  productLineResolution?: ProductLineResolutionResult;
  /**
   * B0-479: when `strategy` is `'explicit_product_line'`, tags WHY an explicit key was supplied —
   * specifically, whether it came from `resolveProductEntityByName`'s alias-table match (exact or
   * tokenized-fuzzy) versus a non-alias resolution path (prod_line_id / title match), versus a
   * caller that supplied a key without going through that resolver at all. Lets eval runs separate
   * "alias-anchored" retrieval from other explicit-key retrieval.
   *
   * B0-693 — also now populated as `'broad_similarity_probe'` when `strategy` is
   * `'anchored_only'`/`'anchored_with_broad_fallback'` AND `productLineResolution.lockedProductLineKey`
   * is non-null: the previously-always-`null` value here made it impossible to tell, from a
   * persisted run, whether a locked line was alias-anchored (high-precision) or came from the
   * broad-probe similarity lock alone (`resolveProductLineFromMatches`) — exactly the distinction
   * needed to self-diagnose a wrong-lock regression like this ticket's. Still `null` when no key was
   * ever supplied/locked at all (`broad_only`, `broad_resolution_disabled`, or a broad probe that
   * declined to lock).
   */
  explicitKeySource: ProductEntityResolutionSource | 'unspecified' | 'broad_similarity_probe' | null;
  /**
   * B0-490 — max `similarity` across the winning search's raw candidates (the matches
   * `searchProductChunks` returned, before `selectCuratedMatches` filtered/deduped/truncated the
   * set). Null when the winning pass returned zero candidates. This — NOT `selectedTopSimilarity`
   * — is the score `evaluateRecommendationGate`'s `LOW_SIMILARITY_THRESHOLD` was calibrated
   * against.
   */
  rawTopSimilarity: number | null;
  /** Max `similarity` across the sources that actually survived curation (what reached the model). */
  selectedTopSimilarity: number | null;
  /** Raw candidate count minus surviving source count, for the winning pass. */
  droppedByFilterCount: number;
  /**
   * B0-493 — the exact request parameters and strategy/cache outcome of the WINNING
   * `searchProductChunks` call (the one whose matches fed the final `sources[]`), so a run can be
   * root-caused against "was this a corpus change or a retrieval-parameter change" without reading
   * tool arguments.
   */
  search: {
    model: string;
    limit: number;
    scope: string;
    productLineKey: string | null;
    productKey: string | null;
    sectionType: string | null;
    minSimilarity: number | null;
    retrievalStrategy: RagSearchResult['retrieval_strategy'];
    embeddingSource: RagSearchResult['embeddingSource'];
    timings: RagSearchResult['timings'];
    /**
     * B0-975 — RPC candidates the hybrid lexical leg returned WITHOUT an embedding (`similarity`
     * NULL). They are excluded from ranking rather than scored 0; this is how many were dropped.
     */
    lexicalOnlyCandidateCount: number;
  };
  /**
   * B0-493 — the `selectCuratedMatches` options actually applied for this call, INCLUDING the
   * silently-defaulted `DEFAULT_MIN_SIMILARITY` floor when no override was passed (every call site
   * in this module today) — recorded as an applied value, never as an absence.
   */
  selection: {
    limit: number;
    minSimilarity: number;
    maxPerDocument: number;
    requiredDocumentKinds: string[];
  };
};

function maxSimilarity(items: ReadonlyArray<{ similarity: number }>): number | null {
  return items.length === 0 ? null : Math.max(...items.map((item) => item.similarity));
}

/** B0-493 — `search` field builder shared by every retrieval branch below. */
function buildSearchDetails(
  result: RagSearchResult,
  overrides: { productLineKey?: string | null; sectionType?: string | null } = {},
): ProductKnowledgeRetrievalSummary['search'] {
  return {
    model: result.model,
    limit: result.limit,
    scope: result.scope,
    productLineKey: overrides.productLineKey ?? result.productLineKey,
    productKey: result.productKey,
    sectionType: overrides.sectionType ?? result.sectionType,
    minSimilarity: result.minSimilarity,
    retrievalStrategy: result.retrieval_strategy,
    embeddingSource: result.embeddingSource,
    timings: result.timings,
    lexicalOnlyCandidateCount: result.lexicalOnlyCandidateCount ?? 0,
  };
}

/** B0-493 — the `selection` field: the `selectCuratedMatches` options every branch actually used. */
function buildSelectionDetails(input: {
  limit: number;
  maxPerDocument?: number;
  requiredDocumentKinds: string[];
}): ProductKnowledgeRetrievalSummary['selection'] {
  return {
    limit: input.limit,
    // Every call site in this module omits `minSimilarity`, so `selectCuratedMatches` always
    // silently substitutes its own default — reported here as the value actually applied.
    minSimilarity: DEFAULT_MIN_SIMILARITY,
    // Mirrors `selectCuratedSourceMatches`'s own `options.maxPerDocument ?? 1` default.
    maxPerDocument: input.maxPerDocument ?? 1,
    requiredDocumentKinds: input.requiredDocumentKinds,
  };
}

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

/**
 * B0-556 — document kinds whose content is regulated safety data: GHS hazard statements, signal
 * words, precautionary statements. Misattributing these across product lines is a safety
 * misstatement, not a relevance miss, so they get a stricter rule than everything else.
 */
const REGULATED_SAFETY_DOCUMENT_KINDS = new Set(['sds']);

/**
 * B0-958 — document kinds that hang off LINE-tier entities (`rag.entity.entity_type =
 * 'product_line'`, whose `product_key` is NULL) rather than product-tier ones. Verified live: line
 * `226` ("Concentrated Deodorizing Liquid") carries 10 current SDS titled `226`, `226 AC`, `226 DIL`…
 * and one profile, all on the line entity; the product-tier "Best Scent Lemon Zest" entity carries
 * only its label. The corpus RPC's `filter_product_key` predicate is an AND over `e.product_key =
 * key OR variant match`, so a SKU-anchored search structurally cannot see these kinds — which is why
 * the B0-556 `usedLineKindSupplement` merge exists (it was documented but never actually run).
 */
const LINE_TIER_DOCUMENT_KINDS = new Set(['sds', 'product_line_profile']);

/**
 * B0-700 investigation note: widening this withholding to `label`-kind sources whenever a
 * claim-like query is unanchored was tried and REVERTED — it regressed two already-hardened,
 * deliberate regression tests: B0-272 (`b0272-section-type-filter-regression.test.ts`, live-DB —
 * an unanchored "GE Fight Bac RTU contact time" query must still surface that label chunk even
 * though nothing locked) and B0-556 (`b0556-cross-line-sds-regression.test.ts`'s "leaves non-SDS
 * cross-line sources alone" case, whose `SAFETY_QUERY` also matches `isClaimLikeQuery` via
 * "hazards"/"first aid"/"ppe"). Both encode a deliberate prior decision: unanchored label/profile
 * content is a relevance problem, not a regulated-data one — label content frequently IS the
 * right document even when formal resolution doesn't "lock" (e.g. the query names the product
 * directly and wins on text similarity alone). B0-700's actual reported defect (dilution numbers
 * transcribed from an unanchored, WRONG product's label) is addressed instead at the generation
 * layer: the specialist prompts now require a decline/clarify response instead of substituting when
 * `aliasResolution.outcome` is `no_alias_match`/`ambiguous_alias` for a regulated-value question —
 * see `product-support-prompts.ts` and `bathroom-specialist-system-prompt.ts` for the added rule.
 * The structured-facts gate below (`factsForSources`) still gates the OTHER leak vector (a
 * `rag.product_line_fact`/`rag.product_efficacy` value attributed to an unanchored entity) since
 * that has no equivalent "still useful even unlocked" case and no test relies on it leaking.
 */

/**
 * B0-556 — withholds SDS-kind sources that are not provably on the resolved product line.
 *
 * Reported case: "hazards and signal word for SKU 07512-00" was answered with flammable-aerosol
 * hazard language cited to the Baseboard Stripper SDS. The alias resolves correctly and the SQL
 * line filter provably excludes that document, so the leak is not in resolution or the filter —
 * it is the paths that search the corpus with NO line filter and hand the results straight to the
 * model:
 *
 *  - `broad_only` — nothing resolved, so every SDS here belongs to an arbitrary line;
 *  - `anchored_with_broad_fallback` — a line WAS resolved, but thin anchored evidence lost to the
 *    unfiltered broad pass, so cross-line SDS content reaches the model despite a known line.
 *
 * `anchored_only` and `explicit_product_line` are filtered in SQL and are deliberately NOT passed
 * through here: their sources can legitimately carry a null `productLineKey` (the RPC also matches
 * on `source_record.source_pk`), and withholding those would drop correctly-anchored evidence.
 *
 * Everything that is not an SDS is untouched — cross-line label or profile prose is a relevance
 * problem, not a regulated-data one.
 */
function withholdUnanchoredSafetySources(
  sources: CuratedSource[],
  resolvedProductLineKey: string | null,
): { sources: CuratedSource[]; withheldCount: number } {
  const kept = sources.filter((source) => {
    if (!REGULATED_SAFETY_DOCUMENT_KINDS.has(source.documentKind)) {
      return true;
    }
    // With no resolved line, no SDS can be attributed to this SKU at all.
    return resolvedProductLineKey !== null && source.productLineKey === resolvedProductLineKey;
  });

  return { sources: kept, withheldCount: sources.length - kept.length };
}

function buildCuratedSource(
  match: RagSearchMatch,
  body: AssembledDocumentBody | undefined,
  sourceRef: DocumentSourceRef | undefined,
  webUrl: string | undefined,
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
    similarity: match.similarity,
    rerankScore: match.rerank_score ?? null,
    rerankRank: match.rerank_rank ?? null,
    documentKind: match.document_kind,
    entityId: match.entity_id,
    productLineKey: match.product_line_key,
    productKey: match.product_key,
    s3Key: sourceRef?.s3Key ?? null,
    sourceUri: sourceRef?.sourceUri ?? null,
    // B0-1075: only ever keyed off this source's OWN productLineKey -- never null here.
    productPageUrl: match.product_line_key ? (webUrl ?? null) : null,
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
  /** B0-974 — see `selectCuratedMatches`'s option of the same name (`./source-selection.ts`). */
  productAnchored?: boolean;
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
    productAnchored: options.productAnchored,
  });
}

/**
 * Hydration half of curation: assemble the matched-chunk body and source provenance for each
 * already-selected match. This is the expensive half (chunk text for every selected document),
 * so B0-438 runs it once, on the winning pass only.
 *
 * B0-547: hydrates a small window around each matched chunk (`assembleNeighborChunkBodies`)
 * rather than the whole parent document (`assembleDocumentBodies`) — a retrieval tool's answer
 * is grounded by the chunk that actually matched, and the 1-2 chunks immediately around it, not
 * every section of the source document.
 */
async function hydrateCuratedSources(selected: RagSearchMatch[]): Promise<CuratedSource[]> {
  if (selected.length === 0) {
    return [];
  }

  const documentIds = selected.map((match) => match.document_id);
  const windowRequests = selected.map((match) => ({
    documentId: match.document_id,
    chunkIndex: match.chunk_index,
  }));
  const productLineKeys = [
    ...new Set(
      selected
        .map((match) => match.product_line_key)
        .filter((key): key is string => Boolean(key)),
    ),
  ];
  const [bodies, sourceRefs, webUrls] = await Promise.all([
    assembleNeighborChunkBodies(windowRequests),
    fetchDocumentSourceRefs(documentIds),
    fetchProductLineWebUrls(productLineKeys),
  ]);

  return selected.map((match) =>
    buildCuratedSource(
      match,
      bodies.get(chunkWindowKey({ documentId: match.document_id, chunkIndex: match.chunk_index })),
      sourceRefs.get(match.document_id),
      match.product_line_key ? webUrls.get(match.product_line_key.toUpperCase()) : undefined,
    ),
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

/**
 * B0-700 — a structured dilution/efficacy fact (`rag.product_line_fact` / `rag.product_efficacy`)
 * is regulated data exactly like an SDS hazard statement (see `withholdUnanchoredSafetySources`);
 * it must not be attributed to an entity whose product line wasn't provably the one this query
 * resolved to. `resolvedProductLineKey` is `retrieval.productLineResolution.lockedProductLineKey`
 * from the SAME query — null on every unlocked/ambiguous path (`broad_only`, and
 * `resolution_disabled`), in which case NO source's facts may be surfaced (mirrors
 * `withholdUnanchoredSafetySources`'s "no resolved line, no regulated content attributable" rule
 * exactly).
 *
 * `sourcesMayBeUnfiltered` must be true only for `anchored_with_broad_fallback`, whose sources come
 * from the unfiltered broad pass despite a resolved line — there, only sources actually on that
 * line contribute. `explicit_product_line` and `anchored_only` are already SQL-filtered and are
 * passed as `false` (the default): per-source filtering there would wrongly drop a legitimately
 * anchored source whose `productLineKey` is null (the RPC also matches on `source_record.source_pk`
 * — see `withholdUnanchoredSafetySources`'s same caveat).
 */
async function factsForSources(
  sources: CuratedSource[],
  resolvedProductLineKey: string | null,
  options: { sourcesMayBeUnfiltered?: boolean } = {},
): Promise<{ facts: Map<string, ProductLineFacts>; factsBlock: string | null }> {
  const anchoredSources =
    resolvedProductLineKey === null
      ? []
      : options.sourcesMayBeUnfiltered
        ? sources.filter((s) => s.productLineKey === resolvedProductLineKey)
        : sources;
  const entityIds = anchoredSources
    .map((s) => s.entityId)
    .filter((id): id is string => id != null);
  const facts = await fetchProductLineFacts(entityIds);
  const titles = new Map(
    anchoredSources
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
 *
 * B0-443: each alternative carries its OWN `\b` boundaries rather than one trailing `\b` applied
 * to the whole group. A single trailing boundary requires the *last* alternative matched to be
 * followed by a non-word character, which silently broke every stem-style alternative used
 * mid-word: "dilut" in "dilution" never matched because `\b` fails between "t" and "i". Stems
 * that should catch inflected forms (dilut(e/ed/ion/ing), hazard(s/ous), epa reg(istered)) use
 * `\w*` instead of relying on the old shared boundary. Also folds in the phrasings B0-443 found
 * missing: "hazards", "hazardous", "epa registered", and "N oz per gallon" (previously only
 * "oz/gal"-style and "ounce(s) per gallon" literal were recognized).
 */
const CLAIM_LIKE_QUERY_PATTERN =
  /\bdilut\w*\b|\b(?:oz|ounces?)\.?\s*(?:\/|per)?\s*gal(?:lon)?s?\b|\bmix ratio\b|\bready.?to.?use\b|\bRTU\b|\bepa\s*reg\w*\b|\bcontact time\b|\bdwell time\b|\bkill\b|\befficacy\b|\bhazard\w*\b|\bfirst aid\b|\bcorrosive\b|\bflammable\b|\bppe\b|\bdirections for use\b/i;

/** Exported for table-driven unit testing of the claim-like phrasing matrix (B0-443). */
export function isClaimLikeQuery(query: string): boolean {
  return CLAIM_LIKE_QUERY_PATTERN.test(query);
}

/**
 * B0-786 — `regulatedSectionIntent` is the consolidated signals call's read of "this answer is
 * label-governed". It is OR'd with the two deterministic checks, NEVER substituted for them: an LLM
 * miss must only be able to WIDEN label-first grounding, never narrow it. `isClaimLikeQuery` and
 * `inferSectionTypeFromQuery` remain the floor under this decision.
 */
function isLabelGovernedQuery(
  query: string,
  sectionType: string | null,
  regulatedSectionIntent?: boolean,
): boolean {
  return (
    isClaimLikeQuery(query) ||
    (sectionType !== null && CLAIM_LIKE_SECTION_TYPES.has(sectionType)) ||
    regulatedSectionIntent === true
  );
}

function resolveRequiredDocumentKinds(
  query: string,
  sectionType: string | null,
  regulatedSectionIntent?: boolean,
): string[] {
  if (isLabelGovernedQuery(query, sectionType, regulatedSectionIntent)) {
    return LABEL_FIRST_REQUIRED_DOCUMENT_KINDS;
  }
  return DEFAULT_REQUIRED_DOCUMENT_KINDS;
}

/**
 * B0-873 — candidate count for the unlocked knowledge pass. `scope: 'knowledge'` is an app-layer
 * kind filter over `filter_scope: 'all'` (see `resolveSearchScope` in `~/lib/rag/search.ts`), so
 * `searchProductChunks` over-fetches `max(limit * 10, 100)` RPC rows for it; 10 keeps that at the
 * 100 floor while still yielding several distinct knowledge documents under `maxPerDocument: 1`.
 */
const KNOWLEDGE_SUPPLEMENT_FETCH_LIMIT = 10;

/** B0-874 — chunks on either side of each pooled sibling folded into the expanded knowledge body. */
const KNOWLEDGE_SIBLING_RADIUS = 2;

/**
 * B0-874 — char cap for the ONE expanded knowledge body. Matches the model-facing per-source cap
 * (`MODEL_DOCUMENT_BODY_MAX_CHARS`, `~/lib/tools/model-tool-payload.ts`) so the expansion never
 * produces text the model would not see anyway.
 */
const KNOWLEDGE_SIBLING_MAX_CHARS = 8_000;

/** B0-873 — the unlocked, knowledge-only pass merged into a line-filtered retrieval. */
function searchKnowledgeSupplement(
  query: string,
  excludeKnowledgeCategories: string[],
): Promise<RagSearchResult> {
  return searchProductChunks({
    query,
    limit: KNOWLEDGE_SUPPLEMENT_FETCH_LIMIT,
    scope: 'knowledge',
    useHybrid: true,
    useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
    excludeKnowledgeCategories,
  });
}

/**
 * B0-873 — line-filtered matches first, then knowledge matches not already present (by
 * `chunk_id`). Order only matters for tie-breaks: `selectCuratedMatches` re-sorts by `similarity`
 * and the two passes report the same raw cosine measure (both come from the same
 * `match_corpus_chunks_hybrid` RPC against the same query embedding), so the merged pool ranks
 * honestly across kinds.
 */
function mergeKnowledgeSupplement(
  primary: RagSearchMatch[],
  supplement: RagSearchMatch[],
): RagSearchMatch[] {
  if (supplement.length === 0) {
    return primary;
  }
  const seen = new Set(primary.map((m) => m.chunk_id));
  return [...primary, ...supplement.filter((m) => !seen.has(m.chunk_id))];
}

/** B0-873 — final sources whose matched chunk came from the supplement pass only. */
function countSupplementSources(
  sources: CuratedSource[],
  primary: RagSearchMatch[],
  supplement: RagSearchMatch[],
): number {
  if (supplement.length === 0) {
    return 0;
  }
  const primaryIds = new Set(primary.map((m) => m.chunk_id));
  const supplementOnly = new Set(
    supplement.map((m) => m.chunk_id).filter((id) => !primaryIds.has(id)),
  );
  return sources.filter((s) => supplementOnly.has(s.chunkId)).length;
}

/**
 * B0-874 — widen the single highest-similarity source to its sibling chunks, ONLY when that source
 * is a `knowledge` document. A label/SDS/profile outranking every knowledge hit means the question
 * is product-centric and the default ±1 window stays.
 *
 * The seed set is every chunk of that document in the winning pass's raw candidate pool (`pool`):
 * these are chunks similarity already ranked as relevant but `maxPerDocument: 1` dropped (SZ#11:
 * "Wood Gym Floor Environmental FAQ Guide" chunk 10 won the slot at 0.609 while chunk 1 — the
 * humidity/temperature range the question asks for — sat at 0.601, one place below it). Each seed
 * is padded by `KNOWLEDGE_SIBLING_RADIUS`, and the whole body is capped at
 * `KNOWLEDGE_SIBLING_MAX_CHARS`. `documentBodyChunkIds` lists every chunk actually stitched, so the
 * audit trail stays truthful. Left untouched when the expansion would not add a chunk.
 *
 * Trigger: `proceduralIntent`, OR at least two pooled chunks of the top document. The second arm
 * exists because most of the B0-874 items match no depth pattern at all ("What humidity and
 * temperature should the gym be at…", "…what should I check first?", "How are dilution systems kept
 * secure…" all classify as the bare default) yet fail identically: the ranking put several sections
 * of one document in the pool and `maxPerDocument: 1` let exactly one 30–200-token section through.
 * Two pooled siblings is the ranking's own statement that the document — not one paragraph of it —
 * is the answer; a single pooled chunk never expands on its own.
 */
async function expandTopKnowledgeSource(
  sources: CuratedSource[],
  pool: RagSearchMatch[],
  options: { proceduralIntent: boolean },
): Promise<{
  sources: CuratedSource[];
  expansion: ProductKnowledgeRetrievalSummary['knowledgeSiblingExpansion'];
}> {
  const top = sources.reduce<CuratedSource | null>(
    (best, s) => (best === null || s.similarity > best.similarity ? s : best),
    null,
  );
  if (!top || top.documentKind !== 'knowledge') {
    return { sources, expansion: null };
  }

  const seeds = new Set<number>();
  for (const m of pool) {
    if (m.document_id === top.documentId) {
      seeds.add(m.chunk_index);
    }
  }
  if (seeds.size === 0 || (!options.proceduralIntent && seeds.size < 2)) {
    return { sources, expansion: null };
  }
  const chunkIndexes = [...seeds].sort((a, b) => a - b);

  const body = await assembleChunkIndexSetBody(
    { documentId: top.documentId, chunkIndexes },
    { radius: KNOWLEDGE_SIBLING_RADIUS, maxChars: KNOWLEDGE_SIBLING_MAX_CHARS },
  );
  if (body.chunkCount === 0 || body.chunkIds.length <= top.documentBodyChunkIds.length) {
    return { sources, expansion: null };
  }

  const expanded: CuratedSource = {
    ...top,
    documentBody: body.body,
    documentBodyChars: body.body.length,
    documentBodyChunkCount: body.chunkCount,
    documentBodyTruncated: body.truncated,
    documentBodyTokenEstimate: body.estimatedTokens,
    documentBodyChunkIds: body.chunkIds,
  };
  return {
    sources: sources.map((s) => (s === top ? expanded : s)),
    expansion: { documentId: top.documentId, title: top.title, chunkIndexes },
  };
}

/**
 * B0-892 — a knowledge document small enough that its ENTIRE `body_text` is cheaper than the
 * narrower neighbour window B0-547 assembles by default. VCT#run-343c1918 ("how soon can people
 * walk on the VCT floor after the last coat?") retrieved a correct-topic-adjacent-but-wrong
 * document ("vct finish dry time between coats", the BETWEEN-coats rule) instead of the two
 * correct reopening-to-traffic knowledge documents that exist in the corpus
 * ("VCT Reopening to Traffic", 3,281 chars; "vct finish open to traffic timing", 610 chars — both
 * confirmed live, both well under this threshold). B0-874 already gives the whole body to the
 * SINGLE top-ranked knowledge source when it is corroborated by 2+ pooled chunks or the question is
 * procedural; this extends the same "cheap because the whole doc is small" logic to every knowledge
 * source in the top 3, unconditionally, so a correct document that ranked #2 or #3 — and so never
 * qualified for B0-874's narrower trigger — still reaches the model whole instead of as a
 * possibly-irrelevant ±1-chunk snippet.
 *
 * B0-973 — the threshold is the model-facing body cap (`MODEL_DOCUMENT_BODY_MAX_CHARS`, 8k), not a
 * separate 4k. The 4k cut left both Dilution Control golden failures (`084f0b3a`, `ce445e69`) with
 * chunks 0–2 of a 6,060-char / 4,417-char top document while the mandatory concept sat in chunk 4–7;
 * `buildModelDocumentPayload` already truncates anything over 8k, so widening to that cap adds no
 * new context ceiling.
 */
const SMALL_KNOWLEDGE_DOCUMENT_MAX_CHARS = MODEL_DOCUMENT_BODY_MAX_CHARS;
/** B0-892 — "top 3 retrieved sources", matching the model's own `search_product_docs` cap. */
const SMALL_KNOWLEDGE_DOCUMENT_TOP_N = 3;

/**
 * B0-892 — for knowledge-kind sources ranking in the top 3, swap in the document's FULL
 * `body_text` when the whole document is under `SMALL_KNOWLEDGE_DOCUMENT_MAX_CHARS` and doing so
 * actually adds content over what B0-547/B0-874 already assembled. Does not touch `maxPerDocument`
 * (B0-759 explicitly refuted raising that lever) — this only widens the ONE source slot's own body.
 */
export async function expandSmallTopKnowledgeSources(
  sources: CuratedSource[],
): Promise<CuratedSource[]> {
  const ranked = [...sources]
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, SMALL_KNOWLEDGE_DOCUMENT_TOP_N);
  const candidateIds = [
    ...new Set(
      ranked.filter((s) => s.documentKind === 'knowledge').map((s) => s.documentId),
    ),
  ];
  if (candidateIds.length === 0) {
    return sources;
  }

  // Fails open (empty map) on any error, same contract as `fetchEntityContexts` — a lookup outage
  // here must never fail the whole retrieval, only forgo the small-doc widening for this call.
  let bodyById = new Map<string, string>();
  try {
    const { data } = await getSupabaseServiceRoleClient()
      .schema('rag')
      .from('document')
      .select('id, body_text')
      .in('id', candidateIds)
      .limit(candidateIds.length);
    bodyById = new Map(
      (data ?? [])
        .filter((d): d is { id: string; body_text: string } => typeof d.body_text === 'string')
        .map((d) => [d.id, d.body_text]),
    );
  } catch {
    return sources;
  }
  const topIds = new Set(ranked.map((s) => s.documentId));

  return sources.map((source) => {
    if (source.documentKind !== 'knowledge' || !topIds.has(source.documentId)) {
      return source;
    }
    const fullBody = bodyById.get(source.documentId);
    if (
      !fullBody ||
      fullBody.length === 0 ||
      fullBody.length > SMALL_KNOWLEDGE_DOCUMENT_MAX_CHARS ||
      fullBody.length <= source.documentBodyChars
    ) {
      return source;
    }
    return {
      ...source,
      documentBody: fullBody,
      documentBodyChars: fullBody.length,
      documentBodyTruncated: false,
    };
  });
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
  // B0-700 — thread the SAME resolved-line outcome `withholdUnanchoredSafetySources` already used
  // for this query into `factsForSources`, so a structured dilution/efficacy fact gets the same
  // "no resolved line, no regulated content attributable" treatment as an SDS.
  const lockedProductLineKey = base.retrieval.productLineResolution?.lockedProductLineKey ?? null;
  // B0-892 — independent of entity context / facts (neither reads `documentBody`), so it runs
  // concurrently with them rather than stacking another round trip after.
  const [entityContextBlock, { facts, factsBlock }, expandedSources] = await Promise.all([
    entityContextBlockForSources(base.sources),
    factsForSources(base.sources, lockedProductLineKey, {
      sourcesMayBeUnfiltered: base.retrieval.strategy === 'anchored_with_broad_fallback',
    }),
    expandSmallTopKnowledgeSources(base.sources),
  ]);
  return { ...base, sources: expandedSources, entityContextBlock, facts, factsBlock };
}

export async function ragQueryForProductKnowledge(input: {
  query: string;
  limit?: number;
  productLineKey?: string | null;
  productKey?: string | null;
  /** B0-479: source of `productLineKey`, when the caller resolved it via `resolveProductEntityByName`. */
  productLineKeySource?: ProductEntityResolutionSource;
  skipProductLineResolution?: boolean;
  /** B0-780: see `runProductKnowledgeQuery`. */
  excludeKnowledgeCategories?: string[];
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
  /**
   * B0-479: which `resolveProductEntityByName` branch produced `productLineKey`, if the caller
   * resolved it that way. Threaded into `retrieval.explicitKeySource` when `productLineKey` is
   * used as an explicit anchor, so eval telemetry can distinguish alias-anchored resolutions.
   * Omit (or pass a plain string key from elsewhere) and the summary reports `'unspecified'`.
   */
  productLineKeySource?: ProductEntityResolutionSource;
  /** When true, skip candidate resolution (caller already anchored the query, e.g. by product id). */
  skipProductLineResolution?: boolean;
  /** Restrict retrieval to chunks belonging to a specific GHS section. Null = no filter. */
  sectionType?: string | null;
  /** Diversity cap per parent document (default 1). Raise for single-product depth. */
  maxPerDocument?: number;
  /** Override which document kinds are guaranteed a slot. Default: profile + sds + knowledge. */
  requiredDocumentKinds?: string[];
  /**
   * B0-780 — excludes `knowledge`-kind sources whose S3-folder category (see
   * `deriveKnowledgeCategoryFromS3Key`, `~/lib/rag/search.ts`) is in this list, on every
   * `searchProductChunks` call this function makes. Set by `resolveKnowledgeCategoryExclusions`
   * (`~/lib/tools/product-tools.ts`) to bind a floor/bathroom specialist call to its own
   * product-line domain. Omit (or pass `[]`) for no restriction.
   */
  excludeKnowledgeCategories?: string[];
  /**
   * B0-786 — ADDITIVE label-first signal from the pre-orchestration signals call. OR'd with the
   * deterministic checks inside `resolveRequiredDocumentKinds`; ignored entirely when the caller
   * passes an explicit `requiredDocumentKinds`, exactly like the deterministic checks are.
   */
  regulatedSectionIntent?: boolean;
  /**
   * B0-873/B0-874 — the question is procedural/enumeration-shaped (`classifyRetrievalIntent`'s
   * `procedural`, `~/lib/tools/product-tools.ts`). Enables the unlocked knowledge supplement on
   * line-filtered paths (`usedKnowledgeSupplement`) and the top-knowledge-source sibling expansion
   * (`knowledgeSiblingExpansion`). Omitted by every other caller, whose retrieval is unchanged.
   */
  proceduralIntent?: boolean;
}): Promise<ProductKnowledgeQueryBase> {
  const retrievalStartedAt = performance.now();
  const limit = input.limit ?? DEFAULT_UNIQUE_DOCUMENT_LIMIT;
  const explicitKey = input.productLineKey?.trim() || null;
  const explicitProductKey = input.productKey?.trim() || null;
  const sectionType = input.sectionType?.trim() || null;
  const maxPerDocument = input.maxPerDocument;
  const requiredDocumentKinds =
    input.requiredDocumentKinds ??
    resolveRequiredDocumentKinds(input.query, sectionType, input.regulatedSectionIntent);
  const excludeKnowledgeCategories = input.excludeKnowledgeCategories ?? [];
  const proceduralIntent = input.proceduralIntent === true;
  // B0-873 — a regulated (label-governed) question never gets unlocked knowledge merged into a
  // locked retrieval, whatever its shape: "how long is the contact time for <SKU>" is procedural
  // by phrasing but its answer must come from the locked line's label/SDS alone (B0-693).
  const knowledgeSupplementEligible =
    proceduralIntent &&
    !isLabelGovernedQuery(input.query, sectionType, input.regulatedSectionIntent);

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
    // B0-873 — the unlocked knowledge pass runs alongside the line-filtered search (it depends only
    // on the query), so a procedural question pays wall clock for one search, not two.
    const [result, knowledgeResult, lineTierResult] = await Promise.all([
      searchProductChunks({
        query: input.query,
        limit: SIMILARITY_CANDIDATE_FETCH_LIMIT,
        productLineKey: explicitKey,
        productKey: explicitProductKey ?? undefined,
        scope: 'all',
        useHybrid: true,
        useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
        excludeKnowledgeCategories,
      }),
      knowledgeSupplementEligible
        ? searchKnowledgeSupplement(input.query, excludeKnowledgeCategories)
        : Promise.resolve(null),
      /**
       * B0-958 — the same line, WITHOUT the product-key predicate. SDS and profiles hang off the
       * line-tier entity (`LINE_TIER_DOCUMENT_KINDS`), so a SKU-anchored search can never return
       * them: "Best Scent Lemon Zest" resolves to line `226` with `product_key 22604`, and that
       * search sees only the product's own label while the line's ten SDS sit one predicate away.
       * Run concurrently (it is needed on practically every SKU-anchored call, since `sds` is
       * always a required kind) and reused by both the B0-250 empty-pool fallback below and the
       * B0-556 kind supplement. Filtered by the SAME `explicitKey` in SQL, so it can never
       * introduce another product line's document.
       */
      explicitProductKey
        ? searchProductChunks({
            query: input.query,
            limit: SIMILARITY_CANDIDATE_FETCH_LIMIT,
            productLineKey: explicitKey,
            scope: 'all',
            useHybrid: true,
            useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
            excludeKnowledgeCategories,
          })
        : Promise.resolve(null),
    ]);
    const supplementMatches = knowledgeResult?.matches ?? [];

    // Selection over the LINE-FILTERED matches only. The B0-250 fallback decision below must keep
    // reading the locked line's own evidence: if it looked at the merged pool, a knowledge hit
    // would mask an empty product-key search and the line-level retry would never run.
    let lineSelected = await selectCuratedSourceMatches(result.matches, {
      limit,
      requiredDocumentKinds,
      maxPerDocument,
    });

    // B0-250: thin coverage at the product tier -- fall back to the line-scoped search
    // rather than surfacing nothing (there is no product-tier chunked content yet, so this
    // mainly guards against a resolved product_key that doesn't validate as a variant).
    let usedProductKeyFallback = false;
    let usedLineKindSupplement = false;
    // Every similarity search performed on this path, so `searchMs` below counts the B0-250
    // fallback / B0-958 line-tier search too instead of silently under-reporting it.
    let searchMsTotal =
      result.timings.similaritySearchMs +
      (knowledgeResult?.timings.similaritySearchMs ?? 0) +
      (lineTierResult?.timings.similaritySearchMs ?? 0);
    // B0-490 — raw candidates behind the winning pass (starts as the explicit-key search's
    // matches; replaced wholesale if the B0-250 product-key fallback below actually ran, or
    // widened by the B0-958 line-tier merge).
    let rawMatches = result.matches;
    // B0-493 — the winning `RagSearchResult`, same replacement rule as `rawMatches` above.
    let winningResult: RagSearchResult = result;
    if (lineSelected.length === 0 && lineTierResult) {
      // B0-250 — the product-key pool curated to nothing; the line-scoped pass (already awaited
      // above, and already counted in `searchMsTotal`) becomes the winning pass wholesale.
      rawMatches = lineTierResult.matches;
      winningResult = lineTierResult;
      lineSelected = await selectCuratedSourceMatches(lineTierResult.matches, {
        limit,
        requiredDocumentKinds,
        maxPerDocument,
      });
      usedProductKeyFallback = true;
    } else if (lineTierResult) {
      /**
       * B0-958 / B0-556 — the product-key pool answered, but is missing a required kind that only
       * exists at the line tier (an SDS, a profile). Merge the line-scoped pool in and re-curate
       * under the same limit / kinds / per-document cap, so the SDS earns its reserved slot on the
       * merged ranking instead of being structurally absent. Only fires when the merge actually
       * adds a candidate, so a SKU whose line has no SDS is unchanged.
       */
      const missingLineTierKinds = requiredDocumentKinds.filter(
        (kind) =>
          LINE_TIER_DOCUMENT_KINDS.has(kind) &&
          !result.matches.some((m) => m.document_kind?.toLowerCase() === kind),
      );
      if (missingLineTierKinds.length > 0) {
        const merged = mergeKnowledgeSupplement(result.matches, lineTierResult.matches);
        if (merged.length > result.matches.length) {
          rawMatches = merged;
          lineSelected = await selectCuratedSourceMatches(merged, {
            limit,
            requiredDocumentKinds,
            maxPerDocument,
          });
          usedLineKindSupplement = true;
        }
      }
    }

    // Without a supplement this is exactly the previous `curateUniqueDocumentSources` (select ->
    // hydrate). With one, the line pool and the knowledge pool are curated TOGETHER under the same
    // limit / kinds / per-document cap, so a knowledge document earns a slot on similarity like any
    // other candidate rather than being bolted on.
    const explicitPool = mergeKnowledgeSupplement(rawMatches, supplementMatches);
    const curated =
      supplementMatches.length === 0
        ? await hydrateCuratedSources(lineSelected)
        : await curateUniqueDocumentSources(explicitPool, {
            limit,
            requiredDocumentKinds,
            maxPerDocument,
          });
    const { sources: explicitSources, expansion: explicitExpansion } =
      await expandTopKnowledgeSource(curated, explicitPool, { proceduralIntent });

    return {
      sources: explicitSources,
      retrieval: {
        strategy: 'explicit_product_line',
        cacheSource: result.embeddingSource,
        searchMs: searchMsTotal,
        retrievalPhaseMs: retrievalElapsedMs(retrievalStartedAt),
        initialSearchMs: result.timings.similaritySearchMs,
        anchoredSearchMs: result.timings.similaritySearchMs,
        usedBroadFallback: false,
        usedProductKeyFallback,
        usedLineKindSupplement,
        usedKnowledgeSupplement: knowledgeResult !== null,
        knowledgeSupplementCuratedCount: countSupplementSources(
          curated,
          rawMatches,
          supplementMatches,
        ),
        knowledgeSiblingExpansion: explicitExpansion,
        // Line-filtered in SQL; nothing to withhold.
        withheldUnanchoredSdsCount: 0,
        broadCuratedCount: curated.length,
        anchoredCuratedCount: curated.length,
        explicitKeySource: input.productLineKeySource ?? 'unspecified',
        productLineResolution: {
          candidates: [],
          lockedProductLineKey: explicitKey,
          lockReason: 'explicit_filter',
          // B0-693 — mirrors the sibling `explicitKeySource` above so the distinction survives
          // into `final_output.productLineLock` (see `productLineLockSchema`'s doc comment).
          explicitKeySource: input.productLineKeySource ?? 'unspecified',
        },
        // Line-only on purpose (the score `evaluateRecommendationGate` was calibrated against);
        // the supplement's candidates are reported through `knowledgeSupplementCuratedCount`.
        rawTopSimilarity: maxSimilarity(rawMatches),
        selectedTopSimilarity: maxSimilarity(curated),
        droppedByFilterCount: Math.max(0, explicitPool.length - curated.length),
        search: buildSearchDetails(winningResult, { productLineKey: explicitKey }),
        selection: buildSelectionDetails({ limit, maxPerDocument, requiredDocumentKinds }),
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
      excludeKnowledgeCategories,
    });

    const requiredDocumentKindsForSkip = resolveRequiredDocumentKinds(input.query, sectionType);
    const curatedRaw = await curateUniqueDocumentSources(result.matches, {
      limit,
      maxPerDocument,
      requiredDocumentKinds: requiredDocumentKindsForSkip,
    });

    // B0-556 — no line was resolved, so no SDS can be attributed to this product. In practice this
    // path searches `scope: 'products'` (profiles only) and withholds nothing; kept as a guard so
    // the invariant does not depend on that scope staying narrow.
    const { sources: curated, withheldCount: withheldSds } = withholdUnanchoredSafetySources(
      curatedRaw,
      null,
    );

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
        usedLineKindSupplement: false,
        // Unlocked `scope: 'products'` search: no line filter to supplement, and no knowledge
        // documents in the pool to expand.
        usedKnowledgeSupplement: false,
        knowledgeSupplementCuratedCount: 0,
        knowledgeSiblingExpansion: null,
        withheldUnanchoredSdsCount: withheldSds,
        broadCuratedCount: curated.length,
        anchoredCuratedCount: 0,
        explicitKeySource: null,
        productLineResolution: {
          candidates: [],
          lockedProductLineKey: null,
          lockReason: 'resolution_disabled',
          explicitKeySource: null,
        },
        rawTopSimilarity: maxSimilarity(result.matches),
        selectedTopSimilarity: maxSimilarity(curated),
        search: buildSearchDetails(result),
        selection: buildSelectionDetails({
          limit,
          maxPerDocument,
          requiredDocumentKinds: requiredDocumentKindsForSkip,
        }),
        droppedByFilterCount: Math.max(0, result.matches.length - curated.length),
      },
    };
  }

  const broadResult = await searchProductChunks({
    query: input.query,
    limit: SIMILARITY_CANDIDATE_FETCH_LIMIT,
    scope: 'all',
    useHybrid: true,
    useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
    excludeKnowledgeCategories,
  });

  // B0-693 — margin-over-runner-up corroboration is now required UNCONDITIONALLY, not only when
  // `sectionType !== null`. The `sectionType`-only carve-out was confirmed incomplete: a general
  // query with no explicit GHS section (e.g. "what is the dilution ratio for DAILY DISINFECT" via
  // `search_product_docs`'s freeform path, which never sets `sectionType`) still hit the bare
  // absolute-threshold shortcut with zero corroboration -- a close, uncorroborated runner-up could
  // silently win (confirmed live: workflow run 61cc4ce9-bc1b-4d08-9b88-bc7d52c7365b locked "Sen
  // Emerging Storm Con" at 0.6876 over a runner-up at 0.6843, a ~0.003 spread, well under
  // `MIN_LOCK_MARGIN`). Reaching this broad-probe path at all already means alias resolution
  // (`resolveProductEntityByName`, upstream in product-tools.ts) found no confident match --
  // otherwise the `explicitKey` branch above would have anchored retrieval instead -- so alias
  // resolution having declined is already an intrinsic property of every call that gets here; no
  // separate signal needs to be threaded through for that. Removing the carve-out costs nothing on
  // a genuinely clear top score: when there is no runner-up, or a wide spread, the margin check
  // passes trivially (see `resolveProductLineFromMatches`'s `spread` default of `1` with no second
  // candidate) -- it only changes the outcome for exactly the thin-margin case this ticket reports.
  // B0-757 — the three lock thresholds now come from `public.settings` (admin-editable), not the
  // hardcoded fallbacks baked into `resolveProductLineFromMatches` itself; those stay as the
  // function's own defaults for its unit tests and for any other caller.
  const lockThresholds = await getProductLineLockThresholds();
  const resolution = resolveProductLineFromMatches(broadResult.matches, {
    requireMarginForHighConfidence: true,
    minLockSimilarity: lockThresholds.minLockSimilarity,
    minLockMargin: lockThresholds.minLockMargin,
    highConfidenceAbsolute: lockThresholds.highConfidenceAbsolute,
    // B0-873 — a knowledge document that outranks every product-line candidate must never be
    // pushed aside by a lock (which would filter it out of the anchored search entirely). Applied
    // for every query shape, not only procedural ones: VCT#17 ("what stripping and finish products
    // should I use for my VCT floor?") matched no depth pattern yet locked "Hard Film Floor Finish"
    // at 0.578 under eighteen higher-scoring VCT knowledge chunks. The B0-693 margin rule is
    // untouched — this only ADDS a reason to decline, never a reason to lock.
    skipLockWhenKnowledgeOutranks: true,
  });
  const requiredDocumentKindsForQuery = resolveRequiredDocumentKinds(input.query, sectionType);

  // B0-438: start broad candidate selection now, but do not await it yet. The anchored search
  // needs only `resolution` (derived from the broad *matches*), so the two are independent and
  // overlap below instead of stacking two full round-trip chains on the critical path.
  const broadSelectedPromise = selectCuratedSourceMatches(broadResult.matches, {
    limit,
    // B0-759 follow-up — this branch dropped `maxPerDocument` entirely, so a caller asking for
    // several excerpts of one procedural document silently got `?? 1`. That is precisely the path
    // an unlocked query takes, which is where the B0-759 F cases landed: they received the widened
    // `limit` and none of the widened depth.
    maxPerDocument,
    requiredDocumentKinds: requiredDocumentKindsForQuery,
    // B0-974 — nothing locked means this pass is genuinely unanchored: a profile slot must not
    // displace a knowledge chunk that similarity ranked above it. With a lock, the broad pass is
    // only the thin-evidence fallback and keeps the reservation exactly as before.
    productAnchored: resolution.lockedProductLineKey != null,
  });

  if (resolution.lockedProductLineKey == null) {
    const broadHydrated = await hydrateCuratedSources(await broadSelectedPromise);
    // B0-556 — corpus-wide search with no line filter and nothing resolved: every SDS here belongs
    // to an arbitrary product line, so none of it may ground a hazard answer.
    const { sources: broadCurated, withheldCount: withheldSds } = withholdUnanchoredSafetySources(
      broadHydrated,
      null,
    );
    // B0-874 — unlocked pass: knowledge documents are already in the pool, so only the sibling
    // expansion applies here (no supplement to merge).
    const { sources: broadSources, expansion: broadExpansion } = await expandTopKnowledgeSource(
      broadCurated,
      broadResult.matches,
      { proceduralIntent },
    );
    return {
      sources: broadSources,
      retrieval: {
        strategy: 'broad_only',
        cacheSource: broadResult.embeddingSource,
        searchMs: broadResult.timings.similaritySearchMs,
        retrievalPhaseMs: retrievalElapsedMs(retrievalStartedAt),
        initialSearchMs: broadResult.timings.similaritySearchMs,
        anchoredSearchMs: null,
        usedBroadFallback: false,
        usedProductKeyFallback: false,
        usedLineKindSupplement: false,
        usedKnowledgeSupplement: false,
        knowledgeSupplementCuratedCount: 0,
        knowledgeSiblingExpansion: broadExpansion,
        withheldUnanchoredSdsCount: withheldSds,
        broadCuratedCount: broadCurated.length,
        anchoredCuratedCount: 0,
        explicitKeySource: null,
        // B0-693 — this branch only runs when `resolution.lockedProductLineKey` is null (nothing
        // locked), so there is genuinely no key source to mirror here.
        productLineResolution: { ...resolution, explicitKeySource: null },
        rawTopSimilarity: maxSimilarity(broadResult.matches),
        selectedTopSimilarity: maxSimilarity(broadCurated),
        droppedByFilterCount: Math.max(0, broadResult.matches.length - broadCurated.length),
        search: buildSearchDetails(broadResult),
        selection: buildSelectionDetails({
          limit,
          maxPerDocument,
          requiredDocumentKinds: requiredDocumentKindsForQuery,
        }),
      },
    };
  }

  const [broadSelected, anchoredResult, anchoredKnowledgeResult] = await Promise.all([
    broadSelectedPromise,
    searchProductChunks({
      query: input.query,
      limit: SIMILARITY_CANDIDATE_FETCH_LIMIT,
      productLineKey: resolution.lockedProductLineKey,
      scope: 'all',
      useHybrid: true,
      useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
      excludeKnowledgeCategories,
    }),
    // B0-873 — the anchored search below is line-filtered in SQL exactly like the explicit-key
    // path, so a broad-probe lock starves knowledge documents the same way; same remedy, run
    // concurrently with the anchored search. Only reached once a line actually locked, so an
    // unlocked query never pays for it.
    knowledgeSupplementEligible
      ? searchKnowledgeSupplement(input.query, excludeKnowledgeCategories)
      : Promise.resolve(null),
  ]);
  const anchoredSupplementMatches = anchoredKnowledgeResult?.matches ?? [];
  const anchoredPool = mergeKnowledgeSupplement(anchoredResult.matches, anchoredSupplementMatches);

  const anchoredSelected = await selectCuratedSourceMatches(anchoredPool, {
    limit,
    // B0-759 follow-up — same omission as the broad pass above; both must agree or the fallback
    // comparison below would weigh two passes curated under different rules.
    maxPerDocument,
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
  const finalHydrated = await hydrateCuratedSources(
    shouldUseBroadFallback ? broadSelected : anchoredSelected,
  );
  const strategy = shouldUseBroadFallback
    ? 'anchored_with_broad_fallback'
    : 'anchored_only';

  /**
   * B0-556 — the fallback hands over sources from the UNFILTERED broad pass even though a line was
   * resolved, which is how a correctly-resolved SKU ended up answered from another line's SDS. Only
   * SDS-kind sources actually on `lockedProductLineKey` survive. The `anchored_only` branch is left
   * alone: it is already line-filtered in SQL, and its sources may legitimately carry a null
   * `productLineKey` (the RPC also matches on `source_record.source_pk`).
   */
  const { sources: finalCurated, withheldCount: withheldSds } = shouldUseBroadFallback
    ? withholdUnanchoredSafetySources(finalHydrated, resolution.lockedProductLineKey)
    : { sources: finalHydrated, withheldCount: 0 };

  // B0-874 — expansion seeds come from whichever pool actually produced `finalCurated`.
  const winningPool = shouldUseBroadFallback ? broadResult.matches : anchoredPool;
  const { sources: finalSources, expansion: finalExpansion } = await expandTopKnowledgeSource(
    finalCurated,
    winningPool,
    { proceduralIntent },
  );

  return {
    sources: finalSources,
    retrieval: {
      strategy,
      cacheSource: anchoredResult.embeddingSource,
      searchMs:
        broadResult.timings.similaritySearchMs +
        anchoredResult.timings.similaritySearchMs +
        (anchoredKnowledgeResult?.timings.similaritySearchMs ?? 0),
      retrievalPhaseMs: retrievalElapsedMs(retrievalStartedAt),
      initialSearchMs: broadResult.timings.similaritySearchMs,
      anchoredSearchMs: anchoredResult.timings.similaritySearchMs,
      usedBroadFallback: shouldUseBroadFallback,
      usedProductKeyFallback: false,
      usedLineKindSupplement: false,
      // The supplement only reaches the model when the anchored pass wins; on a broad fallback the
      // sources come from the unfiltered broad pool, which already contained knowledge documents.
      usedKnowledgeSupplement: anchoredKnowledgeResult !== null && !shouldUseBroadFallback,
      knowledgeSupplementCuratedCount: shouldUseBroadFallback
        ? 0
        : countSupplementSources(finalCurated, anchoredResult.matches, anchoredSupplementMatches),
      knowledgeSiblingExpansion: finalExpansion,
      withheldUnanchoredSdsCount: withheldSds,
      broadCuratedCount: broadSelected.length,
      // Includes supplement-sourced knowledge selections when the supplement ran (see
      // `knowledgeSupplementCuratedCount` for how many).
      anchoredCuratedCount: anchoredSelected.length,
      // B0-693 — this branch only runs when `resolution.lockedProductLineKey` is non-null (the
      // no-lock case returns earlier above), so a real lock always came from the broad similarity
      // probe here — never an alias resolution, which would have taken the `explicit_product_line`
      // branch instead.
      explicitKeySource: 'broad_similarity_probe',
      productLineResolution: { ...resolution, explicitKeySource: 'broad_similarity_probe' },
      rawTopSimilarity: maxSimilarity(
        shouldUseBroadFallback ? broadResult.matches : anchoredResult.matches,
      ),
      selectedTopSimilarity: maxSimilarity(finalCurated),
      droppedByFilterCount: Math.max(0, winningPool.length - finalCurated.length),
      search: buildSearchDetails(shouldUseBroadFallback ? broadResult : anchoredResult),
      selection: buildSelectionDetails({
        limit,
          maxPerDocument,
        requiredDocumentKinds: requiredDocumentKindsForQuery,
      }),
    },
  };
}
