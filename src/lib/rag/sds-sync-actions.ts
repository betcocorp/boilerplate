'use server';

import { revalidatePath } from 'next/cache';

import {
  chunkSdsMarkdown,
  SDS_MARKDOWN_CHUNK_OVERLAP,
  SDS_MARKDOWN_CHUNK_SIZE,
  SDS_MARKDOWN_CHUNKING_STRATEGY,
} from '~/lib/rag/sds-markdown';
import { withRetry } from '~/lib/utils';
import { formatEasternTimestamp } from '~/lib/utils/time';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

const SDS_CHUNK_DOCUMENT_BATCH_SIZE = 100;
type JsonObject = Record<string, unknown>;

type PendingDocument = {
  id: string;
  body_markdown: string;
};

type PendingQueryResult = {
  data: PendingDocument[] | null;
  count: number | null;
  error: { message: string } | null;
};

type PendingQuery = {
  eq(column: string, value: unknown): PendingQuery;
  not(column: string, operator: string, value: unknown): PendingQuery;
  or(filters: string): PendingQuery;
  order(column: string, options: { ascending: boolean }): PendingQuery;
  limit(limit: number): Promise<PendingQueryResult>;
};

export type SdsSyncStatus = {
  totalSdsDocs: number;
  pendingChunkDocs: number;
  totalChunks: number;
  embeddedChunks: number;
};

function pendingChunkDocumentsQuery() {
  const supabase = getSupabaseServiceRoleClient();
  return (supabase.schema('rag').from('document') as unknown as {
    select(columns: string, options?: { count?: 'exact'; head?: boolean }): PendingQuery;
  })
    .select('id, body_markdown, source_record!inner(is_active)', { count: 'exact' })
    .eq('document_kind', 'sds')
    .eq('language_code', 'EN')
    .eq('source_record.is_active', true)
    .not('body_markdown', 'is', null)
    .or(
      `metadata->>chunking_strategy.is.null,metadata->>chunking_strategy.neq.${SDS_MARKDOWN_CHUNKING_STRATEGY}`,
    );
}

export async function getSdsSyncStatus(): Promise<SdsSyncStatus> {
  const supabase = getSupabaseServiceRoleClient();
  const [{ count: totalSdsDocs }, { count: totalChunks }, { count: embeddedChunks }, pending] =
    await Promise.all([
      supabase
        .schema('rag')
        .from('document')
        .select('id', { count: 'exact', head: true })
        .eq('document_kind', 'sds') as unknown as Promise<{ count: number | null }>,
      supabase
        .schema('rag')
        .from('document_chunk')
        .select('id', { count: 'exact', head: true })
        .like('chunk_key', 'sds:%') as unknown as Promise<{ count: number | null }>,
      supabase
        .schema('rag')
        .from('document_chunk')
        .select('id', { count: 'exact', head: true })
        .like('chunk_key', 'sds:%')
        .not('embedding_large', 'is', null) as unknown as Promise<{ count: number | null }>,
      pendingChunkDocumentsQuery().limit(0),
    ]);

  if (pending.error) throw new Error(`Failed to count pending SDS documents: ${pending.error.message}`);

  return {
    totalSdsDocs: totalSdsDocs ?? 0,
    pendingChunkDocs: pending.count ?? 0,
    totalChunks: totalChunks ?? 0,
    embeddedChunks: embeddedChunks ?? 0,
  };
}

export type SdsSyncActionState = {
  ok: boolean;
  message: string | null;
  error: string | null;
  timestamp: number;
  durationMs: number;
  hasMore: boolean;
  remaining: number;
  totalProcessedThisSession: number;
  totalChunksThisSession: number;
  history: Array<{
    id: number;
    ok: boolean;
    title: string;
    description: string;
    durationMs: number;
  }>;
  result: JsonObject | null;
};

function buildHistoryEntry(
  state: Pick<SdsSyncActionState, 'ok' | 'message' | 'error' | 'timestamp' | 'durationMs'>,
) {
  return {
    id: state.timestamp,
    ok: state.ok,
    title: state.ok
      ? (state.message ?? 'SDS sync completed.')
      : (state.error ?? 'SDS sync failed.'),
    description: `Completed at ${formatEasternTimestamp(state.timestamp)}.`,
    durationMs: state.durationMs,
  };
}

async function replaceDocumentChunks(document: PendingDocument) {
  const chunks = await chunkSdsMarkdown(document.body_markdown);
  if (chunks.length === 0) throw new Error(`Document ${document.id} produced no markdown chunks.`);

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await withRetry(() =>
    (supabase.schema('rag') as unknown as {
      rpc: (
        fn: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: JsonObject | null; error: { message: string } | null }>;
    }).rpc('replace_sds_markdown_chunks', {
      p_document_id: document.id,
      p_chunks: chunks,
      p_strategy: SDS_MARKDOWN_CHUNKING_STRATEGY,
      p_chunk_size: SDS_MARKDOWN_CHUNK_SIZE,
      p_chunk_overlap: SDS_MARKDOWN_CHUNK_OVERLAP,
    }),
  );

  if (error) throw new Error(`SDS chunk replacement failed for ${document.id}: ${error.message}`);
  return { result: data, chunkCount: chunks.length };
}

export async function runSdsSyncAction(
  previousState: SdsSyncActionState,
  formData: FormData,
): Promise<SdsSyncActionState> {
  void formData;
  const startedAt = Date.now();

  try {
    const pending = await pendingChunkDocumentsQuery()
      .order('updated_at', { ascending: true })
      .limit(SDS_CHUNK_DOCUMENT_BATCH_SIZE);
    if (pending.error) throw new Error(`Failed to load pending SDS documents: ${pending.error.message}`);

    let chunksUpserted = 0;
    let lastResult: JsonObject | null = null;
    for (const document of pending.data ?? []) {
      const replaced = await replaceDocumentChunks(document);
      chunksUpserted += replaced.chunkCount;
      lastResult = replaced.result;
    }

    const documentsProcessed = pending.data?.length ?? 0;
    const remaining = Math.max(0, (pending.count ?? documentsProcessed) - documentsProcessed);
    const hasMore = remaining > 0;
    const totalProcessed = previousState.totalProcessedThisSession + documentsProcessed;
    const totalChunks = previousState.totalChunksThisSession + chunksUpserted;

    revalidatePath('/admin/sds');

    const message = hasMore
      ? `Batch done — ${documentsProcessed} doc${documentsProcessed === 1 ? '' : 's'}, ${chunksUpserted} chunk${chunksUpserted === 1 ? '' : 's'}. ${remaining.toLocaleString()} remaining.`
      : `Sync complete. ${documentsProcessed} doc${documentsProcessed === 1 ? '' : 's'} in final batch, ${totalChunks.toLocaleString()} total chunks generated this session.`;
    const result = {
      ...(lastResult ?? {}),
      documents_processed: documentsProcessed,
      chunks_upserted: chunksUpserted,
      remaining_documents: remaining,
      has_more: hasMore,
      chunking_config: {
        strategy: SDS_MARKDOWN_CHUNKING_STRATEGY,
        max_chars: SDS_MARKDOWN_CHUNK_SIZE,
        overlap_chars: SDS_MARKDOWN_CHUNK_OVERLAP,
      },
    };
    const nextState: SdsSyncActionState = {
      ok: true,
      message,
      error: null,
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
      hasMore,
      remaining,
      totalProcessedThisSession: totalProcessed,
      totalChunksThisSession: totalChunks,
      history: previousState.history,
      result,
    };

    return {
      ...nextState,
      history: [buildHistoryEntry(nextState), ...previousState.history].slice(0, 10),
    };
  } catch (error) {
    const nextState: SdsSyncActionState = {
      ok: false,
      message: null,
      error: error instanceof Error ? error.message : 'SDS sync failed.',
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
      hasMore: false,
      remaining: 0,
      totalProcessedThisSession: previousState.totalProcessedThisSession,
      totalChunksThisSession: previousState.totalChunksThisSession,
      history: previousState.history,
      result: null,
    };

    return {
      ...nextState,
      history: [buildHistoryEntry(nextState), ...previousState.history].slice(0, 10),
    };
  }
}
