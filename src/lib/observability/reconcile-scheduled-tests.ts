/**
 * B0-941 — hourly reconciler for the scheduled-test ledger.
 *
 * ## The problem this exists for
 * The nightly sweep (`~/lib/observability/run-golden-test-sweep.ts`) writes one
 * `scheduled_test_runs` parent plus one `scheduled_test_items` child per golden test BEFORE it
 * dispatches, so a crash mid-sweep still leaves a visible record. But dispatch returns while the
 * runs are still executing, so nothing in the sweep can know how those runs ended. This module is
 * the other half: it finds children that are still non-terminal, looks their `test_results` row up,
 * and folds the terminal state back onto the ledger — then recomputes the parent.
 *
 * `test_results` stays the system of record for grades; everything written here is a convenience
 * denormalization (see the header of `scheduled-test-types.ts`).
 *
 * ## Purity / testability
 * Like `stalled-run-sweeper.ts`, this takes its data access and its clock as injected `deps`, so
 * the whole decision surface is unit-testable against stubs with no database
 * (`reconcile-scheduled-tests.test.ts`). Supabase wiring lives in `scheduled-test-repository.ts`.
 *
 * This is deliberately NOT folded into `stalled-run-sweeper.ts`: that module is about orphaned
 * `workflow_runs` / `workflow_steps` and should stay focused on them.
 */

import { z } from 'zod';

import {
  computeScheduledRunAggregates,
  type ScheduledTestItem,
  type ScheduledTestRun,
} from '~/lib/observability/scheduled-test-types';
import {
  DEFAULT_STALE_AFTER_MS,
  MIN_STALE_AFTER_MS,
  stalledForMs,
} from '~/lib/observability/stalled-run-sweeper';
import { isCompletedRunStatus, isTerminalRunStatus } from '~/lib/tests/types';

import type {
  ScheduledTestItemPatch,
  ScheduledTestRunPatch,
} from '~/lib/observability/scheduled-test-repository';

/**
 * Staleness threshold for a child that never reached a terminal state: 2 hours.
 *
 * Reused verbatim from `stalled-run-sweeper.ts`'s `DEFAULT_STALE_AFTER_MS` rather than invented
 * here — that constant is derived from the live duration distribution of `public.workflow_steps`
 * (26,831 terminal rows measured 2026-08-04: p99.9 18m28s, max 1h43m25s, zero rows over 120
 * minutes), and the runs a scheduled child waits on are made of exactly those steps. A child still
 * `running` past that window is not slow, it is lost.
 */
export const SCHEDULED_ITEM_STALE_AFTER_MS = DEFAULT_STALE_AFTER_MS;

/** Failure class written when the stale guard fires. */
export const SCHEDULED_ITEM_TIMED_OUT_ERROR = 'timed_out';

export const DEFAULT_RECONCILE_LIMIT = 200;
export const MAX_RECONCILE_LIMIT = 1000;

/* -------------------------------------------------------------------------- *
 * Contracts (Zod first, per AGENTS.md)
 * -------------------------------------------------------------------------- */

export const reconcileScheduledTestsInputSchema = z.object({
  /** How long a child may stay non-terminal before it is declared `timed_out`. */
  staleAfterMs: z
    .number()
    .int()
    .min(MIN_STALE_AFTER_MS)
    .default(SCHEDULED_ITEM_STALE_AFTER_MS),
  /** Max non-terminal children examined per invocation; the next hour picks up the rest. */
  limit: z.number().int().min(1).max(MAX_RECONCILE_LIMIT).default(DEFAULT_RECONCILE_LIMIT),
  /** Report what would be reconciled without writing anything. */
  dryRun: z.boolean().default(false),
});

export type ReconcileScheduledTestsInput = z.input<typeof reconcileScheduledTestsInputSchema>;
export type ReconcileScheduledTestsOptions = z.output<typeof reconcileScheduledTestsInputSchema>;

export const reconcileScheduledTestsResultSchema = z.object({
  reconciledAt: z.string(),
  staleAfterMs: z.number().int().nonnegative(),
  dryRun: z.boolean(),
  /** Non-terminal children the query returned. */
  itemsExamined: z.number().int().nonnegative(),
  itemsCompleted: z.number().int().nonnegative(),
  itemsFailed: z.number().int().nonnegative(),
  itemsTimedOut: z.number().int().nonnegative(),
  /** Children left alone — their run is still executing and they are not stale yet. */
  itemsPending: z.number().int().nonnegative(),
  /** Children whose write failed; they stay non-terminal and are retried next hour. */
  itemsWriteFailed: z.number().int().nonnegative(),
  runsUpdated: z.number().int().nonnegative(),
  runsCompleted: z.number().int().nonnegative(),
  runIds: z.array(z.string()),
});

export type ReconcileScheduledTestsResult = z.output<typeof reconcileScheduledTestsResultSchema>;

/* -------------------------------------------------------------------------- *
 * Data-access port
 * -------------------------------------------------------------------------- */

/** Minimal projection of the `test_results` row a child points at. */
export type ReconcilerTestRun = {
  id: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  elapsed_ms: number | null;
};

/** Pass/fail counts for one `test_results` row, tallied from its `test_result_items`. */
export type ScheduledItemTally = {
  test_run_id: string;
  items_total: number;
  items_passed: number;
  items_failed: number;
};

export type ScheduledTestReconcilerPort = {
  listNonTerminalItems(limit: number): Promise<ScheduledTestItem[]>;
  listTestRuns(testRunIds: string[]): Promise<ReconcilerTestRun[]>;
  listItemTallies(testRunIds: string[]): Promise<ScheduledItemTally[]>;
  updateItem(id: string, patch: ScheduledTestItemPatch): Promise<void>;
  listItemsForScheduledRuns(scheduledRunIds: string[]): Promise<ScheduledTestItem[]>;
  listScheduledRuns(scheduledRunIds: string[]): Promise<ScheduledTestRun[]>;
  updateRun(id: string, patch: ScheduledTestRunPatch): Promise<void>;
};

export type ReconcileScheduledTestsDeps = {
  port: ScheduledTestReconcilerPort;
  /** Injected clock (ms since epoch). Defaults to `Date.now` in the repository wiring. */
  now: () => number;
  /** Structured logging hook; injected so tests stay silent. */
  log?: (event: string, fields: Record<string, unknown>) => void;
};

/* -------------------------------------------------------------------------- *
 * Pure decisions
 * -------------------------------------------------------------------------- */

/**
 * The patch a single child needs, or `null` when it should be left alone.
 *
 * Ages are measured with `stalledForMs`, which clamps at 0 — `started_at` is a Postgres `now()`
 * while the caller's clock is Node's, so a freshly inserted child can legitimately look negative.
 */
export function resolveScheduledItemPatch(input: {
  item: ScheduledTestItem;
  run: ReconcilerTestRun | null;
  tally: ScheduledItemTally | null;
  nowMs: number;
  staleAfterMs: number;
}): ScheduledTestItemPatch | null {
  const { item, run, tally, nowMs, staleAfterMs } = input;
  const nowIso = new Date(nowMs).toISOString();

  if (run && isTerminalRunStatus(run.status)) {
    const completedAt = run.completed_at ?? nowIso;
    const startedAt = item.started_at ?? run.started_at;
    const measured =
      startedAt === null ? null : stalledForMs(startedAt, Date.parse(completedAt));

    const counts: ScheduledTestItemPatch = tally
      ? {
          items_total: tally.items_total,
          items_passed: tally.items_passed,
          items_failed: tally.items_failed,
          pass_rate:
            tally.items_total > 0 ? tally.items_passed / tally.items_total : null,
        }
      : {};

    if (isCompletedRunStatus(run.status)) {
      return {
        ...counts,
        status: 'completed',
        completed_at: completedAt,
        elapsed_ms: measured ?? run.elapsed_ms,
      };
    }

    return {
      ...counts,
      status: 'failed',
      completed_at: completedAt,
      elapsed_ms: measured ?? run.elapsed_ms,
      error_code: `run_${run.status}`,
      error_message: `Test run ended with status ${run.status}`,
    };
  }

  // Stale guard: the run never reported back, so nothing will ever close this child.
  const age = stalledForMs(item.started_at ?? item.created_at, nowMs);
  if (age !== null && age > staleAfterMs) {
    return {
      status: 'timed_out',
      completed_at: nowIso,
      elapsed_ms: age,
      error_code: SCHEDULED_ITEM_TIMED_OUT_ERROR,
      error_message: `No terminal test run after ${Math.round(age / 60000)} minutes`,
    };
  }

  return null;
}

/**
 * The parent patch implied by its children. Aggregates come from the shared pure helper so the
 * sweep, the reconciler and `/admin/scheduled` can never disagree on the arithmetic.
 */
export function buildScheduledRunPatch(
  run: ScheduledTestRun,
  items: ScheduledTestItem[],
  nowMs: number,
): { patch: ScheduledTestRunPatch; completed: boolean } {
  const aggregates = computeScheduledRunAggregates(items);
  const patch: ScheduledTestRunPatch = {
    total_tests: aggregates.total_tests,
    successful_tests: aggregates.successful_tests,
    failed_tests: aggregates.failed_tests,
    timed_out_tests: aggregates.timed_out_tests,
    success_rate: aggregates.success_rate,
    avg_elapsed_ms: aggregates.avg_elapsed_ms,
  };

  if (!aggregates.allTerminal) {
    return { patch, completed: false };
  }

  const completedAt = new Date(nowMs).toISOString();
  patch.status = 'completed';
  patch.completed_at = completedAt;
  patch.elapsed_ms = stalledForMs(run.started_at ?? run.sweep_triggered_at, nowMs);

  return { patch, completed: true };
}

/* -------------------------------------------------------------------------- *
 * The reconciliation
 * -------------------------------------------------------------------------- */

/**
 * Fold terminal `test_results` state back onto every non-terminal `scheduled_test_items` row, then
 * recompute each touched parent.
 *
 * Idempotent: selection is on non-terminal statuses, so a child that has already been reconciled is
 * never a candidate again. A per-row write failure is counted and skipped rather than aborting the
 * whole reconciliation — the child simply stays non-terminal and is retried next hour.
 */
export async function reconcileScheduledTests(
  deps: ReconcileScheduledTestsDeps,
  input: ReconcileScheduledTestsInput = {},
): Promise<ReconcileScheduledTestsResult> {
  const options = reconcileScheduledTestsInputSchema.parse(input);
  const nowMs = deps.now();
  const reconciledAt = new Date(nowMs).toISOString();
  const log = deps.log;

  const result: ReconcileScheduledTestsResult = {
    reconciledAt,
    staleAfterMs: options.staleAfterMs,
    dryRun: options.dryRun,
    itemsExamined: 0,
    itemsCompleted: 0,
    itemsFailed: 0,
    itemsTimedOut: 0,
    itemsPending: 0,
    itemsWriteFailed: 0,
    runsUpdated: 0,
    runsCompleted: 0,
    runIds: [],
  };

  const items = await deps.port.listNonTerminalItems(options.limit);
  result.itemsExamined = items.length;

  if (items.length === 0) {
    log?.('scheduled_test_reconcile_completed', { items_examined: 0 });
    return result;
  }

  const testRunIds = Array.from(
    new Set(
      items
        .map((item) => item.test_run_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  );

  const [runs, tallies] = await Promise.all([
    deps.port.listTestRuns(testRunIds),
    deps.port.listItemTallies(testRunIds),
  ]);

  const runById = new Map(runs.map((run) => [run.id, run]));
  const tallyByRunId = new Map(tallies.map((tally) => [tally.test_run_id, tally]));

  const touchedParentIds = new Set<string>();

  for (const item of items) {
    // A child with no `test_run_id` never got a run created for it, so there is nothing to fold
    // back — only the stale guard can ever close it.
    const run = item.test_run_id ? (runById.get(item.test_run_id) ?? null) : null;
    const tally = item.test_run_id ? (tallyByRunId.get(item.test_run_id) ?? null) : null;

    const patch = resolveScheduledItemPatch({
      item,
      run,
      tally,
      nowMs,
      staleAfterMs: options.staleAfterMs,
    });

    if (!patch) {
      result.itemsPending += 1;
      continue;
    }

    if (!options.dryRun) {
      try {
        await deps.port.updateItem(item.id, patch);
      } catch (error) {
        result.itemsWriteFailed += 1;
        log?.('scheduled_test_item_reconcile_failed', {
          scheduled_test_item_id: item.id,
          test_run_id: item.test_run_id,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    touchedParentIds.add(item.scheduled_run_id);

    if (patch.status === 'completed') {
      result.itemsCompleted += 1;
    } else if (patch.status === 'timed_out') {
      result.itemsTimedOut += 1;
    } else {
      result.itemsFailed += 1;
    }
  }

  if (touchedParentIds.size === 0) {
    log?.('scheduled_test_reconcile_completed', {
      items_examined: result.itemsExamined,
      items_pending: result.itemsPending,
    });
    return result;
  }

  const parentIds = Array.from(touchedParentIds);
  result.runIds = parentIds;

  const [parents, siblings] = await Promise.all([
    deps.port.listScheduledRuns(parentIds),
    deps.port.listItemsForScheduledRuns(parentIds),
  ]);

  const siblingsByParent = new Map<string, ScheduledTestItem[]>();
  for (const sibling of siblings) {
    const bucket = siblingsByParent.get(sibling.scheduled_run_id);
    if (bucket) {
      bucket.push(sibling);
    } else {
      siblingsByParent.set(sibling.scheduled_run_id, [sibling]);
    }
  }

  for (const parent of parents) {
    const children = siblingsByParent.get(parent.id) ?? [];
    if (children.length === 0) {
      continue;
    }

    const { patch, completed } = buildScheduledRunPatch(parent, children, nowMs);

    if (!options.dryRun) {
      try {
        await deps.port.updateRun(parent.id, patch);
      } catch (error) {
        log?.('scheduled_test_run_reconcile_failed', {
          scheduled_run_id: parent.id,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    result.runsUpdated += 1;
    if (completed) {
      result.runsCompleted += 1;
    }
  }

  log?.('scheduled_test_reconcile_completed', {
    items_examined: result.itemsExamined,
    items_completed: result.itemsCompleted,
    items_failed: result.itemsFailed,
    items_timed_out: result.itemsTimedOut,
    items_pending: result.itemsPending,
    items_write_failed: result.itemsWriteFailed,
    runs_updated: result.runsUpdated,
    runs_completed: result.runsCompleted,
    dry_run: result.dryRun,
  });

  return result;
}
