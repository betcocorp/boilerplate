'use server';

import { revalidatePath } from 'next/cache';

import { withRetry } from '~/lib/utils';
import { formatEasternTimestamp } from '~/lib/utils/time';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

type JsonObject = Record<string, unknown>;

function readJsonNumber(value: JsonObject | null, key: string): number | null {
  const candidate = value?.[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : null;
}


export type SdsSyncStatus = {
  totalSdsDocs: number;
  totalChunks: number;
  embeddedChunks: number;
};

export async function getSdsSyncStatus(): Promise<SdsSyncStatus> {
  const supabase = getSupabaseServiceRoleClient();

  const [
    { count: totalSdsDocs },
    { count: totalChunks },
    { count: embeddedChunks },
  ] = await Promise.all([
    supabase
      .schema('rag')
      .from('document')
      .select('id', { count: 'exact', head: true })
      .eq('document_kind', 'sds') as unknown as Promise<{ count: number | null }>,
    supabase
      .schema('rag')
      .from('document_chunk')
      .select('id', { count: 'exact', head: true }) as unknown as Promise<{ count: number | null }>,
    supabase
      .schema('rag')
      .from('document_chunk')
      .select('id', { count: 'exact', head: true })
      .not('embedding_large', 'is', null) as unknown as Promise<{ count: number | null }>,
  ]);

  return {
    totalSdsDocs: totalSdsDocs ?? 0,
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

export async function runSdsSyncAction(
  previousState: SdsSyncActionState,
  formData: FormData,
): Promise<SdsSyncActionState> {
  const startedAt = Date.now();
  const rawLang = formData.get('languageCode');
  const languageCode =
    typeof rawLang === 'string' && rawLang.trim()
      ? rawLang.trim().toUpperCase()
      : 'EN';

  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await withRetry(
      () =>
        (supabase.schema('rag') as unknown as { rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: JsonObject | null; error: { message: string } | null }> }).rpc(
          'sync_sds_chunks',
          { p_language_code: languageCode },
        ),
    );

    if (error) {
      throw new Error(`SDS chunk sync failed: ${error.message}`);
    }

    const result =
      data && typeof data === 'object' && !Array.isArray(data)
        ? (data as JsonObject)
        : null;

    const remaining = readJsonNumber(result, 'remaining_documents') ?? 0;
    const hasMore = result?.has_more === true || remaining > 0;
    const docsProcessed = readJsonNumber(result, 'documents_processed') ?? 0;
    const chunksUpserted = readJsonNumber(result, 'chunks_upserted') ?? 0;
    const totalProcessed = previousState.totalProcessedThisSession + docsProcessed;
    const totalChunks = previousState.totalChunksThisSession + chunksUpserted;

    revalidatePath('/admin/sds');

    const message = hasMore
      ? `Batch done — ${docsProcessed} doc${docsProcessed === 1 ? '' : 's'}, ${chunksUpserted} chunk${chunksUpserted === 1 ? '' : 's'}. ${remaining.toLocaleString()} remaining.`
      : `Sync complete. ${docsProcessed} doc${docsProcessed === 1 ? '' : 's'} in final batch, ${totalChunks.toLocaleString()} total chunks generated this session.`;

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
