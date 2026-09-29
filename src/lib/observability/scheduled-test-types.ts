import { z } from 'zod';

/**
 * B0-941 — shared row contracts for `public.scheduled_test_runs` / `public.scheduled_test_items`.
 *
 * These tables are a DURABLE SWEEP LEDGER, not a second copy of grading truth. The sweep writes a
 * parent row plus one child row per dispatched golden test at dispatch time, and the hourly
 * reconciler (`~/lib/observability/reconcile-scheduled-tests.ts`) later folds each child's terminal
 * state back from `test_results`. `test_results` remains the system of record for grades: a child's
 * `test_run_id` is the join back to it, and anything derived here is a convenience denormalization
 * that the reconciler owns.
 *
 * Lives in its own module (rather than beside either writer or reader) because the sweep, the
 * reconciler, and `/admin/scheduled` all depend on it and none of them should depend on each other.
 */

export const SCHEDULED_RUN_STATUSES = [
  'queued',
  'in_progress',
  'completed',
  'failed',
] as const;
export type ScheduledRunStatus = (typeof SCHEDULED_RUN_STATUSES)[number];

export const SCHEDULED_ITEM_STATUSES = [
  'queued',
  'claimed',
  'running',
  'completed',
  'failed',
  'timed_out',
  'skipped',
] as const;
export type ScheduledItemStatus = (typeof SCHEDULED_ITEM_STATUSES)[number];

/** Child rows in these states are terminal — the reconciler never revisits them. */
export const TERMINAL_SCHEDULED_ITEM_STATUSES = [
  'completed',
  'failed',
  'timed_out',
  'skipped',
] as const;

export function isTerminalScheduledItemStatus(
  status: ScheduledItemStatus,
): boolean {
  return (TERMINAL_SCHEDULED_ITEM_STATUSES as readonly string[]).includes(
    status,
  );
}

/**
 * B0-1106 — a sweep is either a full sweep (every item of every active golden set) or a partial
 * sweep (only the items under a score threshold). Partial sweeps are display-only: they never feed
 * a golden-set metric, which is why the two are listed in separate sections on /admin/tests.
 */
export const SWEEP_RUN_MODES = ['full', 'partial'] as const;
export type SweepRunMode = (typeof SWEEP_RUN_MODES)[number];

/** `scheduled_test_runs.sweep_name` values — the trigger source, not the mode. */
export const CRON_SWEEP_NAME = 'golden_test_sweep';
export const MANUAL_SWEEP_NAME = 'manual_golden_sweep';

export const scheduledTestRunSchema = z.object({
  id: z.string(),
  sweep_name: z.string(),
  /** B0-1106 — `full` | `partial`; defaults to `full` at the database. */
  run_mode: z.enum(SWEEP_RUN_MODES),
  /** B0-1106 — the 0–100 bar a partial sweep was filtered by; null for full sweeps. */
  partial_score_threshold: z.number().nullable(),
  sweep_triggered_at: z.string(),
  status: z.enum(SCHEDULED_RUN_STATUSES),
  error_message: z.string().nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  elapsed_ms: z.number().nullable(),
  total_tests: z.number(),
  successful_tests: z.number(),
  failed_tests: z.number(),
  timed_out_tests: z.number(),
  success_rate: z.number().nullable(),
  avg_elapsed_ms: z.number().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ScheduledTestRun = z.infer<typeof scheduledTestRunSchema>;

export const scheduledTestItemSchema = z.object({
  id: z.string(),
  scheduled_run_id: z.string(),
  test_id: z.string(),
  test_name: z.string(),
  /** `test_results.id` — null when the create call itself failed, so no run exists to join to. */
  test_run_id: z.string().nullable(),
  status: z.enum(SCHEDULED_ITEM_STATUSES),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  elapsed_ms: z.number().nullable(),
  items_total: z.number().nullable(),
  items_passed: z.number().nullable(),
  items_failed: z.number().nullable(),
  pass_rate: z.number().nullable(),
  grade: z.string().nullable(),
  confidence: z.number().nullable(),
  /** Machine-readable failure class, e.g. `dispatch_create`, `dispatch_execute`, `timed_out`. */
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  error_details: z.record(z.string(), z.unknown()).nullable(),
  retry_count: z.number(),
  last_retry_at: z.string().nullable(),
  claimed_by: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type ScheduledTestItem = z.infer<typeof scheduledTestItemSchema>;

export type ScheduledTestRunWithItems = ScheduledTestRun & {
  items: ScheduledTestItem[];
};

/**
 * Recomputes a parent's aggregates from its children. Pure, so the reconciler's arithmetic is
 * unit-testable without a database.
 *
 * `success_rate` and `avg_elapsed_ms` are null when there is nothing terminal to average — "no
 * data" must not render as 0%, the same rule `~/lib/tests/golden-set.ts` holds for tier pass rates.
 */
export function computeScheduledRunAggregates(items: ScheduledTestItem[]): {
  total_tests: number;
  successful_tests: number;
  failed_tests: number;
  timed_out_tests: number;
  success_rate: number | null;
  avg_elapsed_ms: number | null;
  allTerminal: boolean;
} {
  const successful = items.filter((item) => item.status === 'completed').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const timedOut = items.filter((item) => item.status === 'timed_out').length;
  const terminal = items.filter((item) =>
    isTerminalScheduledItemStatus(item.status),
  );

  const elapsed = items
    .map((item) => item.elapsed_ms)
    .filter((value): value is number => typeof value === 'number');

  return {
    total_tests: items.length,
    successful_tests: successful,
    failed_tests: failed,
    timed_out_tests: timedOut,
    success_rate:
      terminal.length > 0 ? successful / terminal.length : null,
    avg_elapsed_ms:
      elapsed.length > 0
        ? elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length
        : null,
    allTerminal: items.length > 0 && terminal.length === items.length,
  };
}
