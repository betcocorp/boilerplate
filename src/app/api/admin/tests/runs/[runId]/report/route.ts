import { getServerSession } from 'next-auth';
import { NextResponse, after } from 'next/server';

// Scoring every case in a run can take minutes on large gold sets (mirrors the run-execution
// route's own 300s budget); generateReport() checkpoints and returns early well before this.
export const maxDuration = 300;

import { authorizeAdminTestsRoute } from '~/lib/api/admin-tests-auth';
import { authOptions } from '~/lib/auth';
import { logWarn } from '~/lib/observability/logger';
import { gateRoute } from '~/lib/permissions/route-gate';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { generateReport, isLeasedByAnother } from '~/lib/tests/report/orchestrator';
import { scheduleReportGeneration } from '~/lib/tests/report/schedule-report-generation';
import {
  completedPassCount,
  parseReportState,
  totalPassCount,
} from '~/lib/tests/report/schemas';
import { getTestResultById } from '~/lib/tests/repository';
import { isCompletedRunStatus } from '~/lib/tests/types';

function statusPayload(runId: string, run: { report_state: unknown; report_generated_at: string | null }) {
  const state = parseReportState(run.report_state);
  return {
    ok: true,
    runId,
    status: state?.status ?? 'idle',
    totalCases: state?.totalCases ?? 0,
    completedCases: state?.completedCases ?? 0,
    // B0-719 — progress is counted in (case, pass) units so a multi-pass report's bar advances
    // through every pass instead of sitting at 33% until the last one starts.
    passes: state?.passes ?? 1,
    completedPasses: state ? completedPassCount(state) : 0,
    totalPasses: state ? totalPassCount(state) : 0,
    generatedAt: run.report_generated_at,
    error: state?.error ?? null,
  };
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.NAVIGATION_SIDEBAR_TESTS,
    'GET /api/admin/tests/runs/[runId]/report',
  );
  if (denied) return denied;

  const { runId } = await context.params;
  const run = await getTestResultById(runId).catch(() => null);
  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  return NextResponse.json(statusPayload(runId, run));
}

/** B0-943 — `x-bex-report-hop` is advisory; anything unparseable is treated as the first hop. */
function parseHop(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 1_000);
}

/**
 * B0-943 — POST accepts a NextAuth admin session **or** a registry service token, because the
 * background hop chain calls this route on itself with `CRON_SECRET`
 * (`~/lib/tests/report/schedule-report-generation`). GET stays session-only: only the browser
 * polls it.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const denied = await authorizeAdminTestsRoute(
    request,
    'POST /api/admin/tests/runs/[runId]/report',
  );
  if (denied) return denied;

  const { runId } = await context.params;
  const run = await getTestResultById(runId).catch(() => null);
  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  if (!isCompletedRunStatus(run.status)) {
    return NextResponse.json(
      { error: 'Reports can only be generated for completed runs.' },
      { status: 409 },
    );
  }

  /**
   * B0-943 — background mode: answer 202 *before* grading anything, so the invocation that called
   * us (the run executor, or the previous hop, both of which have already spent most of their own
   * 300 s) is released immediately. The grading then runs in `after()` under THIS invocation's
   * fresh budget, and when it comes back still `scoring`/`synthesizing` the next hop is scheduled.
   * `skipIfLeased` keeps the chain from fighting a human who has the report page open.
   */
  if (request.headers.get('x-bex-report-mode') === 'background') {
    const hop = parseHop(request.headers.get('x-bex-report-hop'));

    after(async () => {
      const workerId = crypto.randomUUID();
      try {
        const state = await generateReport(runId, { workerId, skipIfLeased: true });
        // Stood down for someone else's live lease: that worker (an open report page, or another
        // chain) owns continuing this report, so chaining another hop here would only spin the
        // hop budget away while it works.
        if (isLeasedByAnother(state, workerId)) return;
        if (state.status === 'scoring' || state.status === 'synthesizing') {
          await scheduleReportGeneration({ testResultId: runId, hop: hop + 1 });
        }
      } catch (error) {
        logWarn('test_run_report_background_hop_error', {
          testResultId: runId,
          hop,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });

    return NextResponse.json(
      { ok: true, runId, state: 'scheduled', hop },
      { status: 202 },
    );
  }

  const state = await generateReport(runId);
  return NextResponse.json({
    ok: true,
    runId,
    status: state.status,
    totalCases: state.totalCases,
    completedCases: state.completedCases,
    passes: state.passes,
    completedPasses: completedPassCount(state),
    totalPasses: totalPassCount(state),
    error: state.error,
  });
}
