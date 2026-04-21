import {
  countResultItemsByResultId,
  getTestItemsByTestId,
  getTestResultById,
  insertTestResultItems,
  updateTestRecord,
  updateTestResult,
} from './repository';
import { runSingleTestItem } from './runner';

function asSummaryObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function readElapsedSummary(summary: Record<string, unknown>) {
  return {
    elapsedAccumulatedMs: readNumber(summary.elapsed_accumulated_ms, 0),
    runningSince: readString(summary.running_since),
  };
}

function elapsedForLiveRun(summary: Record<string, unknown>) {
  const elapsed = readElapsedSummary(summary);
  if (!elapsed.runningSince) {
    return elapsed.elapsedAccumulatedMs;
  }

  const runningSinceMs = new Date(elapsed.runningSince).getTime();
  if (!Number.isFinite(runningSinceMs)) {
    return elapsed.elapsedAccumulatedMs;
  }

  return Math.max(0, elapsed.elapsedAccumulatedMs + (Date.now() - runningSinceMs));
}

function isTerminalRunStatus(status: string) {
  return (
    status === 'completed' ||
    status === 'completed_with_failures' ||
    status === 'failed' ||
    status === 'cancelled'
  );
}

export async function executeTestRun(testResultId: string) {
  const testResult = await getTestResultById(testResultId);

  if (isTerminalRunStatus(testResult.status) || testResult.status === 'paused') {
    return;
  }

  const items = await getTestItemsByTestId(testResult.test_id);
  let currentSummary = asSummaryObject(testResult.summary);
  const completedFromRows = await countResultItemsByResultId(testResult.id);
  let passedItems = Math.max(0, testResult.passed_items ?? 0);
  let failedItems = Math.max(0, testResult.failed_items ?? 0);
  let completedItems = Math.max(completedFromRows, passedItems + failedItems);
  const resumedAt = new Date().toISOString();
  const totalItems = items.length;
  const resumedProgressPercent =
    totalItems > 0 ? Number(((completedItems / totalItems) * 100).toFixed(2)) : 0;
  const priorElapsed = readElapsedSummary(currentSummary).elapsedAccumulatedMs;

  await updateTestResult(testResult.id, {
    status: 'running',
    summary: {
      ...currentSummary,
      completed_items: completedItems,
      total_items: totalItems,
      progress_percent: resumedProgressPercent,
      runner_state: 'running',
      running_since: resumedAt,
      elapsed_accumulated_ms: priorElapsed,
    },
  });

  await updateTestRecord(testResult.test_id, {
    status: 'running',
  });

  for (let index = completedItems; index < items.length; index += 1) {
    const controlRun = await getTestResultById(testResult.id);
    if (controlRun.status === 'paused') {
      const controlSummary = asSummaryObject(controlRun.summary);
      const pausedElapsedMs = elapsedForLiveRun(controlSummary);
      await updateTestResult(testResult.id, {
        elapsed_ms: pausedElapsedMs,
        summary: {
          ...controlSummary,
          runner_state: 'paused',
          running_since: null,
          elapsed_accumulated_ms: pausedElapsedMs,
        },
      });
      await updateTestRecord(testResult.test_id, {
        status: 'ready',
      });
      return;
    }

    if (controlRun.status === 'cancelled') {
      const controlSummary = asSummaryObject(controlRun.summary);
      const cancelledElapsedMs = elapsedForLiveRun(controlSummary);
      await updateTestResult(testResult.id, {
        elapsed_ms: cancelledElapsedMs,
        completed_at: new Date().toISOString(),
        summary: {
          ...controlSummary,
          runner_state: 'cancelled',
          running_since: null,
          elapsed_accumulated_ms: cancelledElapsedMs,
        },
      });
      await updateTestRecord(testResult.test_id, {
        status: 'ready',
      });
      return;
    }

    if (isTerminalRunStatus(controlRun.status)) {
      await updateTestRecord(testResult.test_id, {
        status: 'ready',
      });
      return;
    }

    const item = items[index];
    const itemResult = await runSingleTestItem(testResult.id, item);
    await insertTestResultItems([itemResult.item]);

    if (itemResult.passed) {
      passedItems += 1;
    } else {
      failedItems += 1;
    }

    completedItems = index + 1;
    const progressPercent =
      items.length > 0 ? Number(((completedItems / items.length) * 100).toFixed(2)) : 0;
    const liveRun = await getTestResultById(testResult.id);
    currentSummary = asSummaryObject(liveRun.summary);
    const liveElapsedMs = elapsedForLiveRun(currentSummary);

    await updateTestResult(testResult.id, {
      passed_items: passedItems,
      failed_items: failedItems,
      elapsed_ms: liveElapsedMs,
      summary: {
        ...currentSummary,
        completed_items: completedItems,
        total_items: items.length,
        progress_percent: progressPercent,
        pass_rate: items.length > 0 ? passedItems / items.length : 0,
        runner_state: 'running',
        elapsed_accumulated_ms: liveElapsedMs,
      },
    });
  }

  completedItems = await countResultItemsByResultId(testResult.id);
  const finalRun = await getTestResultById(testResult.id);
  const finalSummary = asSummaryObject(finalRun.summary);
  const elapsedMs = elapsedForLiveRun(finalSummary);

  await updateTestResult(testResult.id, {
    status: failedItems > 0 ? 'completed_with_failures' : 'completed',
    passed_items: passedItems,
    failed_items: failedItems,
    elapsed_ms: elapsedMs,
    completed_at: new Date().toISOString(),
    summary: {
      ...finalSummary,
      completed_items: completedItems,
      total_items: items.length,
      progress_percent: 100,
      pass_rate: items.length > 0 ? passedItems / items.length : 0,
      runner_state: 'completed',
      running_since: null,
      elapsed_accumulated_ms: elapsedMs,
    },
  });

  await updateTestRecord(testResult.test_id, {
    status: 'ready',
  });
}
