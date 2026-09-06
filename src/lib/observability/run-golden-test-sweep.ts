import { z } from 'zod';

import { listGoldenTests } from '~/lib/tests/golden-set';

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
  const goldenTests = await listGoldenTests();

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

  const outcomes = await Promise.all(
    goldenTests.map((test) =>
      queueAndRunGoldenTest(context.origin, context.authorization, {
        id: test.id,
        name: test.name,
      }),
    ),
  );

  return {
    dryRun: false,
    goldenTestCount: goldenTests.length,
    started: outcomes.filter((outcome) => outcome.ok).length,
    failed: outcomes.filter((outcome) => !outcome.ok).length,
    outcomes,
  };
}
