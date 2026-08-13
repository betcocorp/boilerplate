import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

// Scoring every case in a run can take minutes on large gold sets (mirrors the run-execution
// route's own 300s budget); generateReport() checkpoints and returns early well before this.
export const maxDuration = 300;

import { authOptions } from '~/lib/auth';
import { gateRoute } from '~/lib/permissions/route-gate';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { generateReport } from '~/lib/tests/report/orchestrator';
import { parseReportState } from '~/lib/tests/report/schemas';
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

export async function POST(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.NAVIGATION_SIDEBAR_TESTS,
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

  const state = await generateReport(runId);
  return NextResponse.json({
    ok: true,
    runId,
    status: state.status,
    totalCases: state.totalCases,
    completedCases: state.completedCases,
    error: state.error,
  });
}
