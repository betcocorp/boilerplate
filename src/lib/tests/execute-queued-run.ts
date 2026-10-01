import { z } from 'zod';

import { logWarn } from '~/lib/observability/logger';

import {
  claimQueuedTestResultForExecution,
  getTestResultById,
} from '~/lib/tests/repository';
import { executeTestRun, type ExecuteTestRunOutcome } from '~/lib/tests/run-executor';
import { scheduleRunContinuation } from '~/lib/tests/schedule-run-continuation';
import { executeSearchRun } from '~/lib/tests/search-run-executor';
import { isTerminalRunStatus, type TestResultRecord } from '~/lib/tests/types';

export const executeQueuedTestRunStateSchema = z.enum([
  'started',
  'already_running',
  'already_finished',
  'not_found',
]);

export type ExecuteQueuedTestRunState = z.infer<typeof executeQueuedTestRunStateSchema>;

type ClaimableRun = Pick<TestResultRecord, 'id' | 'run_mode'>;

/**
 * B0-990 — executes a run this caller has ALREADY claimed, and if the executor yielded (wall-clock
 * budget exhausted with items left) fires the next continuation hop. Every path that runs a claimed
 * run goes through here — the route handler, the background hop, the "Run Golden" fan-out and the
 * PATCH restart — so a yield is never dropped by one caller that forgot to chain.
 *
 * `hop` is the hop number of the invocation doing the executing (1 for a fresh start); the
 * continuation is scheduled as `hop + 1` so the chain can be capped.
 */
export async function executeClaimedRun(
  run: ClaimableRun,
  options: { hop?: number } = {},
): Promise<ExecuteTestRunOutcome> {
  if (run.run_mode === 'search') {
    // Search evals are seconds, not minutes; they neither budget nor yield.
    await executeSearchRun(run.id);
    return 'completed';
  }

  const outcome = await executeTestRun(run.id);
  if (outcome === 'yielded') {
    const hop = options.hop ?? 1;
    const scheduled = await scheduleRunContinuation({ testResultId: run.id, hop: hop + 1 });
    if (!scheduled.scheduled) {
      // The run is `queued` with runner_state 'yielded'; the stalled-test-run sweep re-arms it.
      logWarn('test_run_continuation_not_scheduled', {
        testResultId: run.id,
        hop,
        reason: scheduled.reason,
      });
    }
  }
  return outcome;
}

/**
 * Atomically claims a queued run (`queued` → `running`) and, if this caller won the claim, executes
 * it on the runner matching its `run_mode`. Returns whether the claim was won; a `false` means
 * another invocation already owns the run and nothing was executed.
 *
 * This is the claim+dispatch block that `POST /api/admin/tests/runs/[runId]` and the PATCH
 * `restart` / `retry_failed` branches all shared inline; it takes the already-loaded row so those
 * callers keep their exact query count and response semantics.
 */
export async function claimAndExecuteQueuedRun(run: ClaimableRun): Promise<boolean> {
  const claimed = await claimQueuedTestResultForExecution(run.id);
  if (!claimed) return false;

  await executeClaimedRun(run);
  return true;
}

export type ClaimQueuedTestRunResult =
  | { state: 'claimed'; run: TestResultRecord }
  | { state: Exclude<ExecuteQueuedTestRunState, 'started'> };

/**
 * B0-990 — the claim half on its own, for the background mode of `POST /api/admin/tests/runs/[runId]`:
 * the route claims synchronously (so a second hop or a human cannot double-execute), answers 202,
 * and only then executes in `after()` under its own fresh budget.
 */
export async function claimQueuedTestRun(runId: string): Promise<ClaimQueuedTestRunResult> {
  const run = await getTestResultById(runId).catch(() => null);
  if (!run) return { state: 'not_found' };

  if (isTerminalRunStatus(run.status)) return { state: 'already_finished' };

  if (run.status === 'queued') {
    const claimed = await claimQueuedTestResultForExecution(run.id);
    return claimed ? { state: 'claimed', run } : { state: 'already_running' };
  }

  return { state: 'already_running' };
}

/**
 * B0-883 — load-then-claim-then-execute for a run id: the single-run route's POST body, and what
 * the "Run Golden" fan-out (`runGoldenTestsAction`) schedules per created run via `after()`.
 *
 * - `not_found`        — no such run.
 * - `already_finished` — the run is in a terminal status; nothing to do.
 * - `already_running`  — the run is `running`/`paused`, or another caller won the `queued` claim.
 * - `started`          — this caller claimed the run and its execution slice has completed (the
 *                        promise resolves after the executor returns, exactly as the route handler
 *                        behaves; B0-990: a yielded run has had its continuation scheduled).
 */
export async function executeQueuedTestRun(
  runId: string,
): Promise<{ state: ExecuteQueuedTestRunState }> {
  const claim = await claimQueuedTestRun(runId);
  if (claim.state !== 'claimed') return { state: claim.state };

  await executeClaimedRun(claim.run);
  return { state: 'started' };
}
