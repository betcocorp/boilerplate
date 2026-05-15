'use server';

import moment from 'moment';
import { revalidatePath } from 'next/cache';

import {
  runRagPipeline,
  type RagGenerationStatus,
  type RagPipelineIntent,
} from '~/lib/rag/pipeline';

export type GenerateActionState = {
  ok: boolean;
  message: string | null;
  error: string | null;
  timestamp: number;
  durationMs: number;
  history: Array<{
    id: number;
    ok: boolean;
    title: string;
    description: string;
    durationMs: number;
  }>;
  result: {
    intent: string;
    profileSyncResult: Record<string, unknown> | null;
    chunkSyncResult: Record<string, unknown> | null;
    embeddingRuns: number;
    embeddingResult: Record<string, unknown> | null;
    embeddingLargeRuns: number;
    embeddingLargeResult: Record<string, unknown> | null;
    status: RagGenerationStatus;
  } | null;
};

function readFormValue(formData: FormData, key: string) {
  const value = formData.get(key);

  return typeof value === 'string' ? value : '';
}

function readPositiveInteger(formData: FormData, key: string) {
  const value = Number.parseInt(readFormValue(formData, key), 10);

  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function getMessage(intent: RagPipelineIntent, embeddingRuns: number) {
  if (intent === 'run-all') {
    return embeddingRuns > 0
      ? `Ran the full pipeline and completed ${embeddingRuns} embedding pass${embeddingRuns === 1 ? '' : 'es'}.`
      : 'Ran the full pipeline without needing any embedding passes.';
  }

  if (intent === 'sync-documents') {
    return 'Synced the next RAG document batch from legacy.';
  }

  if (intent === 'sync-chunks') {
    return 'Generated or refreshed the next RAG chunk batch.';
  }

  if (intent === 'sync-embeddings-large') {
    return embeddingRuns > 0
      ? `Ran ${embeddingRuns} large-embedding batch pass${embeddingRuns === 1 ? '' : 'es'} (text-embedding-3-large).`
      : 'No pending chunks required large embedding.';
  }

  return embeddingRuns > 0
    ? `Ran ${embeddingRuns} embedding batch pass${embeddingRuns === 1 ? '' : 'es'}.`
    : 'No pending chunks required embedding.';
}

function buildHistoryEntry(state: {
  ok: boolean;
  message: string | null;
  error: string | null;
  timestamp: number;
  durationMs: number;
}) {
  return {
    id: state.timestamp,
    ok: state.ok,
    title: state.ok
      ? state.message || 'Pipeline action completed.'
      : state.error || 'Pipeline action failed.',
    description: `Completed at ${moment
      .utc(state.timestamp)
      .format('YYYY-MM-DD HH:mm:ss')} UTC.`,
    durationMs: state.durationMs,
  };
}

export async function runGenerateAction(
  previousState: GenerateActionState,
  formData: FormData,
): Promise<GenerateActionState> {
  const startedAt = Date.now();
  const intent = readFormValue(formData, 'intent') as RagPipelineIntent;
  const languageCode = readFormValue(formData, 'languageCode') || 'EN';
  const batchSize = readPositiveInteger(formData, 'batchSize');
  const maxBatches = readPositiveInteger(formData, 'maxBatches');

  try {
    const result = await runRagPipeline(intent, {
      languageCode,
      batchSize,
      maxBatches,
    });

    revalidatePath('/admin/products/rag/generate');
    revalidatePath('/admin/products/rag');

    const nextState: GenerateActionState = {
      ok: true,
      message: getMessage(
        result.intent,
        result.intent === 'sync-embeddings-large' ? result.embeddingLargeRuns : result.embeddingRuns,
      ),
      error: null,
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
      history: previousState.history,
      result: {
        intent: result.intent,
        profileSyncResult: result.profileSyncResult,
        chunkSyncResult: result.chunkSyncResult,
        embeddingRuns: result.embeddingRuns,
        embeddingResult: result.embeddingResult,
        embeddingLargeRuns: result.embeddingLargeRuns,
        embeddingLargeResult: result.embeddingLargeResult,
        status: result.status,
      },
    };

    return {
      ...nextState,
      history: [buildHistoryEntry(nextState), ...previousState.history].slice(0, 6),
    };
  } catch (error) {
    const nextState: GenerateActionState = {
      ok: false,
      message: null,
      error: error instanceof Error ? error.message : 'Pipeline action failed.',
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
      history: previousState.history,
      result: null,
    };

    return {
      ...nextState,
      history: [buildHistoryEntry(nextState), ...previousState.history].slice(0, 6),
    };
  }
}
