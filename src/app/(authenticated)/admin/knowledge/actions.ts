'use server';

import { getServerSession } from 'next-auth';
import { revalidatePath } from 'next/cache';

import { authOptions } from '~/lib/auth';

import {
  runKnowledgeIngestion,
  type KnowledgeDashboardStatus,
  type KnowledgeIngestionRunMode,
} from './pipeline';

export type KnowledgeActionState = {
  ok: boolean;
  message: string | null;
  error: string | null;
  timestamp: number;
  result: {
    mode: KnowledgeIngestionRunMode;
    processed: number;
    succeeded: number;
    failed: number;
    startedAt: string;
    finishedAt: string;
    errors: Array<{ id: string; message: string }>;
    status: KnowledgeDashboardStatus;
  } | null;
};

function readFormValue(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === 'string' ? value : '';
}

function readBatchSize(formData: FormData) {
  const parsed = Number.parseInt(readFormValue(formData, 'batchSize'), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getActionMessage(mode: KnowledgeIngestionRunMode, succeeded: number, failed: number) {
  const failedSuffix = failed > 0 ? `, ${failed} failed` : '';
  switch (mode) {
    case 'register-seed':
      return `Registered ${succeeded} discovered markdown file${succeeded === 1 ? '' : 's'}${failedSuffix}.`;
    case 'embed-next':
      return `Embedded ${succeeded} knowledge chunk${succeeded === 1 ? '' : 's'} in the next batch.`;
    case 'embed-all':
      return `Embedded ${succeeded} pending knowledge chunk${succeeded === 1 ? '' : 's'} across batched passes.`;
    case 'retry-failed':
      return `Retried failed files: ${succeeded} succeeded${failedSuffix}.`;
    case 'ingest-next':
      return `Ingested the next batch: ${succeeded} succeeded${failedSuffix}.`;
    default:
      return `Ingested all pending files: ${succeeded} succeeded${failedSuffix}.`;
  }
}

export async function runKnowledgeAction(
  previousState: KnowledgeActionState,
  formData: FormData,
): Promise<KnowledgeActionState> {
  const mode = readFormValue(formData, 'mode') as KnowledgeIngestionRunMode;
  const batchSize = readBatchSize(formData);
  // B0-1021: attribute this ingestion run to whoever triggered it. No fabricated
  // fallback — an absent session leaves rag.document.ingested_by null.
  const session = await getServerSession(authOptions);
  const ingestedBy = session?.user?.email ?? null;

  try {
    const result = await runKnowledgeIngestion(mode, batchSize, ingestedBy);
    revalidatePath('/admin/knowledge');
    return {
      ok: true,
      message: getActionMessage(mode, result.succeeded, result.failed),
      error: null,
      timestamp: Date.now(),
      result,
    };
  } catch (error) {
    return {
      ok: false,
      message: null,
      error: error instanceof Error ? error.message : 'Knowledge ingestion action failed unexpectedly.',
      timestamp: Date.now(),
      result: previousState.result,
    };
  }
}
