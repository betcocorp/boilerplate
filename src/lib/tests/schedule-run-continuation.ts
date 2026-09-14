import { resolveDeploymentProtectionBypass } from '~/lib/api/deployment-protection-bypass';
import { logWarn } from '~/lib/observability/logger';

import { resolveSelfOrigin } from './report/schedule-report-generation';

/**
 * B0-990 — give test-run EXECUTION its own invocation chain, the way B0-943 did for report
 * generation.
 *
 * `executeTestRun` is a sequential per-item loop that runs inside `POST /api/admin/tests/runs/[runId]`
 * under `maxDuration = 300`. At ~15–18 s per item a 20-item golden set lands on that edge and a
 * 26-item set goes over; when the platform kills the invocation the run is left `running` for ever
 * (8 such rows on 2026-09-14, every one with its last item written ~5:00 after creation).
 *
 * The executor now stops itself before the ceiling (`RUN_WALL_CLOCK_BUDGET_MS`), puts the run back
 * to `queued` with `summary.runner_state = 'yielded'`, and the caller fires the next hop: a POST to
 * the same route with `x-bex-run-mode: background`, which claims the queued run, answers 202 at
 * once, and executes the next slice in its own `after()` under a fresh budget. Items already
 * persisted are skipped on resume, so no work is repeated.
 *
 * Same degradation contract as `scheduleReportGeneration`: without `CRON_SECRET` (local dev)
 * nothing is scheduled — and `canScheduleRunContinuation()` is what the executor consults before
 * deciding it may yield at all, so a run that cannot be continued is never left `queued`.
 */

/** Header contract shared with `POST /api/admin/tests/runs/[runId]` and the stalled-run sweeper. */
export const RUN_MODE_HEADER = 'x-bex-run-mode';
export const RUN_HOP_HEADER = 'x-bex-run-hop';
export const RUN_BACKGROUND_MODE = 'background';

/**
 * Hop ceiling for one run's chain. At ~4 minutes of items per hop this is well over two hours of
 * execution — far more than any golden set needs — while still bounding a chain that somehow keeps
 * yielding without making progress.
 */
export const MAX_RUN_HOPS = 40;

export type ScheduleRunContinuationResult = {
  scheduled: boolean;
  reason?: string;
};

/** True when a yielded run can actually be picked up again, i.e. the executor may yield. */
export function canScheduleRunContinuation(): boolean {
  return Boolean(process.env.CRON_SECRET);
}

/**
 * Fires the next hop of a run's execution chain and returns once the callee has accepted it.
 * **Awaiting this is not awaiting the run** — the route answers 202 before executing anything.
 * Never throws.
 */
export async function scheduleRunContinuation({
  testResultId,
  hop,
}: {
  testResultId: string;
  hop: number;
}): Promise<ScheduleRunContinuationResult> {
  if (hop > MAX_RUN_HOPS) {
    logWarn('test_run_continuation_hop_cap_reached', { testResultId, hop, cap: MAX_RUN_HOPS });
    return { scheduled: false, reason: 'hop_cap' };
  }

  const token = process.env.CRON_SECRET;
  if (!token) {
    logWarn('test_run_continuation_skipped_no_token', { testResultId, hop });
    return { scheduled: false, reason: 'no_token' };
  }

  try {
    const origin = await resolveSelfOrigin();
    // B0-966 — a self-call must clear Deployment Protection on its own.
    const bypass = resolveDeploymentProtectionBypass(origin);
    const response = await fetch(`${origin}/api/admin/tests/runs/${testResultId}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        [RUN_MODE_HEADER]: RUN_BACKGROUND_MODE,
        [RUN_HOP_HEADER]: String(hop),
        ...bypass.headers,
      },
    });

    if (!response.ok) {
      logWarn('test_run_continuation_rejected', { testResultId, hop, status: response.status });
      return { scheduled: false, reason: `http_${response.status}` };
    }

    return { scheduled: true };
  } catch (error) {
    logWarn('test_run_continuation_error', {
      testResultId,
      hop,
      message: error instanceof Error ? error.message : String(error),
    });
    return { scheduled: false, reason: 'fetch_failed' };
  }
}
