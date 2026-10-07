import {
  rankBySubstratePreference,
  resolveSubstratePreference,
  type ResolvedSubstratePreference,
  type SubstrateRankingInput,
} from '~/lib/rag/knowledge-substrate-ranking';
import { searchProductChunks, type RagSearchMatch, type RagSearchResult } from '~/lib/rag/search';
import {
  assembleDocumentBodies,
  fetchDocumentSourceRefs,
  type AssembledDocumentBody,
} from '~/lib/retrieval/document-assembly';
import { trimSnippet } from '~/lib/retrieval/source-selection';

/**
 * B0-529 — retrieval behind `get_dispenser_asset` / `get_floor_asset`.
 *
 * Both tools answer from the SAME corpus the rest of Bex already ingests: `rag.document` rows with
 * `document_kind = 'knowledge'` (procedure bulletins, coverage/coat guides, dilution-ratio guides,
 * training workbooks). There is no `dispenser_guide` or `coat_count_chart` document kind and none is
 * needed — the two tools differ only in the query they compose, not in where they look.
 *
 * Scoping is a HARD filter (`scope: 'knowledge'` in `~/lib/rag/search`, which applies an app-layer
 * `document_kind` filter with a matching over-fetch), not the soft `requiredDocumentKinds` slot
 * preference `ragQueryForProductKnowledge` uses — a "how many coats" answer must not be able to come
 * back grounded in an SDS or a marketing profile.
 *
 * REGULATED-DATA RULE: bodies are stitched verbatim from `rag.document_chunk.chunk_text`. Coat
 * counts, coverage figures (sq ft/gal), dilution ratios, oz/gal, dwell times, and EPA/DIN numbers are
 * never parsed, rounded, converted, or re-formatted here. The only edit applied is a TRAILING cut at
 * the per-document cap, which `assembleDocumentBodies` reports via `truncated`.
 */

/** Payload `adapter` tag, mirroring `ADAPTER_TAG` on the product tools. */
export const KNOWLEDGE_ASSET_ADAPTER_TAG = 'rag_knowledge_document' as const;

/** Default number of distinct knowledge documents returned. */
export const DEFAULT_KNOWLEDGE_ASSET_LIMIT = 3;

/** Hard ceiling on `maxResults`, mirrored by the Zod input schemas. */
export const MAX_KNOWLEDGE_ASSET_RESULTS = 5;

/**
 * Per-document assembly cap. Set to the model-facing document budget
 * (`DEFAULT_TOOL_DOCUMENT_CHAR_BUDGET`) so a body that would be cut anyway is cut ONCE, here, where
 * the `documentBodyTruncated` flag is set honestly — rather than arriving whole and being tail-cut
 * again by `enforceToolOutputBudget`.
 */
const KNOWLEDGE_ASSET_DOCUMENT_MAX_CHARS = 24_000;

/**
 * Candidate chunks fetched per document slot. Knowledge documents are chunked finely (1,279 chunks
 * across 73 documents), so several hits routinely land in the same document; over-fetching is what
 * makes `limit` distinct DOCUMENTS achievable.
 */
const CANDIDATE_CHUNKS_PER_DOCUMENT = 4;

/**
 * B0-1032 — candidate chunk floor used when the caller expresses a substrate preference.
 *
 * A preference can only reorder documents that are IN the candidate set, and at the default
 * over-fetch (3 documents x 4 chunks = 12) the substrate-specific document this ticket is about was
 * not in it: measured live, `vct floor maintenance frequency betco standard` first appears once the
 * candidate request reaches 20 chunks. 20 is also what `clampLimit` (`~/lib/rag/search.ts`) allows
 * at most, and it is what lifts the knowledge over-fetch in `resolveRerankPlan` to the full 200-row
 * RPC pool — so this is "ask for as deep a pool as the search layer will give", not a magic number.
 * Applied ONLY when a preference resolved, so every other knowledge-asset call keeps its existing
 * candidate set exactly.
 */
const SUBSTRATE_PREFERENCE_CANDIDATE_CHUNKS = 20;

const SNIPPET_MAX_CHARS = 900;

export type KnowledgeAssetSource = {
  documentId: string;
  /** The chunk that produced this document's best similarity score. */
  chunkId: string;
  title: string;
  snippet: string;
  documentBody: string;
  documentBodyChars: number;
  documentBodyChunkCount: number;
  documentBodyTruncated: boolean;
  documentBodyChunkIds: string[];
  /** Always `'knowledge'` — the scope is a hard filter, so this is an assertion, not a variable. */
  documentKind: string;
  similarity: number;
  /** Back-compat alias of `similarity`, matching `sourcePayload()` on the product tools. */
  confidence: number;
  s3Key: string | null;
  sourceUri: string | null;
};

export type KnowledgeAssetRetrievalSummary = {
  adapter: typeof KNOWLEDGE_ASSET_ADAPTER_TAG;
  /** Shaped for `toolRetrievalParamsSchema` (`~/lib/audit/trace`) so the call's trace carries it. */
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
  selection: {
    limit: number;
    /** One chunk per document: these tools return whole documents, never several windows of one. */
    maxPerDocument: number;
    requiredDocumentKinds: string[];
    candidateMatches: number;
    uniqueDocuments: number;
    /** B0-1032 — distinct documents the candidate chunks covered, before the `limit` cap. */
    candidateDocuments: number;
    /** B0-1032 — the order-only substrate preference applied, or `null` when none resolved. */
    substratePreference: {
      surfaceType: string;
      surfaceTerms: string[];
      topicTerms: string[];
      /** Candidate documents whose title named the substrate (score > 0). */
      boostedDocuments: number;
    } | null;
  };
};

export type KnowledgeAssetResult = {
  query: string;
  scope: 'knowledge';
  sources: KnowledgeAssetSource[];
  retrieval: KnowledgeAssetRetrievalSummary;
};

/** Joins the caller's anchoring fields into one retrieval query, collapsing whitespace. */
export function buildKnowledgeAssetQuery(parts: Array<string | null | undefined>): string {
  return parts
    .map((part) => part?.trim() ?? '')
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Best-scoring match per document, in descending similarity order (not yet capped). */
function bestMatchPerDocument(matches: RagSearchMatch[]): RagSearchMatch[] {
  const best = new Map<string, RagSearchMatch>();
  for (const match of matches) {
    const existing = best.get(match.document_id);
    if (!existing || match.similarity > existing.similarity) {
      best.set(match.document_id, match);
    }
  }
  return [...best.values()].sort((a, b) => b.similarity - a.similarity);
}

/**
 * B0-1032 — best match per document, substrate-preferred, capped at `limit`.
 *
 * The preference is applied to the WHOLE per-document candidate list before the cap, because the cap
 * is what drops the substrate-specific document today. Order-only: `similarity` is never rewritten,
 * and with no preference (or none that any candidate matches) this is the previous behaviour exactly
 * — descending similarity, sliced.
 */
function topMatchPerDocument(
  matches: RagSearchMatch[],
  limit: number,
  preference: ResolvedSubstratePreference | null,
): { selected: RagSearchMatch[]; candidateDocuments: number; boostedDocuments: number } {
  const perDocument = bestMatchPerDocument(matches);
  const { ranked, boostedCount } = rankBySubstratePreference(perDocument, preference);
  return {
    selected: ranked.slice(0, limit),
    candidateDocuments: perDocument.length,
    boostedDocuments: boostedCount,
  };
}

function toSource(
  match: RagSearchMatch,
  body: AssembledDocumentBody | undefined,
  sourceRef: { s3Key: string | null; sourceUri: string | null } | undefined,
): KnowledgeAssetSource {
  // Falling back to the matched chunk keeps a source citable even if whole-document assembly came
  // back empty for it; the chunk text is still verbatim.
  const documentBody = body?.body ?? match.chunk_text;

  return {
    documentId: match.document_id,
    chunkId: match.chunk_id,
    title: match.document_title,
    snippet: trimSnippet(match.chunk_text, SNIPPET_MAX_CHARS),
    documentBody,
    documentBodyChars: documentBody.length,
    documentBodyChunkCount: body?.chunkCount ?? 1,
    documentBodyTruncated: body?.truncated ?? false,
    documentBodyChunkIds: body?.chunkIds ?? [match.chunk_id],
    documentKind: match.document_kind,
    similarity: match.similarity,
    confidence: match.similarity,
    s3Key: sourceRef?.s3Key ?? null,
    sourceUri: sourceRef?.sourceUri ?? null,
  };
}

/**
 * Runs one knowledge-scoped search and returns up to `limit` distinct knowledge documents, each with
 * its full assembled body.
 *
 * Whole-document assembly (`assembleDocumentBodies`) rather than the chunk-window assembly the
 * product tools use: a coat-count chart, coverage table, or dispenser setting table is exactly the
 * kind of content a ±1-chunk window can cut in half, and half a dilution table is worse than none.
 */
export async function retrieveKnowledgeAssets(input: {
  query: string;
  limit?: number;
  /** B0-780: see `runProductKnowledgeQuery` (`~/lib/retrieval/product-knowledge.ts`). */
  excludeKnowledgeCategories?: string[];
  /**
   * B0-1032 — the caller's substrate/topic wording (`get_floor_asset`'s `surfaceType` +
   * `procedure`/`productName`), used as an ORDER-ONLY ranking preference over the candidate
   * documents. Never a filter: see `~/lib/rag/knowledge-substrate-ranking.ts`.
   */
  substrate?: SubstrateRankingInput;
}): Promise<KnowledgeAssetResult> {
  const query = input.query.trim();
  if (!query) {
    throw new Error('A knowledge asset query is required.');
  }

  const limit = Math.min(
    Math.max(Math.floor(input.limit ?? DEFAULT_KNOWLEDGE_ASSET_LIMIT), 1),
    MAX_KNOWLEDGE_ASSET_RESULTS,
  );

  const preference = resolveSubstratePreference(input.substrate);
  const candidateChunkLimit = preference
    ? Math.max(limit * CANDIDATE_CHUNKS_PER_DOCUMENT, SUBSTRATE_PREFERENCE_CANDIDATE_CHUNKS)
    : limit * CANDIDATE_CHUNKS_PER_DOCUMENT;

  const result = await searchProductChunks({
    query,
    limit: candidateChunkLimit,
    scope: 'knowledge',
    useHybrid: true,
    excludeKnowledgeCategories: input.excludeKnowledgeCategories,
  });

  const { selected, candidateDocuments, boostedDocuments } = topMatchPerDocument(
    result.matches,
    limit,
    preference,
  );
  const documentIds = selected.map((match) => match.document_id);

  const [bodies, sourceRefs] = await Promise.all([
    assembleDocumentBodies(documentIds, {
      maxCharsPerDocument: KNOWLEDGE_ASSET_DOCUMENT_MAX_CHARS,
    }),
    fetchDocumentSourceRefs(documentIds),
  ]);

  return {
    query,
    scope: 'knowledge',
    sources: selected.map((match) =>
      toSource(match, bodies.get(match.document_id), sourceRefs.get(match.document_id)),
    ),
    retrieval: {
      adapter: KNOWLEDGE_ASSET_ADAPTER_TAG,
      search: {
        model: result.model,
        limit: result.limit,
        scope: result.scope,
        productLineKey: result.productLineKey,
        productKey: result.productKey,
        sectionType: result.sectionType,
        minSimilarity: result.minSimilarity,
        retrievalStrategy: result.retrieval_strategy,
        embeddingSource: result.embeddingSource,
        timings: result.timings,
      },
      selection: {
        limit,
        maxPerDocument: 1,
        requiredDocumentKinds: ['knowledge'],
        candidateMatches: result.matches.length,
        uniqueDocuments: selected.length,
        candidateDocuments,
        substratePreference: preference
          ? {
              surfaceType: preference.surfaceType,
              surfaceTerms: preference.surfaceTerms,
              topicTerms: preference.topicTerms,
              boostedDocuments,
            }
          : null,
      },
    },
  };
}
