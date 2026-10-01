/**
 * B0-1106 — the sweep-ledger choreography for the "Run Golden" dialog (`runGoldenTestsAction`).
 *
 * The nightly cron (`~/lib/observability/run-golden-test-sweep.ts`) writes one
 * `scheduled_test_runs` parent plus one `scheduled_test_items` child per golden test, links each
 * child to its run, and leaves the parent `in_progress` for the hourly reconciler to close. This
 * module gives the manual fan-out the same record under `sweep_name = 'manual_golden_sweep'`, with
 * two differences the dialog path makes possible:
 *
 * - run ids are known synchronously (the action calls `createTestResult` itself), so the child is
 *   linked the moment the row exists — never left for the reconciler's after-the-fact backfill,
 *   which only ever matches `triggered_by = 'api-client'` runs and would not find a human's;
 * - a golden set the action decides not to run (empty, or nothing under the B0-1102 threshold) is
 *   closed `skipped` with a machine-readable `error_code`, so the ledger says WHY a set got no run.
 *
 * Children are inserted `running` BEFORE the per-test loop, then patched per test, rather than
 * inserted once after it: if the action dies mid-loop the sets that already got a run are linked,
 * the rest are visibly `running` with no `test_run_id`, and the stale guard closes them
 * `timed_out` — a parent with no children at all would sit `in_progress` forever, because the
 * reconciler only ever selects children.
 *
 * Same rule as the cron: the ledger is observability, never a precondition. Every write here is
 * try/caught and logged with `logWarn`; a broken ledger cannot stop a run from being created.
 */

import { logWarn } from '~/lib/observability/logger';
import {
  closeScheduledRunAfterDispatch,
  insertScheduledTestItems,
  insertScheduledTestRun,
  updateScheduledTestItem,
  updateScheduledTestRun,
} from '~/lib/observability/scheduled-test-repository';
import {
  computeScheduledRunAggregates,
  MANUAL_SWEEP_NAME,
  type ScheduledTestItem,
  type SweepRunMode,
} from '~/lib/observability/scheduled-test-types';

/** `scheduled_test_items.error_code` values a `skipped` child of a manual sweep may carry. */
export const MANUAL_SWEEP_SKIP_CODES = ['empty_set', 'no_qualifying_items'] as const;
export type ManualSweepSkipCode = (typeof MANUAL_SWEEP_SKIP_CODES)[number];

export type ManualSweepLedger = {
  scheduledRunId: string;
  startedAtIso: string;
  /** Child row plus its current in-memory state, keyed by golden test id. */
  itemsByTestId: Map<string, ScheduledTestItem>;
};

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Writes the parent + one `running` child per golden test. Returns `null` on any failure, after
 * logging it; every other helper in this module is a no-op on a `null` ledger.
 */
export async function openManualSweepLedger(input: {
  goldenTests: { id: string; name: string }[];
  runMode: SweepRunMode;
  /** The B0-1102 bar a partial sweep was filtered by; null for a full sweep. */
  partialScoreThreshold: number | null;
  /** Who pressed the button — the same actor `test_results.triggered_by` gets (null: no session email). */
  triggeredBy: string | null;
  metadata?: Record<string, unknown>;
}): Promise<ManualSweepLedger | null> {
  const startedAtIso = new Date().toISOString();

  try {
    const run = await insertScheduledTestRun({
      sweepName: MANUAL_SWEEP_NAME,
      runMode: input.runMode,
      partialScoreThreshold: input.partialScoreThreshold,
      sweepTriggeredAt: startedAtIso,
      totalTests: input.goldenTests.length,
      metadata: { triggered_by: input.triggeredBy, ...(input.metadata ?? {}) },
    });

    const items = await insertScheduledTestItems({
      scheduledRunId: run.id,
      startedAt: startedAtIso,
      tests: input.goldenTests,
    });

    return {
      scheduledRunId: run.id,
      startedAtIso,
      itemsByTestId: new Map(items.map((item) => [item.test_id, item])),
    };
  } catch (error) {
    logWarn('manual_golden_sweep_ledger_open_failed', {
      golden_test_count: input.goldenTests.length,
      run_mode: input.runMode,
      message: describeError(error),
    });
    return null;
  }
}

async function patchChild(
  ledger: ManualSweepLedger | null,
  testId: string,
  patch: Partial<ScheduledTestItem>,
): Promise<void> {
  const item = ledger?.itemsByTestId.get(testId);
  if (!ledger || !item) {
    return;
  }

  try {
    await updateScheduledTestItem(item.id, patch);
    ledger.itemsByTestId.set(testId, { ...item, ...patch });
  } catch (error) {
    logWarn('manual_golden_sweep_item_write_failed', {
      scheduled_test_item_id: item.id,
      test_id: testId,
      message: describeError(error),
    });
  }
}

/** Links the child to the run the action just created. The child stays `running`. */
export async function recordManualSweepRunCreated(
  ledger: ManualSweepLedger | null,
  testId: string,
  runId: string,
): Promise<void> {
  await patchChild(ledger, testId, { test_run_id: runId });
}

/** Closes the child `skipped` — the set got no run, and `error_code` says why. */
export async function recordManualSweepTestSkipped(
  ledger: ManualSweepLedger | null,
  testId: string,
  skip: { code: ManualSweepSkipCode; message: string },
): Promise<void> {
  await patchChild(ledger, testId, {
    status: 'skipped',
    completed_at: new Date().toISOString(),
    error_code: skip.code,
    error_message: skip.message,
  });
}

/**
 * Closes the parent once every set has been dispatched or skipped.
 *
 * With at least one run created the parent stays `in_progress` (via the same
 * `closeScheduledRunAfterDispatch` the cron uses) until the hourly reconciler folds the runs in.
 * When EVERY set was skipped there is nothing for the reconciler to wait on, and the shared helper
 * would call that "failed — every golden test failed to dispatch", which is not what happened: the
 * sweep finished and had no work. That case is closed `completed` here, with `success_rate` null
 * because nothing was measured.
 */
export async function closeManualSweepLedger(ledger: ManualSweepLedger | null): Promise<void> {
  if (!ledger) {
    return;
  }

  const items = Array.from(ledger.itemsByTestId.values());
  const completedAtIso = new Date().toISOString();

  try {
    const allSkipped = items.length > 0 && items.every((item) => item.status === 'skipped');
    if (allSkipped) {
      const aggregates = computeScheduledRunAggregates(items);
      await updateScheduledTestRun(ledger.scheduledRunId, {
        total_tests: aggregates.total_tests,
        successful_tests: aggregates.successful_tests,
        failed_tests: aggregates.failed_tests,
        timed_out_tests: aggregates.timed_out_tests,
        success_rate: null,
        avg_elapsed_ms: null,
        status: 'completed',
        completed_at: completedAtIso,
        elapsed_ms: Math.max(0, Date.parse(completedAtIso) - Date.parse(ledger.startedAtIso)),
        error_message: null,
      });
      return;
    }

    await closeScheduledRunAfterDispatch({
      scheduledRunId: ledger.scheduledRunId,
      items,
      startedAtIso: ledger.startedAtIso,
      completedAtIso,
    });
  } catch (error) {
    logWarn('manual_golden_sweep_ledger_close_failed', {
      scheduled_run_id: ledger.scheduledRunId,
      message: describeError(error),
    });
  }
}
