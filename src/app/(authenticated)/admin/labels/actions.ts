'use server';

import { revalidatePath } from 'next/cache';

import {
  runLabelIngestion,
  type LabelDashboardStatus,
  type LabelIngestionRunMode,
} from './pipeline';

export type LabelActionState = {
  ok: boolean;
  message: string | null;
  error: string | null;
  timestamp: number;
  result: {
    mode: LabelIngestionRunMode;
    processed: number;
    succeeded: number;
    failed: number;
    startedAt: string;
    finishedAt: string;
    errors: Array<{ id: string; message: string }>;
    status: LabelDashboardStatus;
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

function getActionMessage(mode: LabelIngestionRunMode, succeeded: number, failed: number) {
  const failedSuffix = failed > 0 ? `, ${failed} failed` : '';
  switch (mode) {
    case 'register-seed':
      return `Registered ${succeeded} discovered label file${succeeded === 1 ? '' : 's'}${failedSuffix}.`;
    case 'embed-next':
      return `Embedded ${succeeded} label chunk${succeeded === 1 ? '' : 's'} in the next batch.`;
    case 'embed-all':
      return `Embedded ${succeeded} pending label chunk${succeeded === 1 ? '' : 's'} across batched passes.`;
    case 'retry-failed':
      return `Retried failed files: ${succeeded} succeeded${failedSuffix}.`;
    case 'ingest-next':
      return `Ingested the next batch: ${succeeded} succeeded${failedSuffix}.`;
    default:
      return `Ingested all pending files: ${succeeded} succeeded${failedSuffix}.`;
  }
}

export async function runLabelAction(
  previousState: LabelActionState,
  formData: FormData,
): Promise<LabelActionState> {
  const mode = readFormValue(formData, 'mode') as LabelIngestionRunMode;
  const batchSize = readBatchSize(formData);

  try {
    const result = await runLabelIngestion(mode, batchSize);
    revalidatePath('/admin/labels');
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
      error: error instanceof Error ? error.message : 'Label ingestion action failed unexpectedly.',
      timestamp: Date.now(),
      result: previousState.result,
    };
  }
}
