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
import {
  isProviderFaultKind,
  PROVIDER_FAULT_LABEL,
} from '~/lib/tests/provider-fault';
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

/**
 * B0-1014 — failure class written when a run's items never reached the model provider.
 *
 * Distinct from `run_failed`: the run itself ended cleanly, it just measured nothing.
 */
export const SCHEDULED_ITEM_PROVIDER_FAULT_ERROR = 'provider_fault';

/**
 * B0-1014 — 5% or more of a run's items carrying a `provider_fault` → the child closes `failed`,
 * not `completed`, however tidily the run itself ended.
 *
 * Deliberately the same number AND the same `>=` boundary as
 * `PROVIDER_FAULT_INVALID_RATE_THRESHOLD` in `~/lib/tests/run-provider-health.ts`, which is in turn
 * the same number as `DEGRADED_FALLBACK_RATE_THRESHOLD` in `~/lib/tests/run-health.ts`. The sweep
 * ledger at `/admin/scheduled` and the run UI at `/admin/tests` must never disagree about whether a
 * run is trustworthy: an operator who sees the banner "this run measured nothing" on a run must not
 * then see the sweep that dispatched it reporting that test as a success.
 *
 * Why it exists at all: on 2026-09-15 00:00 UTC the nightly golden sweep dispatched five sets into
 * an OpenAI organization that had run out of credits the previous evening. Every run ended
 * `completed`, so all five children closed `completed` with `pass_rate: 0`, and the parent recorded
 * `successful_tests: 5, failed_tests: 0, success_rate: 1`. The ledger said every test succeeded
 * while zero prompts had been answered.
 */
export const SCHEDULED_ITEM_PROVIDER_FAULT_RATE_THRESHOLD = 0.05;

export const DEFAULT_RECONCILE_LIMIT = 200;
export const MAX_RECONCILE_LIMIT = 1000;

/**
 * B0-989 — backfill window for a child with no `test_run_id`. The sweep creates every run within
 * seconds of the child row, so a matching `test_results` row created inside this window after the
 * child's `started_at` is the sweep's own run for that test; anything later is somebody else's.
 */
export const ORPHAN_BACKFILL_WINDOW_MS = 15 * 60 * 1000;

/** Clock skew tolerance in the other direction (`started_at` is Postgres `now()`, the run's `created_at` too, but written by a different statement). */
export const ORPHAN_BACKFILL_SKEW_MS = 60 * 1000;

/**
 * B0-1169 — how far back the grade back-fill looks for `completed` children still carrying
 * `grade = null`: 7 days.
 *
 * A child closes the hour its run ends, but the run's report (and so
 * `test_results.report_overall_grade`) is generated asynchronously afterwards by the
 * `sweep-pending-reports` cron — minutes to hours later, so on the first pass the grade almost never
 * exists yet. The revisit re-reads recently closed children until the grade appears. A report is
 * normally there within hours; 7 days keeps the hourly scan cheap while still covering a multi-day
 * report-sweeper outage. Anything older is left to the one-time SQL back-fill.
 */
export const GRADE_BACKFILL_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** B0-989 — children with no `test_run_id` that were linked to the sweep's run this pass. */
  itemsBackfilled: z.number().int().nonnegative().default(0),
  itemsCompleted: z.number().int().nonnegative(),
  itemsFailed: z.number().int().nonnegative(),
  itemsTimedOut: z.number().int().nonnegative(),
  /** Children left alone — their run is still executing and they are not stale yet. */
  itemsPending: z.number().int().nonnegative(),
  /** Children whose write failed; they stay non-terminal and are retried next hour. */
  itemsWriteFailed: z.number().int().nonnegative(),
  /** B0-1169 — `completed` children with no grade yet that the revisit pass re-read this time. */
  gradeBackfillExamined: z.number().int().nonnegative().default(0),
  /** B0-1169 — children whose `grade` was copied from `test_results.report_overall_grade` this pass. */
  itemsGraded: z.number().int().nonnegative().default(0),
  runsUpdated: z.number().int().nonnegative(),
  runsCompleted: z.number().int().nonnegative(),
  runIds: z.array(z.string()),
});

export type ReconcileScheduledTestsResult = z.output<typeof reconcileScheduledTestsResultSchema>;

/* -------------------------------------------------------------------------- *
 * Data-access port
 * -------------------------------------------------------------------------- */

/**
 * Minimal projection of the `test_results` row a child points at.
 *
 * A Zod contract rather than a plain type because `report_overall_grade` (B0-1169) is a stored
 * generated column that the generated Supabase types do not carry, so the repository validates the
 * raw PostgREST rows against this instead of trusting a widened select.
 */
export const reconcilerTestRunSchema = z.object({
  id: z.string(),
  status: z.string(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  elapsed_ms: z.number().nullable(),
  /**
   * B0-1169 — `test_results.report_overall_grade`, i.e. `report_state.overall.grade`. Null until
   * the report sweeper has generated the run's report, which is usually AFTER the child closes.
   */
  report_overall_grade: z.string().nullable(),
});

export type ReconcilerTestRun = z.infer<typeof reconcilerTestRunSchema>;

/**
 * B0-989 — a `test_results` row the sweep created, as needed to re-link an orphaned child. Only
 * rows with `triggered_by = 'api-client'` qualify (the repository filters), so a human's run started
 * in the same minute can never be mistaken for the sweep's.
 */
export const reconcilerSweepRunSchema = reconcilerTestRunSchema.extend({
  test_id: z.string(),
  created_at: z.string(),
});

export type ReconcilerSweepRun = z.infer<typeof reconcilerSweepRunSchema>;

/** Pass/fail counts for one `test_results` row, tallied from its `test_result_items`. */
export type ScheduledItemTally = {
  test_run_id: string;
  items_total: number;
  items_passed: number;
  items_failed: number;
  /**
   * B0-1014 — items whose `test_result_items.provider_fault` is set, i.e. the model provider
   * refused the request and there is no answer to grade. Always in the same denominator as
   * `items_total`: a provider-faulted item is also counted as failed, because that is exactly how
   * the harness stored it.
   */
  items_provider_faulted: number;
  /**
   * The most common `provider_fault` value on this run, or null when none is set. Free text at the
   * database level, so this may be a value `PROVIDER_FAULT_KINDS` does not know.
   */
  provider_fault_kind: string | null;
};

export type ScheduledTestReconcilerPort = {
  listNonTerminalItems(limit: number): Promise<ScheduledTestItem[]>;
  /**
   * B0-1169 — `completed` children with `grade IS NULL` whose `completed_at` is at/after
   * `sinceIso`, oldest first. A sibling of `listNonTerminalItems` rather than a widening of it: the
   * non-terminal pass must keep its "already reconciled is never a candidate" invariant.
   */
  listCompletedUngradedItems(sinceIso: string, limit: number): Promise<ScheduledTestItem[]>;
  listTestRuns(testRunIds: string[]): Promise<ReconcilerTestRun[]>;
  /** B0-989 — sweep-created runs for these tests created at/after `sinceIso`, oldest first. */
  listSweepTestRunsForTests(testIds: string[], sinceIso: string): Promise<ReconcilerSweepRun[]>;
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
 * B0-1014 — did enough of this run's items never reach the provider to invalidate its pass rate?
 *
 * A run with no items is NOT provider-faulted: there is nothing to say about a provider that was
 * never called, and the stale guard already covers a child that produced nothing at all.
 */
export function isProviderFaultedTally(
  tally: ScheduledItemTally,
  threshold: number = SCHEDULED_ITEM_PROVIDER_FAULT_RATE_THRESHOLD,
): boolean {
  if (tally.items_total <= 0 || tally.items_provider_faulted <= 0) {
    return false;
  }
  return tally.items_provider_faulted / tally.items_total >= threshold;
}

/**
 * The `error_message` a person reading `/admin/scheduled` gets. Names the kind and both counts so
 * the row is actionable without opening the run: "re-run this once credits are back", not "0%".
 */
export function describeProviderFault(tally: ScheduledItemTally): string {
  const kind = tally.provider_fault_kind;
  // The column is free text; an unrecognized value is still a refusal and is quoted verbatim.
  const cause = kind
    ? isProviderFaultKind(kind)
      ? ` (${PROVIDER_FAULT_LABEL[kind]})`
      : ` (${kind})`
    : '';

  return (
    `${tally.items_provider_faulted} of ${tally.items_total} items got no answer: ` +
    `the model provider refused the request${cause}. ` +
    'This run measured nothing and must be re-run.'
  );
}

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
      // B0-1014 — a run that ended cleanly but never reached the provider is not a success. The
      // counts are still written: hiding them would trade one lie for another. `status` and
      // `error_code` are what stop the parent rolling this up as `successful_tests`.
      if (tally && isProviderFaultedTally(tally)) {
        return {
          ...counts,
          status: 'failed',
          completed_at: completedAt,
          elapsed_ms: measured ?? run.elapsed_ms,
          error_code: SCHEDULED_ITEM_PROVIDER_FAULT_ERROR,
          error_message: describeProviderFault(tally),
        };
      }

      // B0-1169 — the grade is a straight copy of the run's report grade, never derived from the
      // counts. The report usually does not exist yet at this point; the key is left out (not
      // written null) so the revisit pass can fill it in later without touching anything else.
      return {
        ...counts,
        status: 'completed',
        completed_at: completedAt,
        elapsed_ms: measured ?? run.elapsed_ms,
        ...(run.report_overall_grade !== null ? { grade: run.report_overall_grade } : {}),
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
 * B0-989 — the sweep run an orphaned child (no `test_run_id`) belongs to, or `null`.
 *
 * The child's `started_at` is the instant the sweep opened its ledger, a few seconds before it
 * created any run, so the match is the EARLIEST run for the same test created inside
 * [`started_at` − skew, `started_at` + window]. Runs are consumed as they are matched so two
 * children of two sweeps for the same test cannot both claim one run.
 */
export function matchOrphanToSweepRun(
  item: Pick<ScheduledTestItem, 'test_id' | 'started_at' | 'created_at'>,
  runs: ReconcilerSweepRun[],
  consumed: Set<string> = new Set(),
): ReconcilerSweepRun | null {
  const anchor = Date.parse(item.started_at ?? item.created_at);
  if (Number.isNaN(anchor)) return null;

  const candidates = runs
    .filter((run) => run.test_id === item.test_id && !consumed.has(run.id))
    .map((run) => ({ run, createdMs: Date.parse(run.created_at) }))
    .filter(
      ({ createdMs }) =>
        !Number.isNaN(createdMs) &&
        createdMs >= anchor - ORPHAN_BACKFILL_SKEW_MS &&
        createdMs <= anchor + ORPHAN_BACKFILL_WINDOW_MS,
    )
    .sort((a, b) => a.createdMs - b.createdMs);

  const match = candidates[0]?.run ?? null;
  if (match) consumed.add(match.id);
  return match;
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

  // A sweep ended when its LAST CHILD ended, not when the reconciler happened to notice. Stamping
  // `nowMs` inflates every sweep by however long the cron took to come round — up to an hour in
  // production, and unbounded for a locally triggered sweep (no cron fires against localhost, so
  // one observed sweep read 7.96h for 4.7 minutes of work). `nowMs` is the fallback only when no
  // child carries a completion stamp at all.
  const latestChildCompletionMs = items.reduce<number | null>((latest, item) => {
    if (item.completed_at === null) return latest;
    const parsed = Date.parse(item.completed_at);
    if (Number.isNaN(parsed)) return latest;
    return latest === null || parsed > latest ? parsed : latest;
  }, null);

  const completedMs = latestChildCompletionMs ?? nowMs;
  patch.status = 'completed';
  patch.completed_at = new Date(completedMs).toISOString();
  patch.elapsed_ms = stalledForMs(run.started_at ?? run.sweep_triggered_at, completedMs);

  return { patch, completed: true };
}

/* -------------------------------------------------------------------------- *
 * The reconciliation
 * -------------------------------------------------------------------------- */

/**
 * Fold terminal `test_results` state back onto every non-terminal `scheduled_test_items` row, then
 * recompute each touched parent. Then (B0-1169) revisit recently `completed` children that still
 * have no `grade` and copy the run's report grade in once the report exists.
 *
 * Idempotent: the first pass selects on non-terminal statuses, so a child that has already been
 * reconciled is never a candidate again; the revisit selects on `grade IS NULL`, so a graded child
 * drops out the moment it is written. A per-row write failure is counted and skipped rather than
 * aborting the whole reconciliation — the child simply stays as it was and is retried next hour.
 */
export async function reconcileScheduledTests(
  deps: ReconcileScheduledTestsDeps,
  input: ReconcileScheduledTestsInput = {},
): Promise<ReconcileScheduledTestsResult> {
  const options = reconcileScheduledTestsInputSchema.parse(input);
  const nowMs = deps.now();
  const reconciledAt = new Date(nowMs).toISOString();

  const result: ReconcileScheduledTestsResult = {
    reconciledAt,
    staleAfterMs: options.staleAfterMs,
    dryRun: options.dryRun,
    itemsExamined: 0,
    itemsBackfilled: 0,
    itemsCompleted: 0,
    itemsFailed: 0,
    itemsTimedOut: 0,
    itemsPending: 0,
    itemsWriteFailed: 0,
    gradeBackfillExamined: 0,
    itemsGraded: 0,
    runsUpdated: 0,
    runsCompleted: 0,
    runIds: [],
  };

  await foldTerminalState(deps, options, nowMs, result);
  await backfillGrades(deps, options, nowMs, result);

  deps.log?.('scheduled_test_reconcile_completed', {
    items_examined: result.itemsExamined,
    items_backfilled: result.itemsBackfilled,
    items_completed: result.itemsCompleted,
    items_failed: result.itemsFailed,
    items_timed_out: result.itemsTimedOut,
    items_pending: result.itemsPending,
    items_write_failed: result.itemsWriteFailed,
    grade_backfill_examined: result.gradeBackfillExamined,
    items_graded: result.itemsGraded,
    runs_updated: result.runsUpdated,
    runs_completed: result.runsCompleted,
    dry_run: result.dryRun,
  });

  return result;
}

/** The original B0-941 pass: close non-terminal children and recompute their parents. */
async function foldTerminalState(
  deps: ReconcileScheduledTestsDeps,
  options: ReconcileScheduledTestsOptions,
  nowMs: number,
  result: ReconcileScheduledTestsResult,
): Promise<void> {
  const log = deps.log;

  const items = await deps.port.listNonTerminalItems(options.limit);
  result.itemsExamined = items.length;

  if (items.length === 0) {
    return;
  }

  /**
   * B0-989 — re-link children the sweep never got to stamp. A child arrives here with no
   * `test_run_id` when the sweep invocation died (or stopped listening) before the execute call
   * returned; the run it created is still in `test_results`, so find it by test and time and fold
   * it in exactly as if the sweep had recorded it. The id is written alongside whatever patch the
   * child gets below — even a still-`running` child gets the link, so `/admin/scheduled` can show it.
   */
  const backfilledRunIds = new Map<string, string>();
  const orphans = items.filter((item) => !item.test_run_id);
  if (orphans.length > 0) {
    const anchors = orphans
      .map((item) => Date.parse(item.started_at ?? item.created_at))
      .filter((value) => !Number.isNaN(value));
    if (anchors.length > 0) {
      const sinceIso = new Date(Math.min(...anchors) - ORPHAN_BACKFILL_SKEW_MS).toISOString();
      const sweepRuns = await deps.port.listSweepTestRunsForTests(
        Array.from(new Set(orphans.map((item) => item.test_id))),
        sinceIso,
      );
      const consumed = new Set<string>();
      for (const orphan of orphans) {
        const match = matchOrphanToSweepRun(orphan, sweepRuns, consumed);
        if (match) {
          orphan.test_run_id = match.id;
          backfilledRunIds.set(orphan.id, match.id);
        }
      }
    }
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

    const resolved = resolveScheduledItemPatch({
      item,
      run,
      tally,
      nowMs,
      staleAfterMs: options.staleAfterMs,
    });

    const backfilledRunId = backfilledRunIds.get(item.id);
    const patch: ScheduledTestItemPatch | null =
      resolved || backfilledRunId
        ? { ...(resolved ?? {}), ...(backfilledRunId ? { test_run_id: backfilledRunId } : {}) }
        : null;

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

    if (backfilledRunId) {
      result.itemsBackfilled += 1;
    }

    // A link-only patch (the run is still executing) changes nothing the parent aggregates read.
    if (!resolved) {
      result.itemsPending += 1;
      continue;
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
    return;
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
}

/**
 * B0-1169 — the revisit pass. Every child the first pass closes `completed` does so before its
 * run's report exists (reports are generated by the `sweep-pending-reports` cron after the run
 * ends), so `grade` is almost always still null on the hour the child closes. This re-reads
 * `completed` children inside `GRADE_BACKFILL_WINDOW_MS` with no grade and copies the run's
 * `report_overall_grade` in once it is there.
 *
 * Writes `grade` and nothing else: no status, no `completed_at`, no parent recompute — the parent's
 * aggregates do not include grade, and the child's terminal state was already correct. A run whose
 * report still has no grade is simply skipped and re-examined next hour.
 */
async function backfillGrades(
  deps: ReconcileScheduledTestsDeps,
  options: ReconcileScheduledTestsOptions,
  nowMs: number,
  result: ReconcileScheduledTestsResult,
): Promise<void> {
  const sinceIso = new Date(nowMs - GRADE_BACKFILL_WINDOW_MS).toISOString();
  const items = await deps.port.listCompletedUngradedItems(sinceIso, options.limit);
  result.gradeBackfillExamined = items.length;

  const testRunIds = Array.from(
    new Set(
      items
        .map((item) => item.test_run_id)
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ),
  );
  if (testRunIds.length === 0) {
    return;
  }

  const runs = await deps.port.listTestRuns(testRunIds);
  const gradeByRunId = new Map(
    runs
      .filter((run) => run.report_overall_grade !== null)
      .map((run) => [run.id, run.report_overall_grade as string]),
  );

  for (const item of items) {
    const grade = item.test_run_id ? gradeByRunId.get(item.test_run_id) : undefined;
    if (grade === undefined) {
      continue;
    }

    if (!options.dryRun) {
      try {
        await deps.port.updateItem(item.id, { grade });
      } catch (error) {
        result.itemsWriteFailed += 1;
        deps.log?.('scheduled_test_item_grade_backfill_failed', {
          scheduled_test_item_id: item.id,
          test_run_id: item.test_run_id,
          message: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
    }

    result.itemsGraded += 1;
  }
}
