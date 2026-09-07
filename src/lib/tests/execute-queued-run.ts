import { z } from 'zod';

import {
  claimQueuedTestResultForExecution,
  getTestResultById,
} from '~/lib/tests/repository';
import { executeTestRun } from '~/lib/tests/run-executor';
import { executeSearchRun } from '~/lib/tests/search-run-executor';
import { isTerminalRunStatus, type TestResultRecord } from '~/lib/tests/types';

export const executeQueuedTestRunStateSchema = z.enum([
  'started',
  'already_running',
  'already_finished',
  'not_found',
]);

export type ExecuteQueuedTestRunState = z.infer<typeof executeQueuedTestRunStateSchema>;

/**
 * Atomically claims a queued run (`queued` → `running`) and, if this caller won the claim, executes
 * it to completion on the runner matching its `run_mode`. Returns whether the claim was won; a
 * `false` means another invocation already owns the run and nothing was executed.
 *
 * This is the claim+dispatch block that `POST /api/admin/tests/runs/[runId]` and the PATCH
 * `restart` / `retry_failed` branches all shared inline; it takes the already-loaded row so those
 * callers keep their exact query count and response semantics.
 */
export async function claimAndExecuteQueuedRun(
  run: Pick<TestResultRecord, 'id' | 'run_mode'>,
): Promise<boolean> {
  const claimed = await claimQueuedTestResultForExecution(run.id);
  if (!claimed) return false;

  if (run.run_mode === 'search') {
    await executeSearchRun(run.id);
  } else {
    await executeTestRun(run.id);
  }
  return true;
}

/**
 * B0-883 — load-then-claim-then-execute for a run id: the single-run route's POST body, and what
 * the "Run Golden" fan-out (`runGoldenTestsAction`) schedules per created run via `after()`.
 *
 * - `not_found`        — no such run.
 * - `already_finished` — the run is in a terminal status; nothing to do.
 * - `already_running`  — the run is `running`/`paused`, or another caller won the `queued` claim.
 * - `started`          — this caller claimed the run and its execution has completed (the promise
 *                        resolves after `executeTestRun`/`executeSearchRun` returns, exactly as
 *                        the route handler behaves).
 */
export async function executeQueuedTestRun(
  runId: string,
): Promise<{ state: ExecuteQueuedTestRunState }> {
  const run = await getTestResultById(runId).catch(() => null);
  if (!run) return { state: 'not_found' };

  if (isTerminalRunStatus(run.status)) return { state: 'already_finished' };

  if (run.status === 'queued') {
    const claimed = await claimAndExecuteQueuedRun(run);
    return { state: claimed ? 'started' : 'already_running' };
  }

  return { state: 'already_running' };
}
