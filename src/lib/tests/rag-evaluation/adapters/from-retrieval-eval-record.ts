/**
 * Adapter: Phase 0's `RetrievalEvalRecord` → Phase 3's {@link RetrievalEpisode}.
 *
 * Phase 0 (`src/lib/tests/retrieval-dataset.ts`) is the only layer that touches the database. This
 * file is the seam between it and the pure metric core: everything below `adapters/` consumes
 * `RetrievalEpisode` and nothing else, so a metric can be exercised against fixtures rather than
 * against whatever the local database happens to hold today.
 *
 * ## The three joins that are easy to get wrong
 *
 * **1. `retrieval_calls: null` must stay `null`.** Phase 0 is careful to distinguish `[]` ("this turn
 * ran no retrieval") from `null` ("the persisted payload predates the field, we cannot know"). The
 * adapter preserves that distinction verbatim. Defaulting `null` to `[]` would score every
 * historical run as having retrieved nothing — a fabricated regression indistinguishable from a real
 * one, and precisely the failure the contract's `calls` doc-comment warns about.
 *
 * **2. Rank comes from the returned ORDER, never from the score.** `RetrievalCallRecord.chunks` is
 * persisted in the order the retriever returned it, un-deduped and un-re-sorted. That order is the
 * fact; sorting by `similarity` or `rerank_score` to derive rank is an inference, and the two diverge
 * exactly where it matters — on ties, and on any call whose scores are all `null` (a synthetic or
 * non-scoring source), where a sort would silently invent a ranking. So `rank` is the array index,
 * 0-based, per call. `rerankRank` is carried through from the row and left `null` when the reranker
 * did not run; it is never back-filled from position.
 *
 * **3. Chunk text lives on `contexts`, not on the call.** `RetrievalCallRecord.chunks` carries ids
 * and scores only. Text, title, kind and the resolution reason live on the separately-resolved
 * `contexts` array, which is the *deduplicated union* across all calls for the turn. The adapter
 * joins them on `chunk_id`, falling back to `document_id` for metadata (title/kind) when a ranked
 * chunk carries no chunk id.
 *
 * A ranked chunk with no matching context is **kept as a candidate**, never dropped: dropping it
 * would shorten the ranked list and quietly improve precision@k for a turn whose join went stale.
 * It is instead given the resolution it would have received had `resolveContext` seen it, computed
 * with the same rules minus the database lookup:
 *
 * - no `chunk_id` → `no_chunk_id`
 * - non-uuid `chunk_id` → `synthetic` (verified-facts blocks, lab reports — these never had a row)
 * - uuid `chunk_id`, no context → `missing` (a real id whose text we could not obtain)
 *
 * **`coverage` is carried through unchanged.** It is computed over the deduplicated `contexts`
 * union, not over the ranked lists, and recomputing it from candidates would double-count any chunk
 * retrieved by more than one call — turning a multi-call turn's coverage into a different number
 * from the one Phase 0 reported for the same turn.
 */

import type {
  RetrievalEvalRecord,
  ResolvedContext,
} from '~/lib/tests/retrieval-dataset';
import type { RetrievalCallRecord } from '~/lib/workflows/product-support/product-support-schemas';

import type {
  ContextResolution,
  Coverage,
  RankedCandidate,
  RetrievalCall,
  RetrievalEpisode,
} from '../types';

/**
 * Same pattern Phase 0 screens with. Duplicated rather than imported because it is a *classification*
 * rule here, not a query guard, and the eval core must be able to reason about a reference without a
 * database round trip.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Run-level facts a single `RetrievalEvalRecord` does not carry. */
export type EpisodeContext = {
  runId: string;
  questionSetId: string;
  questionSetName: string | null;
};

/**
 * Resolution for a ranked chunk that no `contexts` entry matched.
 *
 * Mirrors `resolveContext` in Phase 0 with the chunk-row lookup removed — the absence of a context
 * entry stands in for the absent row.
 */
export function classifyUnmatchedChunk(chunkId: string | null): ContextResolution {
  if (!chunkId) return 'no_chunk_id';
  if (!UUID_PATTERN.test(chunkId)) return 'synthetic';
  return 'missing';
}

type ContextIndex = {
  byChunkId: Map<string, ResolvedContext>;
  byDocumentId: Map<string, ResolvedContext>;
};

/**
 * Indexes a turn's resolved contexts for the join. First entry wins on collision: `contexts` is
 * already deduplicated by Phase 0, and for the document-id fallback the first reference to a
 * document is as good a source of title/kind as any later one.
 */
export function indexContexts(contexts: ResolvedContext[]): ContextIndex {
  const byChunkId = new Map<string, ResolvedContext>();
  const byDocumentId = new Map<string, ResolvedContext>();
  for (const context of contexts) {
    if (context.chunk_id && !byChunkId.has(context.chunk_id)) {
      byChunkId.set(context.chunk_id, context);
    }
    if (!byDocumentId.has(context.document_id)) {
      byDocumentId.set(context.document_id, context);
    }
  }
  return { byChunkId, byDocumentId };
}

/** Joins one persisted call's chunks onto resolved text, preserving the retriever's order as rank. */
export function toRetrievalCall(call: RetrievalCallRecord, index: ContextIndex): RetrievalCall {
  const candidates: RankedCandidate[] = call.chunks.map((chunk, position) => {
    const matched = chunk.chunk_id ? index.byChunkId.get(chunk.chunk_id) : undefined;
    // Metadata-only fallback: gives an unmatched candidate a title/kind so `excludeKinds` and
    // reporting still work. It is never used for `text` or `resolution`, which must describe THIS
    // chunk, not some other chunk of the same document.
    const documentFallback = index.byDocumentId.get(chunk.document_id);

    return {
      documentId: chunk.document_id,
      chunkId: chunk.chunk_id,
      documentKind: matched?.document_kind ?? documentFallback?.document_kind ?? null,
      documentTitle: matched?.document_title ?? documentFallback?.document_title ?? null,
      rank: position,
      similarity: chunk.similarity,
      rerankScore: chunk.rerank_score,
      rerankRank: chunk.rerank_rank,
      text: matched?.resolution === 'resolved' ? matched.text : null,
      resolution: matched ? matched.resolution : classifyUnmatchedChunk(chunk.chunk_id),
    };
  });

  return {
    toolName: call.tool_name,
    callId: call.call_id,
    strategy: call.retrieval_strategy,
    candidates,
  };
}

/** Structural copy of Phase 0's coverage block. Values are carried through unchanged. */
function toCoverage(coverage: RetrievalEvalRecord['coverage']): Coverage {
  return {
    requested: coverage.requested,
    resolved: coverage.resolved,
    missing: coverage.missing,
    synthetic: coverage.synthetic,
    noChunkId: coverage.noChunkId,
    resolvedShare: coverage.resolvedShare,
  };
}

/**
 * Maps one Phase 0 record onto one scoreable episode.
 *
 * `episodeId` is the `test_result_item_id`: unique per (run, item), which is exactly the grain a
 * metric consumes, and stable enough to diff two snapshots of the same run.
 */
export function toRetrievalEpisode(
  record: RetrievalEvalRecord,
  context: EpisodeContext,
): RetrievalEpisode {
  const index = indexContexts(record.contexts);

  return {
    episodeId: record.test_result_item_id,
    itemId: record.test_item_id,
    runId: context.runId,
    questionSetId: context.questionSetId,
    questionSetName: context.questionSetName,
    rowIndex: record.row_index,
    question: record.user_input,
    answer: record.response_text,
    reference: record.reference,
    passed: record.passed,
    // Null in, null out. See the header — this is the one line most likely to be "helpfully" fixed.
    calls:
      record.retrieval_calls === null
        ? null
        : record.retrieval_calls.map((call) => toRetrievalCall(call, index)),
    coverage: toCoverage(record.coverage),
  };
}

/** Batch form. Order is preserved so `rowIndex` order survives into the snapshot. */
export function toRetrievalEpisodes(
  records: RetrievalEvalRecord[],
  context: EpisodeContext,
): RetrievalEpisode[] {
  return records.map((record) => toRetrievalEpisode(record, context));
}
