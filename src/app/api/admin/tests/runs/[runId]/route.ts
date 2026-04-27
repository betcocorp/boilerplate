import { NextResponse } from 'next/server';

import { executeTestRun } from '~/lib/tests/run-executor';
import {
  claimQueuedTestResultForExecution,
  countResultItemsByResultId,
  getTestResultById,
  sumResultItemsElapsedMsByResultId,
  updateTestRecord,
  updateTestResult,
} from '~/lib/tests/repository';

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

function isTerminalStatus(status: string) {
  return (
    status === 'completed' ||
    status === 'completed_with_failures' ||
    status === 'failed' ||
    status === 'cancelled'
  );
}

export async function GET(
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
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
  _request: Request,
  context: { params: Promise<{ runId: string }> },
) {
  const { runId } = await context.params;
  const run = await getTestResultById(runId).catch(() => null);

  if (!run) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 });
  }

  if (
    run.status === 'completed' ||
    run.status === 'completed_with_failures' ||
    run.status === 'failed' ||
    run.status === 'cancelled'
  ) {
    return NextResponse.json({ ok: true, state: 'already_finished' });
  }

  if (run.status === 'queued') {
    const claimed = await claimQueuedTestResultForExecution(run.id);
    if (claimed) {
      void executeTestRun(run.id);
      return NextResponse.json({ ok: true, state: 'started' });
    }
    return NextResponse.json({ ok: true, state: 'already_running' });
  }

  return NextResponse.json({ ok: true, state: 'already_running' });
}

export async function PATCH(
  request: Request,
  context: { params: Promise<{ runId: string }> },
) {
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
    void executeTestRun(run.id);

    return NextResponse.json({ ok: true, state: 'resumed' });
  }

  if (action === 'cancel') {
    if (isTerminalStatus(run.status)) {
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
