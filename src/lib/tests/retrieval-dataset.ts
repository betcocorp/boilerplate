import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import {
  extractRetrievedDocumentChunks,
  extractRetrievalCalls,
} from '~/lib/tests/response-payload';
import type { RetrievalCallRecord } from '~/lib/workflows/product-support/product-support-schemas';
import type { TestItemRecord, TestResultItemRecord } from '~/lib/tests/types';

/**
 * Phase 0 of the RAG evaluation process (`src/docs/rag-evaluation-process.md`): turn a graded run's
 * persisted rows into the `(question, retrieved contexts, answer, reference)` records every
 * retrieval metric needs.
 *
 * ## Why the chunk text is joined here and not persisted at run time
 *
 * `test_result_items.response_payload` stores chunk *references* (`document_id` / `chunk_id`), never
 * chunk text. Storing the text at write time would duplicate the corpus into the results table for
 * no gain — the chunks are immutable between ingests, so the text can always be fetched back by id.
 * Joining at read time also keeps the runtime path untouched: nothing about a production turn
 * changes to make it measurable.
 *
 * The price is that the join can go stale, and it is a *silent* staleness: a corpus re-ingest mints
 * new `rag.document_chunk.id`s, and every reference written before it becomes a dangling join that
 * resolves to nothing. Scored naively that reads as a retrieval collapse — chunks "missing" that
 * were in fact retrieved perfectly well. Hence {@link RetrievalCoverage}: resolution is counted and
 * reported per item, and a caller that scores an item without checking coverage is scoring noise.
 */

/** A retrieved chunk with its text resolved (or the record of why it could not be). */
export type ResolvedContext = {
  document_id: string;
  chunk_id: string | null;
  document_title: string | null;
  document_kind: string | null;
  product_line_key: string | null;
  /** Chunk body from `rag.document_chunk.chunk_text`; null when unresolved. */
  text: string | null;
  heading: string | null;
  chunk_index: number | null;
  resolution: ContextResolution;
};

/**
 * Why a chunk reference does or does not have text.
 *
 * - `resolved` — joined to a live `rag.document_chunk` row.
 * - `missing` — a real chunk id that no longer exists. Almost always a corpus re-ingest since the
 *   run; occasionally a deleted document (corpus scoping purges, B0-283).
 * - `synthetic` — never was a corpus chunk: verified-facts blocks, lab reports and their composite
 *   `verified-facts:<productLineKey>` ids. These are legitimately retrieved and legitimately have no
 *   `document_chunk` row, so they are neither an error nor a corpus hit — counted apart from both.
 * - `no_chunk_id` — the reference carried a `document_id` but no `chunk_id` (legacy `sources`
 *   fallback rows).
 */
export type ContextResolution = 'resolved' | 'missing' | 'synthetic' | 'no_chunk_id';

export type RetrievalCoverage = {
  requested: number;
  resolved: number;
  missing: number;
  synthetic: number;
  noChunkId: number;
  /** `resolved / (requested - synthetic)` — synthetic refs are excluded from the denominator
   *  because no ingest could ever have produced a row for them. Null when that denominator is 0. */
  resolvedShare: number | null;
};

export type RetrievalEvalRecord = {
  test_result_item_id: string;
  test_item_id: string;
  row_index: number;
  /** The question as asked. */
  user_input: string;
  /** The answer as the user saw it; null on an errored item. */
  response_text: string | null;
  /** `test_items.ideal_response` — the reference answer. Null on items that have none. */
  reference: string | null;
  passed: boolean;
  error_message: string | null;
  workflow_run_id: string | null;
  /** Union of chunk ids retrieved this turn, in persisted order. Unordered w.r.t. rank. */
  retrieved_context_ids: string[];
  /** Texts of the resolved subset, parallel to nothing — use `contexts` when provenance matters. */
  retrieved_contexts: string[];
  /** Every reference, resolved or not, with the reason. */
  contexts: ResolvedContext[];
  /**
   * Per-call, ordered retrieval. `null` (not `[]`) when the payload predates the field — the
   * distinction matters: `[]` means "this turn ran no retrieval", `null` means "we cannot know".
   * Rank-sensitive metrics must skip a `null`, and must not read it as a zero.
   */
  retrieval_calls: RetrievalCallRecord[] | null;
  coverage: RetrievalCoverage;
};

/**
 * `rag.document_chunk.id` is a uuid column. Synthetic source ids (`verified-facts`,
 * `verified-facts:<productLineKey>`, a lab report's document id) are not uuids, and passing one into
 * a `.in('id', …)` filter makes Postgres throw for the whole batch rather than just not matching —
 * the same trap `assembleDocumentBodies` documents. Every id is screened before it reaches a query.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Match the other batched lookups: bound URL-encoded UUID filters to avoid URI-too-long errors. */
const CHUNK_FETCH_BATCH = 150;

type ChunkTextRow = {
  id: string;
  document_id: string;
  chunk_text: string;
  heading: string | null;
  chunk_index: number;
};

/** Fetches `chunk_text` for every uuid-shaped chunk id, batched. Ids that do not exist are absent. */
export async function fetchChunkTextByIds(
  chunkIds: string[],
): Promise<Map<string, ChunkTextRow>> {
  const unique = [...new Set(chunkIds.filter((id) => UUID_PATTERN.test(id)))];
  const byId = new Map<string, ChunkTextRow>();
  if (unique.length === 0) {
    return byId;
  }

  const supabase = getSupabaseServiceRoleClient();

  for (let i = 0; i < unique.length; i += CHUNK_FETCH_BATCH) {
    const batch = unique.slice(i, i + CHUNK_FETCH_BATCH);
    const { data, error } = await supabase
      .schema('rag')
      .from('document_chunk')
      .select('id, document_id, chunk_text, heading, chunk_index')
      .in('id', batch);

    if (error) {
      throw new Error(`Failed to fetch chunk text (batch ${i / CHUNK_FETCH_BATCH}): ${error.message}`);
    }

    for (const row of (data ?? []) as ChunkTextRow[]) {
      byId.set(row.id, row);
    }
  }

  return byId;
}

/** Classifies a single reference against the fetched chunk rows. Pure. */
export function resolveContext(
  ref: {
    document_id: string;
    chunk_id: string | null;
    document_kind?: string | null;
    document_title?: string | null;
    product_line_key?: string | null;
  },
  chunkRows: Map<string, ChunkTextRow>,
): ResolvedContext {
  const base = {
    document_id: ref.document_id,
    chunk_id: ref.chunk_id,
    document_title: ref.document_title ?? null,
    document_kind: ref.document_kind ?? null,
    product_line_key: ref.product_line_key ?? null,
  };

  if (!ref.chunk_id) {
    return { ...base, text: null, heading: null, chunk_index: null, resolution: 'no_chunk_id' };
  }
  if (!UUID_PATTERN.test(ref.chunk_id)) {
    return { ...base, text: null, heading: null, chunk_index: null, resolution: 'synthetic' };
  }

  const row = chunkRows.get(ref.chunk_id);
  if (!row) {
    return { ...base, text: null, heading: null, chunk_index: null, resolution: 'missing' };
  }

  return {
    ...base,
    text: row.chunk_text,
    heading: row.heading,
    chunk_index: row.chunk_index,
    resolution: 'resolved',
  };
}

/** Tallies resolutions into the coverage block. Pure. */
export function summarizeCoverage(contexts: ResolvedContext[]): RetrievalCoverage {
  const counts = { resolved: 0, missing: 0, synthetic: 0, no_chunk_id: 0 };
  for (const c of contexts) {
    counts[c.resolution] += 1;
  }
  const joinable = contexts.length - counts.synthetic;
  return {
    requested: contexts.length,
    resolved: counts.resolved,
    missing: counts.missing,
    synthetic: counts.synthetic,
    noChunkId: counts.no_chunk_id,
    resolvedShare: joinable > 0 ? counts.resolved / joinable : null,
  };
}

/**
 * Builds the eval records for a run's result items.
 *
 * Deduplicates chunk ids across the whole run and fetches them in bounded batches, not per item.
 */
export async function buildRetrievalEvalRecords(
  resultItems: TestResultItemRecord[],
  itemsById: Map<string, TestItemRecord>,
): Promise<RetrievalEvalRecord[]> {
  const refsByResultItem = new Map<string, ReturnType<typeof extractRetrievedDocumentChunks>>();
  const allChunkIds: string[] = [];

  for (const item of resultItems) {
    const refs = extractRetrievedDocumentChunks(item.response_payload);
    refsByResultItem.set(item.id, refs);
    for (const ref of refs) {
      if (ref.chunk_id) allChunkIds.push(ref.chunk_id);
    }
  }

  const chunkRows = await fetchChunkTextByIds(allChunkIds);

  return resultItems.map((resultItem) => {
    const testItem = itemsById.get(resultItem.test_item_id);
    const refs = refsByResultItem.get(resultItem.id) ?? [];
    const contexts = refs.map((ref) => resolveContext(ref, chunkRows));

    return {
      test_result_item_id: resultItem.id,
      test_item_id: resultItem.test_item_id,
      row_index: resultItem.row_index,
      user_input: testItem?.prompt ?? '',
      response_text: resultItem.response_text,
      reference: testItem?.ideal_response ?? null,
      passed: resultItem.passed,
      error_message: resultItem.error_message,
      workflow_run_id: resultItem.workflow_run_id,
      retrieved_context_ids: refs.map((r) => r.chunk_id).filter((id): id is string => Boolean(id)),
      retrieved_contexts: contexts
        .map((c) => c.text)
        .filter((text): text is string => typeof text === 'string'),
      contexts,
      retrieval_calls: extractRetrievalCalls(resultItem.response_payload),
      coverage: summarizeCoverage(contexts),
    };
  });
}

/** Run-level coverage, for deciding whether a run is fit to score at all. */
export function summarizeRunCoverage(records: RetrievalEvalRecord[]): RetrievalCoverage & {
  itemsWithNoRetrieval: number;
  itemsWithoutRetrievalCalls: number;
} {
  const totals = records.reduce(
    (acc, r) => ({
      requested: acc.requested + r.coverage.requested,
      resolved: acc.resolved + r.coverage.resolved,
      missing: acc.missing + r.coverage.missing,
      synthetic: acc.synthetic + r.coverage.synthetic,
      noChunkId: acc.noChunkId + r.coverage.noChunkId,
    }),
    { requested: 0, resolved: 0, missing: 0, synthetic: 0, noChunkId: 0 },
  );
  const joinable = totals.requested - totals.synthetic;

  return {
    ...totals,
    resolvedShare: joinable > 0 ? totals.resolved / joinable : null,
    itemsWithNoRetrieval: records.filter((r) => r.coverage.requested === 0).length,
    itemsWithoutRetrievalCalls: records.filter((r) => r.retrieval_calls === null).length,
  };
}
