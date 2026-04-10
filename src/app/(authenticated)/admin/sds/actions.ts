'use server';

import { revalidatePath } from 'next/cache';

import {
  runSdsIngestion,
  type SdsDashboardStatus,
  type SdsIngestionRunMode,
} from './pipeline';

export type SdsActionState = {
  ok: boolean;
  message: string | null;
  error: string | null;
  timestamp: number;
  result: {
    mode: SdsIngestionRunMode;
    processed: number;
    succeeded: number;
    failed: number;
    startedAt: string;
    finishedAt: string;
    errors: Array<{ id: string; message: string }>;
    status: SdsDashboardStatus;
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

function getActionMessage(mode: SdsIngestionRunMode, succeeded: number, failed: number) {
  if (mode === 'register-seed') {
    return `Registered ${succeeded} discovered source record${succeeded === 1 ? '' : 's'}${failed > 0 ? `, ${failed} failed` : ''}.`;
  }

  if (mode === 'retry-failed') {
    return `Retried failed SDS files: ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ''}.`;
  }

  if (mode === 'ingest-next') {
    return `Ingested the next SDS batch: ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ''}.`;
  }

  return `Ingested all pending SDS files: ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ''}.`;
}

export async function runSdsAction(
  previousState: SdsActionState,
  formData: FormData,
): Promise<SdsActionState> {
  const mode = readFormValue(formData, 'mode') as SdsIngestionRunMode;
  const batchSize = readBatchSize(formData);

  try {
    const result = await runSdsIngestion(mode, batchSize);

    revalidatePath('/admin/sds');
    revalidatePath('/admin');

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
      error:
        error instanceof Error ? error.message : 'SDS ingestion action failed unexpectedly.',
      timestamp: Date.now(),
      result: previousState.result,
    };
  }
}
