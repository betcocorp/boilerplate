import { resolveDeploymentProtectionBypass } from '~/lib/api/deployment-protection-bypass';
import { logWarn } from '~/lib/observability/logger';

/**
 * B0-943 — give eval report generation its OWN invocation chain.
 *
 * ## Why self-HTTP rather than an in-process loop
 *
 * `generateReport` is a single slice: it grades for at most `WALL_CLOCK_BUDGET_MS` (260 s),
 * checkpoints `report_state`, and returns with `status: 'scoring'` expecting to be called again.
 * With `REPORT_GRADING_PASSES = 3` on `claude-opus-5` at `high` effort, a 20–26 item run needs
 * three or four of those slices (measured: 777 s of grading for a 20-item run).
 *
 * The old B0-608 wiring scheduled the first slice in an `after()` callback belonging to
 * `POST /api/admin/tests/runs/[runId]` — the SAME invocation that had just spent 170–350 s
 * executing the run itself under a `maxDuration = 300`. That callback inherited whatever was left
 * of those 300 s, i.e. usually nothing, and was killed. Nothing then re-invoked the orchestrator
 * except the report page's own auto-continue POSTs, so unattended reports never finished: 24 of
 * 154 completed runs in a 30-day window had no report at all.
 *
 * Looping in-process cannot fix that, because the budget is a property of the *invocation*, not of
 * the loop — a `while` around `generateReport` inside an exhausted invocation dies exactly as fast
 * as one call does. A fresh HTTP request to ourselves is the only way to obtain more budget: each
 * hop is a new serverless invocation with its own full `maxDuration = 300`, and the report route
 * answers `202` immediately (doing the grading in its own `after()`), so the caller's invocation is
 * released the moment the request is accepted rather than waiting on the work.
 *
 * The chain is therefore: run executor → hop 1 → (report route grades one slice) → hop 2 → … until
 * the state reaches `completed`/`failed` or {@link MAX_REPORT_HOPS} is hit.
 *
 * Degrades silently by design: without `CRON_SECRET` (local dev) nothing is scheduled and the
 * report page's auto-continue still covers the interactive case. This function never throws.
 */

/**
 * Hop ceiling for one report's chain. At ~260 s of grading per hop this is ~43 minutes, comfortably
 * more than the three or four slices a real report needs, while still bounding a chain that somehow
 * fails to converge (e.g. a state that keeps returning `scoring` without making progress).
 */
export const MAX_REPORT_HOPS = 10;

export type ScheduleReportGenerationResult = {
  scheduled: boolean;
  reason?: string;
};

/**
 * Same origin-resolution idiom as `resolveServerEventsLogUrl` in `~/lib/event-logging/log-event`:
 * prefer the forwarded host of the request we are already serving, fall back to configured origins,
 * and finally to loopback. Kept here on purpose — `log-event.ts` is not ours to widen. Exported for
 * `~/lib/tests/schedule-run-continuation` (B0-990), which hops the same way.
 */
export async function resolveSelfOrigin(): Promise<string> {
  try {
    const { headers } = await import('next/headers');
    const h = await headers();
    const host = h.get('x-forwarded-host') ?? h.get('host');
    if (host) {
      const proto =
        h.get('x-forwarded-proto') ??
        (process.env.NODE_ENV === 'production' ? 'https' : 'http');
      return `${proto}://${host}`;
    }
  } catch {
    // No request scope (e.g. instrumentation) or unsupported runtime.
  }

  return (
    process.env.NEXTAUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    'http://127.0.0.1:3000'
  ).replace(/\/$/, '');
}

/**
 * Fires the next hop of a report's generation chain and returns as soon as the callee has accepted
 * it. **Awaiting this is not awaiting the report** — the report route answers `202` before doing
 * any grading (see `POST /api/admin/tests/runs/[runId]/report`).
 */
export async function scheduleReportGeneration({
  testResultId,
  hop,
}: {
  testResultId: string;
  hop: number;
}): Promise<ScheduleReportGenerationResult> {
  if (hop > MAX_REPORT_HOPS) {
    logWarn('test_run_report_hop_cap_reached', { testResultId, hop, cap: MAX_REPORT_HOPS });
    return { scheduled: false, reason: 'hop_cap' };
  }

  /**
   * A real provisioned registry API token (`bex_<env>_…`) authorized for `/api/admin/tests/runs*`,
   * not a shared secret — see the header comment on
   * `src/app/api/v1/observability/run-golden-test-sweep/route.ts`. Absent locally, which is fine:
   * the report page's auto-continue still drives generation for anyone with the page open.
   */
  const token = process.env.CRON_SECRET;
  if (!token) {
    logWarn('test_run_report_schedule_skipped_no_token', { testResultId, hop });
    return { scheduled: false, reason: 'no_token' };
  }

  try {
    const origin = await resolveSelfOrigin();
    // B0-966/B0-990 — a self-call into our own deployment has to clear Vercel Deployment
    // Protection on its own; the cron sweeps already did, this direct hop did not, so on a
    // protected deployment the first hop 401'd and only the 10-minute sweep ever re-armed it.
    const bypass = resolveDeploymentProtectionBypass(origin);
    const response = await fetch(
      `${origin}/api/admin/tests/runs/${testResultId}/report`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-bex-report-mode': 'background',
          'x-bex-report-hop': String(hop),
          ...bypass.headers,
        },
      },
    );

    if (!response.ok) {
      logWarn('test_run_report_schedule_rejected', {
        testResultId,
        hop,
        status: response.status,
      });
      return { scheduled: false, reason: `http_${response.status}` };
    }

    return { scheduled: true };
  } catch (error) {
    logWarn('test_run_report_schedule_error', {
      testResultId,
      hop,
      message: error instanceof Error ? error.message : String(error),
    });
    return { scheduled: false, reason: 'fetch_failed' };
  }
}
