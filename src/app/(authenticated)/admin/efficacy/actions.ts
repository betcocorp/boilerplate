'use server';

import { getServerSession } from 'next-auth';
import { revalidatePath } from 'next/cache';

import { authOptions } from '~/lib/auth';

import {
  runEfficacyIngestion,
  type EfficacyDashboardStatus,
  type EfficacyIngestionRunMode,
} from './pipeline';

export type EfficacyActionState = {
  ok: boolean;
  message: string | null;
  error: string | null;
  timestamp: number;
  result: {
    mode: EfficacyIngestionRunMode;
    processed: number;
    succeeded: number;
    failed: number;
    startedAt: string;
    finishedAt: string;
    errors: Array<{ id: string; message: string }>;
    status: EfficacyDashboardStatus;
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

function getActionMessage(mode: EfficacyIngestionRunMode, succeeded: number, failed: number) {
  if (mode === 'register-seed') {
    return `Registered ${succeeded} discovered source record${succeeded === 1 ? '' : 's'}${failed > 0 ? `, ${failed} failed` : ''}.`;
  }

  if (mode === 'embed-all') {
    return `Embedded ${succeeded} pending efficacy chunk${succeeded === 1 ? '' : 's'} across batched passes.`;
  }

  if (mode === 'retry-failed') {
    return `Retried failed efficacy files: ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ''}.`;
  }

  return `Ingested all pending efficacy files: ${succeeded} succeeded${failed > 0 ? `, ${failed} failed` : ''}.`;
}

export async function runEfficacyAction(
  previousState: EfficacyActionState,
  formData: FormData,
): Promise<EfficacyActionState> {
  const mode = readFormValue(formData, 'mode') as EfficacyIngestionRunMode;
  const batchSize = readBatchSize(formData);
  const session = await getServerSession(authOptions);
  const ingestedBy = session?.user?.email ?? null;

  try {
    const result = await runEfficacyIngestion(mode, batchSize, ingestedBy);

    revalidatePath('/admin/efficacy');
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
        error instanceof Error ? error.message : 'Efficacy ingestion action failed unexpectedly.',
      timestamp: Date.now(),
      result: previousState.result,
    };
  }
}
