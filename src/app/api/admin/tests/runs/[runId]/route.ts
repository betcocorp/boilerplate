import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

// Allow up to 5 minutes — sequential search evals over large gold sets
// can take 60–120 s, which exceeds the default Vercel function timeout.
export const maxDuration = 300;

import { authorizeAdminTestsRoute } from '~/lib/api/admin-tests-auth';
// PATCH stays session-only: pausing/resuming a run is a UI action, not something the CI gate does.
import { authOptions } from '~/lib/auth';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';
import {
  claimAndExecuteQueuedRun,
  executeQueuedTestRun,
} from '~/lib/tests/execute-queued-run';
import { executeSearchRun } from '~/lib/tests/search-run-executor';
import { executeTestRun } from '~/lib/tests/run-executor';
import {
  countPassedAndFailedByResultId,
  countResultItemsByResultId,
  deleteErroredResultItems,
  getTestResultById,
  sumResultItemsElapsedMsByResultId,
  updateTestRecord,
  updateTestResult,
} from '~/lib/tests/repository';
import { isTerminalRunStatus } from '~/lib/tests/types';

function readProgressFromSummary(summary: unknown) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return {
      completedItems: null as number | null,
      totalItems: null as number | null,
      progressPercent: null as number | null,
      runnerState: null as string | null,
    };
  }

  const data = summary as Record<string, unknown>;
  return {
    completedItems:
      typeof data.completed_items === 'number' ? data.completed_items : null,
    totalItems: typeof data.total_items === 'number' ? data.total_items : null,
    progressPercent:
      typeof data.progress_percent === 'number' ? data.progress_percent : null,
    runnerState: typeof data.runner_state === 'string' ? data.runner_state : null,
    elapsedAccumulatedMs:
      typeof data.elapsed_accumulated_ms === 'number' ? data.elapsed_accumulated_ms : null,
    runningSince: typeof data.running_since === 'string' ? data.running_since : null,
  };
}

export async function GET(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  // B0-465 — session OR CI service token, so the eval gate can start and poll its own run.
  const denied = await authorizeAdminTestsRoute(
    request,
    'GET /api/admin/tests/runs/[runId]',
  );
  if (denied) return denied;

  const { runId } = await context.params;
  const run = await getTestResultById(runId).catch(() => null);

  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  const summaryProgress = readProgressFromSummary(run.summary);
  const completedFromRows = await countResultItemsByResultId(run.id);
  const totalItems = summaryProgress.totalItems ?? run.total_items ?? 0;
  const completedFromSummary = summaryProgress.completedItems ?? 0;
  const completedItemsRaw = Math.max(completedFromSummary, completedFromRows);
  const completedItems =
    totalItems > 0 ? Math.min(totalItems, completedItemsRaw) : completedItemsRaw;
  const passedItems = typeof run.passed_items === 'number' ? run.passed_items : 0;
  const failedItems =
    typeof run.failed_items === 'number'
      ? run.failed_items
      : Math.max(0, completedItems - passedItems);
  const notRunItems = Math.max(0, totalItems - completedItems);
  const derivedStatus =
    (run.status === 'queued' || run.status === 'running') &&
    totalItems > 0 &&
    completedItems >= totalItems
      ? failedItems > 0
        ? 'completed_with_failures'
        : 'completed'
      : run.status;
  const percent =
    totalItems > 0
      ? Number(((completedItems / totalItems) * 100).toFixed(2))
      : summaryProgress.progressPercent ?? 0;
  const elapsedMs = await sumResultItemsElapsedMsByResultId(run.id);

  return NextResponse.json({
    ok: true,
    runId: run.id,
    status: derivedStatus,
    completedItems,
    totalItems,
    progressPercent: percent,
    elapsedMs,
    passedItems,
    failedItems,
    notRunItems,
  });
}

export async function POST(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  // B0-465 — session OR CI service token, so the eval gate can start and poll its own run.
  const denied = await authorizeAdminTestsRoute(
    request,
    'POST /api/admin/tests/runs/[runId]',
  );
  if (denied) return denied;

  const { runId } = await context.params;
  // B0-883 — load/terminal-check/claim/dispatch lives in `executeQueuedTestRun` so the "Run Golden"
  // fan-out executes runs through exactly the same path as this handler.
  const { state } = await executeQueuedTestRun(runId);

  if (state === 'not_found') {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  return NextResponse.json({ ok: true, state });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.NAVIGATION_SIDEBAR_TESTS,
    'PATCH /api/admin/tests/runs/[runId]',
  );
  if (denied) return denied;

  const { runId } = await context.params;
  const body = (await request.json().catch(() => ({}))) as { action?: unknown };
  const action = typeof body.action === 'string' ? body.action : '';
  const run = await getTestResultById(runId).catch(() => null);

  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  const summary = readProgressFromSummary(run.summary);
  const elapsedMs = await sumResultItemsElapsedMsByResultId(run.id);

  if (action === 'pause') {
    if (run.status !== 'running') {
      return NextResponse.json({ error: 'Only running runs can be paused.' }, { status: 409 });
    }

    await updateTestResult(run.id, {
      status: 'paused',
      elapsed_ms: elapsedMs,
      summary: {
        ...(run.summary as Record<string, unknown>),
        runner_state: 'paused',
        running_since: null,
        elapsed_accumulated_ms: elapsedMs,
      },
    });
    await updateTestRecord(run.test_id, { status: 'ready' });

    return NextResponse.json({ ok: true, state: 'paused' });
  }

  if (action === 'resume') {
    if (run.status !== 'paused') {
      return NextResponse.json({ error: 'Only paused runs can be resumed.' }, { status: 409 });
    }

    const resumedAt = new Date().toISOString();
    await updateTestResult(run.id, {
      status: 'running',
      summary: {
        ...(run.summary as Record<string, unknown>),
        runner_state: 'running',
        running_since: resumedAt,
        elapsed_accumulated_ms: summary.elapsedAccumulatedMs ?? run.elapsed_ms ?? 0,
      },
    });
    await updateTestRecord(run.test_id, { status: 'running' });
    if (run.run_mode === 'search') {
      await executeSearchRun(run.id);
    } else {
      await executeTestRun(run.id);
    }

    return NextResponse.json({ ok: true, state: 'resumed' });
  }

  if (action === 'restart') {
    if (run.status !== 'running') {
      return NextResponse.json({ error: 'Only stalled running runs can be restarted.' }, { status: 409 });
    }

    const completedFromRows = await countResultItemsByResultId(run.id);
    if (completedFromRows > 0 || (run.passed_items ?? 0) > 0 || (run.failed_items ?? 0) > 0) {
      return NextResponse.json(
        { error: 'Run has already processed items; use cancel then create a new run.' },
        { status: 409 },
      );
    }

    const currentSummary =
      run.summary && typeof run.summary === 'object' && !Array.isArray(run.summary)
        ? (run.summary as Record<string, unknown>)
        : {};

    await updateTestResult(run.id, {
      status: 'queued',
      passed_items: 0,
      failed_items: 0,
      elapsed_ms: 0,
      summary: { ...currentSummary, runner_state: 'queued', completed_items: 0 },
    });
    await updateTestRecord(run.test_id, { status: 'ready' });

    const claimed = await claimAndExecuteQueuedRun(run);
    if (claimed) {
      return NextResponse.json({ ok: true, state: 'restarted' });
    }
    return NextResponse.json({ ok: true, state: 'queued_for_restart' });
  }

  if (action === 'retry_failed') {
    if (run.status === 'running' || run.status === 'queued') {
      return NextResponse.json(
        { error: 'Cannot retry while run is actively running or queued. Pause or cancel first.' },
        { status: 409 },
      );
    }

    const deleted = await deleteErroredResultItems(run.id);
    if (deleted === 0) {
      return NextResponse.json({ ok: true, state: 'no_errored_items' });
    }

    const { passed: newPassed, failed: newFailed } = await countPassedAndFailedByResultId(run.id);
    const currentSummary =
      run.summary && typeof run.summary === 'object' && !Array.isArray(run.summary)
        ? (run.summary as Record<string, unknown>)
        : {};

    await updateTestResult(run.id, {
      status: 'queued',
      passed_items: newPassed,
      failed_items: newFailed,
      completed_at: null,
      summary: {
        ...currentSummary,
        runner_state: 'queued',
        completed_items: newPassed + newFailed,
        running_since: null,
      },
    });
    await updateTestRecord(run.test_id, { status: 'ready' });

    const claimed = await claimAndExecuteQueuedRun(run);
    if (claimed) {
      return NextResponse.json({ ok: true, state: 'retrying_failed' });
    }
    return NextResponse.json({ ok: true, state: 'queued_for_retry' });
  }

  if (action === 'cancel') {
    if (isTerminalRunStatus(run.status)) {
      return NextResponse.json({ ok: true, state: 'already_finished' });
    }

    await updateTestResult(run.id, {
      status: 'cancelled',
      elapsed_ms: elapsedMs,
      completed_at: new Date().toISOString(),
      summary: {
        ...(run.summary as Record<string, unknown>),
        runner_state: 'cancelled',
        running_since: null,
        elapsed_accumulated_ms: elapsedMs,
      },
    });
    await updateTestRecord(run.test_id, { status: 'ready' });

    return NextResponse.json({ ok: true, state: 'cancelled' });
  }

  return NextResponse.json(
    { error: "Invalid action. Expected 'pause', 'resume', or 'cancel'." },
    { status: 400 },
  );
}
