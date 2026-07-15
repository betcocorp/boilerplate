'use server';

import { revalidatePath } from 'next/cache';

import { writeAuditLog } from '~/lib/audit/audit-log';
import { runCategoryDeltaSyncLive } from '~/lib/category/category-delta-sync';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import { formatEasternTimestamp } from '~/lib/utils/time';

/**
 * B0-37 — admin-triggered delta sync of product→category links. Mirrors the sds-sync / generate
 * server-action pattern (previousState + FormData → state with a short history). An explicit
 * comma-separated `prodLineKeys` field is the "on product add/update" trigger; with none provided
 * it refreshes every prod-line that currently carries a classifier proposal.
 */

export type CategorySyncResult = {
  deltaProdLines: number;
  upserted: number;
  deleted: number;
  skipped: number;
  frozen: number;
};

export type CategorySyncActionState = {
  ok: boolean;
  message: string | null;
  error: string | null;
  timestamp: number;
  durationMs: number;
  result: CategorySyncResult | null;
  history: Array<{ id: number; ok: boolean; title: string; description: string; durationMs: number }>;
};

export const initialCategorySyncState: CategorySyncActionState = {
  ok: false,
  message: null,
  error: null,
  timestamp: 0,
  durationMs: 0,
  result: null,
  history: [],
};

function parseProdLineKeys(formData: FormData): string[] {
  const raw = formData.get('prodLineKeys');
  if (typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function buildHistoryEntry(
  state: Pick<CategorySyncActionState, 'ok' | 'message' | 'error' | 'timestamp' | 'durationMs'>,
) {
  return {
    id: state.timestamp,
    ok: state.ok,
    title: state.ok ? (state.message ?? 'Category sync completed.') : (state.error ?? 'Category sync failed.'),
    description: `Completed at ${formatEasternTimestamp(state.timestamp)}.`,
    durationMs: state.durationMs,
  };
}

export async function runCategoryLinkSyncAction(
  previousState: CategorySyncActionState,
  formData: FormData,
): Promise<CategorySyncActionState> {
  const startedAt = Date.now();
  const keys = parseProdLineKeys(formData);
  const traceId = newCorrelationId();

  try {
    const result = await runCategoryDeltaSyncLive(keys.length > 0 ? keys : undefined);

    await writeAuditLog(
      'category_delta_sync',
      {
        delta_prod_lines: result.deltaProdLines,
        upserted: result.upserted,
        deleted: result.deleted,
        skipped: result.skipped,
        frozen: result.frozen,
        explicit_keys: keys.length,
      },
      { traceId },
    );

    revalidatePath('/admin/products');

    const message =
      result.deltaProdLines === 0
        ? 'No prod-lines needed a re-link.'
        : `Synced ${result.deltaProdLines} prod-line(s): ${result.upserted} linked, ${result.deleted} stale removed, ${result.skipped} blocked, ${result.frozen} human-curated preserved.`;

    const nextState: CategorySyncActionState = {
      ok: true,
      message,
      error: null,
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
      result,
      history: previousState.history,
    };
    return { ...nextState, history: [buildHistoryEntry(nextState), ...previousState.history].slice(0, 10) };
  } catch (error) {
    const nextState: CategorySyncActionState = {
      ok: false,
      message: null,
      error: error instanceof Error ? error.message : 'Category sync failed.',
      timestamp: Date.now(),
      durationMs: Date.now() - startedAt,
      result: null,
      history: previousState.history,
    };
    return { ...nextState, history: [buildHistoryEntry(nextState), ...previousState.history].slice(0, 10) };
  }
}
