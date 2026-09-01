import { searchProductChunks, type RagSearchMatch, type RagSearchResult } from '~/lib/rag/search';
import {
  buildEntityContextBlock,
  fetchEntityContexts,
  type ProductEntityResolutionSource,
} from '~/lib/rag/entity-context';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import {
  assembleNeighborChunkBodies,
  chunkWindowKey,
  fetchDocumentSourceRefs,
  type AssembledDocumentBody,
  type DocumentSourceRef,
} from '~/lib/retrieval/document-assembly';
import {
  resolveProductLineFromMatches,
  type ProductLineResolutionResult,
} from '~/lib/retrieval/product-line-resolution';
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
   * "alias-anchored" retrieval from other explicit-key retrieval. `null` for every other strategy
   * (broad/anchored-via-similarity paths never have an explicit key to source).
   */
  explicitKeySource: ProductEntityResolutionSource | 'unspecified' | null;
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
  const [bodies, sourceRefs] = await Promise.all([
    assembleNeighborChunkBodies(windowRequests),
    fetchDocumentSourceRefs(documentIds),
  ]);

  return selected.map((match) =>
    buildCuratedSource(
      match,
      bodies.get(chunkWindowKey({ documentId: match.document_id, chunkIndex: match.chunk_index })),
      sourceRefs.get(match.document_id),
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
}): Promise<ProductKnowledgeQueryBase> {
  const retrievalStartedAt = performance.now();
  const limit = input.limit ?? DEFAULT_UNIQUE_DOCUMENT_LIMIT;
  const explicitKey = input.productLineKey?.trim() || null;
  const explicitProductKey = input.productKey?.trim() || null;
  const sectionType = input.sectionType?.trim() || null;
  const maxPerDocument = input.maxPerDocument;
  const requiredDocumentKinds =
    input.requiredDocumentKinds ?? resolveRequiredDocumentKinds(input.query, sectionType);
  const excludeKnowledgeCategories = input.excludeKnowledgeCategories ?? [];

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
      excludeKnowledgeCategories,
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
    // B0-490 — raw candidates behind the winning pass (starts as the explicit-key search's
    // matches; replaced wholesale if the B0-250 product-key fallback below actually ran).
    let rawMatches = result.matches;
    // B0-493 — the winning `RagSearchResult`, same replacement rule as `rawMatches` above.
    let winningResult: RagSearchResult = result;
    if (curated.length === 0 && explicitProductKey) {
      const lineResult = await searchProductChunks({
        query: input.query,
        limit: SIMILARITY_CANDIDATE_FETCH_LIMIT,
        productLineKey: explicitKey,
        scope: 'all',
        useHybrid: true,
        useReranker: PRODUCT_SUPPORT_RERANK_ENABLED,
        excludeKnowledgeCategories,
      });
      searchMsTotal += lineResult.timings.similaritySearchMs;
      rawMatches = lineResult.matches;
      winningResult = lineResult;
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
        usedLineKindSupplement: false,
        // Line-filtered in SQL; nothing to withhold.
        withheldUnanchoredSdsCount: 0,
        broadCuratedCount: curated.length,
        anchoredCuratedCount: curated.length,
        explicitKeySource: input.productLineKeySource ?? 'unspecified',
        productLineResolution: {
          candidates: [],
          lockedProductLineKey: explicitKey,
          lockReason: 'explicit_filter',
        },
        rawTopSimilarity: maxSimilarity(rawMatches),
        selectedTopSimilarity: maxSimilarity(curated),
        droppedByFilterCount: Math.max(0, rawMatches.length - curated.length),
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
        withheldUnanchoredSdsCount: withheldSds,
        broadCuratedCount: curated.length,
        anchoredCuratedCount: 0,
        explicitKeySource: null,
        productLineResolution: {
          candidates: [],
          lockedProductLineKey: null,
          lockReason: 'resolution_disabled',
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

  // B0-693 — a query targeting a specific GHS section (hazard, first aid, dilution/contact-time,
  // EPA reg, etc.) is regulated content: require the margin-over-runner-up check even when the top
  // score alone would otherwise clear the absolute confidence bar. General queries (`sectionType ===
  // null`) are unaffected — see `resolveProductLineFromMatches`'s doc comment.
  const resolution = resolveProductLineFromMatches(broadResult.matches, {
    requireMarginForHighConfidence: sectionType !== null,
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
  });

  if (resolution.lockedProductLineKey == null) {
    const broadHydrated = await hydrateCuratedSources(await broadSelectedPromise);
    // B0-556 — corpus-wide search with no line filter and nothing resolved: every SDS here belongs
    // to an arbitrary product line, so none of it may ground a hazard answer.
    const { sources: broadCurated, withheldCount: withheldSds } = withholdUnanchoredSafetySources(
      broadHydrated,
      null,
    );
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
        usedLineKindSupplement: false,
        withheldUnanchoredSdsCount: withheldSds,
        broadCuratedCount: broadCurated.length,
        anchoredCuratedCount: 0,
        explicitKeySource: null,
        productLineResolution: resolution,
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

  const [broadSelected, anchoredResult] = await Promise.all([
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
  ]);

  const anchoredSelected = await selectCuratedSourceMatches(anchoredResult.matches, {
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
      usedLineKindSupplement: false,
      withheldUnanchoredSdsCount: withheldSds,
      broadCuratedCount: broadSelected.length,
      anchoredCuratedCount: anchoredSelected.length,
      explicitKeySource: null,
      productLineResolution: resolution,
      rawTopSimilarity: maxSimilarity(
        shouldUseBroadFallback ? broadResult.matches : anchoredResult.matches,
      ),
      selectedTopSimilarity: maxSimilarity(finalCurated),
      droppedByFilterCount: Math.max(
        0,
        (shouldUseBroadFallback ? broadResult.matches.length : anchoredResult.matches.length) -
          finalCurated.length,
      ),
      search: buildSearchDetails(shouldUseBroadFallback ? broadResult : anchoredResult),
      selection: buildSelectionDetails({
        limit,
          maxPerDocument,
        requiredDocumentKinds: requiredDocumentKindsForQuery,
      }),
    },
  };
}
