import { z } from 'zod';

import { logWarn } from '~/lib/observability/logger';
import {
  closeScheduledRunAfterDispatch,
  insertScheduledTestItems,
  insertScheduledTestRun,
  updateScheduledTestItem,
} from '~/lib/observability/scheduled-test-repository';
import { listGoldenTests } from '~/lib/tests/golden-set';

import type { ScheduledTestItem } from '~/lib/observability/scheduled-test-types';

const ADMIN_RUNS_PATH = '/api/admin/tests/runs';

/* -------------------------------------------------------------------------- *
 * Contracts (Zod first, per AGENTS.md)
 * -------------------------------------------------------------------------- */

export const runGoldenTestSweepInputSchema = z.object({
  /** Report which golden tests would be queued/executed without actually doing either. */
  dryRun: z.boolean().default(false),
});

export type RunGoldenTestSweepInput = z.input<typeof runGoldenTestSweepInputSchema>;
export type RunGoldenTestSweepOptions = z.output<typeof runGoldenTestSweepInputSchema>;

export const goldenTestSweepOutcomeSchema = z.object({
  testId: z.string(),
  testName: z.string(),
  ok: z.boolean(),
  runId: z.string().nullable(),
  /** `POST /api/admin/tests/runs/[runId]`'s own `state` field (`started`, `already_running`, …). */
  state: z.string().nullable(),
  /** Which of the two HTTP calls failed, when `ok` is false. */
  step: z.enum(['create', 'execute']).nullable(),
  error: z.string().nullable(),
});
export type GoldenTestSweepOutcome = z.infer<typeof goldenTestSweepOutcomeSchema>;

export const runGoldenTestSweepResultSchema = z.object({
  dryRun: z.boolean(),
  goldenTestCount: z.number().int().nonnegative(),
  started: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  outcomes: z.array(goldenTestSweepOutcomeSchema),
  /**
   * B0-941 — `scheduled_test_runs.id` for this sweep's ledger row. Absent on a dry run, and also
   * when persistence failed: the ledger is observability, never a precondition for dispatching.
   */
  scheduledRunId: z.string().optional(),
});
export type RunGoldenTestSweepResult = z.infer<typeof runGoldenTestSweepResultSchema>;

async function queueAndRunGoldenTest(
  origin: string,
  authorization: string,
  test: { id: string; name: string },
): Promise<GoldenTestSweepOutcome> {
  const base = { testId: test.id, testName: test.name };

  let createResponse: Response;
  try {
    createResponse = await fetch(`${origin}${ADMIN_RUNS_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: authorization },
      body: JSON.stringify({ testId: test.id }),
    });
  } catch (error) {
    return {
      ...base,
      ok: false,
      runId: null,
      state: null,
      step: 'create',
      error: error instanceof Error ? error.message : 'Network error creating run',
    };
  }

  const createBody = (await createResponse.json().catch(() => null)) as
    | { ok?: boolean; runId?: string; error?: string }
    | null;

  if (!createResponse.ok || !createBody?.ok || !createBody.runId) {
    return {
      ...base,
      ok: false,
      runId: createBody?.runId ?? null,
      state: null,
      step: 'create',
      error: createBody?.error ?? `HTTP ${createResponse.status}`,
    };
  }

  const runId = createBody.runId;

  let executeResponse: Response;
  try {
    executeResponse = await fetch(`${origin}${ADMIN_RUNS_PATH}/${runId}`, {
      method: 'POST',
      headers: { Authorization: authorization },
    });
  } catch (error) {
    return {
      ...base,
      ok: false,
      runId,
      state: null,
      step: 'execute',
      error: error instanceof Error ? error.message : 'Network error executing run',
    };
  }

  const executeBody = (await executeResponse.json().catch(() => null)) as
    | { ok?: boolean; state?: string; error?: string }
    | null;

  if (!executeResponse.ok || !executeBody?.ok) {
    return {
      ...base,
      ok: false,
      runId,
      state: executeBody?.state ?? null,
      step: 'execute',
      error: executeBody?.error ?? `HTTP ${executeResponse.status}`,
    };
  }

  return {
    ...base,
    ok: true,
    runId,
    state: executeBody.state ?? 'started',
    step: null,
    error: null,
  };
}

/* -------------------------------------------------------------------------- *
 * B0-941 — durable sweep ledger
 * -------------------------------------------------------------------------- */

type SweepLedger = {
  scheduledRunId: string;
  startedAtIso: string;
  /** Child row plus its current in-memory state, keyed by golden test id. */
  itemsByTestId: Map<string, ScheduledTestItem>;
};

/**
 * Writes the parent + one child per golden test BEFORE anything is dispatched, so a sweep that
 * dies mid-flight still leaves a visible record of what it was doing.
 *
 * Returns `null` on any failure: the ledger is observability and must never be able to take down
 * the thing it observes, so a broken write is logged and the sweep dispatches regardless.
 */
async function openSweepLedger(
  goldenTests: { id: string; name: string }[],
  context: { origin: string },
): Promise<SweepLedger | null> {
  const startedAtIso = new Date().toISOString();

  try {
    const run = await insertScheduledTestRun({
      sweepTriggeredAt: startedAtIso,
      totalTests: goldenTests.length,
      metadata: { origin: context.origin },
    });

    const items = await insertScheduledTestItems({
      scheduledRunId: run.id,
      startedAt: startedAtIso,
      tests: goldenTests,
    });

    return {
      scheduledRunId: run.id,
      startedAtIso,
      itemsByTestId: new Map(items.map((item) => [item.test_id, item])),
    };
  } catch (error) {
    logWarn('scheduled_test_ledger_open_failed', {
      golden_test_count: goldenTests.length,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Folds one dispatch outcome onto its child row.
 *
 * A successful dispatch only records `test_run_id` and stays `running` — the run is still
 * executing, and `~/lib/observability/reconcile-scheduled-tests.ts` is what closes it.
 */
async function recordDispatchOutcome(
  ledger: SweepLedger | null,
  outcome: GoldenTestSweepOutcome,
): Promise<void> {
  const item = ledger?.itemsByTestId.get(outcome.testId);
  if (!ledger || !item) {
    return;
  }

  const patch = outcome.ok
    ? { test_run_id: outcome.runId }
    : {
        test_run_id: outcome.runId,
        status: 'failed' as const,
        completed_at: new Date().toISOString(),
        error_code: outcome.step ? `dispatch_${outcome.step}` : 'dispatch_failed',
        error_message: outcome.error,
      };

  try {
    await updateScheduledTestItem(item.id, patch);
    ledger.itemsByTestId.set(outcome.testId, { ...item, ...patch });
  } catch (error) {
    logWarn('scheduled_test_item_write_failed', {
      scheduled_test_item_id: item.id,
      test_id: outcome.testId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Closes the parent once dispatch is done. Only an all-dispatch-failed sweep is terminal here —
 * any run that actually started is still executing, so the parent stays `in_progress` for the
 * reconciler rather than being called "completed" on the strength of an HTTP 200.
 */
async function closeSweepLedger(ledger: SweepLedger | null): Promise<void> {
  if (!ledger) {
    return;
  }

  try {
    await closeScheduledRunAfterDispatch({
      scheduledRunId: ledger.scheduledRunId,
      items: Array.from(ledger.itemsByTestId.values()),
      startedAtIso: ledger.startedAtIso,
      completedAtIso: new Date().toISOString(),
    });
  } catch (error) {
    logWarn('scheduled_test_ledger_close_failed', {
      scheduled_run_id: ledger.scheduledRunId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * B0-766 — nightly "run every golden test" sweep.
 *
 * Queries `tests.is_golden = true` through `~/lib/tests/golden-set.ts`'s own reader (`golden-set.ts`'s
 * header comment is explicit: membership is strictly that audited flag, never another signal), and
 * for each golden test drives the SAME two-step choreography the "Run dataset" button
 * (`RunExecutionProgress`) already uses: `POST /api/admin/tests/runs` to create a queued run, then
 * `POST /api/admin/tests/runs/[runId]` to claim and execute it.
 *
 * Both are real HTTP calls back into this same deployment — never a direct import of
 * `createTestResult`/`executeTestRun` — so this sweep can never drift from what a human clicking
 * "Run dataset" gets: same `run_options` shape, same `claimQueuedTestResultForExecution` guard
 * against double-execution, same summary seed. `origin` and `authorization` come from the caller's
 * own request (see the route handler): the cron's `Authorization: Bearer $CRON_SECRET` is a real
 * `bex_<env>_…` client token already authorized for `/api/admin/tests/runs*`
 * (`authorizeAdminTestsRoute` accepts the same registry token `withApiV1` does via
 * `resolveBexActor` → `authenticateApiToken`), so it is forwarded rather than minted again.
 *
 * Every golden test's create+execute pair runs CONCURRENTLY (`Promise.all`), not sequentially —
 * `POST .../[runId]` awaits the run's full execution before responding (bounded by its own 300s
 * `maxDuration`), so running N golden tests one after another could take up to N times that;
 * concurrently, the whole sweep is bounded by the slowest single test instead. A test whose
 * execution invocation is killed mid-run by that budget is left `running` and picked up by the
 * existing hourly `/api/v1/observability/sweep-stalled-runs` cron, exactly as it would be if a
 * human's browser tab had closed mid-run.
 */
export async function runGoldenTestSweep(
  options: RunGoldenTestSweepOptions,
  context: { origin: string; authorization: string },
): Promise<RunGoldenTestSweepResult> {
  // B0-942 — archived golden sets are excluded: the sweep must not burn a run (and the LLM spend
  // behind it) on a set nobody maintains any more. Matches what B0-883's "Run Golden" trigger does.
  const goldenTests = await listGoldenTests({ includeArchived: false });

  // A dry run is a preview: it deliberately persists NOTHING to the scheduled-test ledger.
  if (options.dryRun || goldenTests.length === 0) {
    return {
      dryRun: options.dryRun,
      goldenTestCount: goldenTests.length,
      started: 0,
      failed: 0,
      outcomes: goldenTests.map((test) => ({
        testId: test.id,
        testName: test.name,
        ok: true,
        runId: null,
        state: options.dryRun ? 'dry_run' : null,
        step: null,
        error: null,
      })),
    };
  }

  const ledger = await openSweepLedger(
    goldenTests.map((test) => ({ id: test.id, name: test.name })),
    { origin: context.origin },
  );

  const outcomes = await Promise.all(
    goldenTests.map(async (test) => {
      const outcome = await queueAndRunGoldenTest(context.origin, context.authorization, {
        id: test.id,
        name: test.name,
      });
      await recordDispatchOutcome(ledger, outcome);
      return outcome;
    }),
  );

  await closeSweepLedger(ledger);

  return {
    dryRun: false,
    goldenTestCount: goldenTests.length,
    started: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
    outcomes,
    ...(ledger ? { scheduledRunId: ledger.scheduledRunId } : {}),
  };
}
