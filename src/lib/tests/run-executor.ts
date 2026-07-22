import {
  getExistingResultItemIds,
  getTestItemsByTestId,
  getTestResultById,
  insertTestResultItems,
  sumResultItemsElapsedMsByResultId,
  updateTestRecord,
  updateTestResult,
} from './repository';
import { runSingleTestItem } from './runner';
import { isTerminalRunStatus } from './types';

function asSummaryObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

export async function executeTestRun(testResultId: string) {
  const testResult = await getTestResultById(testResultId);

  if (isTerminalRunStatus(testResult.status) || testResult.status === 'paused') {
    return;
  }

  const items = await getTestItemsByTestId(testResult.test_id);
  const runOptions = asSummaryObject(testResult.run_options);
  const modelTag =
    typeof runOptions.modelTag === 'string' && runOptions.modelTag.trim()
      ? runOptions.modelTag.trim()
      : undefined;
  // Use per-item existence check rather than an index offset so that retry (which
  // deletes only errored rows) and normal resume both work correctly when there
  // are gaps in the result set.
  const existingItemIds = await getExistingResultItemIds(testResult.id);
  let currentSummary = asSummaryObject(testResult.summary);
  let passedItems = Math.max(0, testResult.passed_items ?? 0);
  let failedItems = Math.max(0, testResult.failed_items ?? 0);
  let completedItems = existingItemIds.size;
  const resumedAt = new Date().toISOString();
  const totalItems = items.length;
  const resumedProgressPercent =
    totalItems > 0 ? Number(((completedItems / totalItems) * 100).toFixed(2)) : 0;
  let itemElapsedSumMs = await sumResultItemsElapsedMsByResultId(testResult.id);

  await updateTestResult(testResult.id, {
    status: 'running',
    elapsed_ms: itemElapsedSumMs,
    summary: {
      ...currentSummary,
      completed_items: completedItems,
      total_items: totalItems,
      progress_percent: resumedProgressPercent,
      runner_state: 'running',
      running_since: resumedAt,
      elapsed_accumulated_ms: itemElapsedSumMs,
    },
  });

  await updateTestRecord(testResult.test_id, {
    status: 'running',
  });

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    // Skip items that already have a result — handles both normal resume and retry.
    if (existingItemIds.has(item.id)) continue;

    const controlRun = await getTestResultById(testResult.id);
    if (controlRun.status === 'paused') {
      const controlSummary = asSummaryObject(controlRun.summary);
      itemElapsedSumMs = await sumResultItemsElapsedMsByResultId(testResult.id);
      await updateTestResult(testResult.id, {
        elapsed_ms: itemElapsedSumMs,
        summary: {
          ...controlSummary,
          runner_state: 'paused',
          running_since: null,
          elapsed_accumulated_ms: itemElapsedSumMs,
        },
      });
      await updateTestRecord(testResult.test_id, {
        status: 'ready',
      });
      return;
    }

    if (controlRun.status === 'cancelled') {
      const controlSummary = asSummaryObject(controlRun.summary);
      itemElapsedSumMs = await sumResultItemsElapsedMsByResultId(testResult.id);
      await updateTestResult(testResult.id, {
        elapsed_ms: itemElapsedSumMs,
        completed_at: new Date().toISOString(),
        summary: {
          ...controlSummary,
          runner_state: 'cancelled',
          running_since: null,
          elapsed_accumulated_ms: itemElapsedSumMs,
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

    const itemResult = await runSingleTestItem(testResult.id, item, { modelTag });
    await insertTestResultItems([itemResult.item]);
    existingItemIds.add(item.id);

    itemElapsedSumMs += itemResult.item.elapsed_ms;

    if (itemResult.passed) {
      passedItems += 1;
    } else {
      failedItems += 1;
    }

    completedItems = existingItemIds.size;
    const progressPercent =
      items.length > 0 ? Number(((completedItems / items.length) * 100).toFixed(2)) : 0;
    const liveRun = await getTestResultById(testResult.id);
    currentSummary = asSummaryObject(liveRun.summary);

    await updateTestResult(testResult.id, {
      passed_items: passedItems,
      failed_items: failedItems,
      elapsed_ms: itemElapsedSumMs,
      summary: {
        ...currentSummary,
        completed_items: completedItems,
        total_items: items.length,
        progress_percent: progressPercent,
        pass_rate: items.length > 0 ? passedItems / items.length : 0,
        runner_state: 'running',
        elapsed_accumulated_ms: itemElapsedSumMs,
      },
    });
  }

  completedItems = existingItemIds.size;
  const finalRun = await getTestResultById(testResult.id);
  const finalSummary = asSummaryObject(finalRun.summary);
  itemElapsedSumMs = await sumResultItemsElapsedMsByResultId(testResult.id);

  await updateTestResult(testResult.id, {
    status: failedItems > 0 ? 'completed_with_failures' : 'completed',
    passed_items: passedItems,
    failed_items: failedItems,
    elapsed_ms: itemElapsedSumMs,
    completed_at: new Date().toISOString(),
    summary: {
      ...finalSummary,
      completed_items: completedItems,
      total_items: items.length,
      progress_percent: 100,
      pass_rate: items.length > 0 ? passedItems / items.length : 0,
      runner_state: 'completed',
      running_since: null,
      elapsed_accumulated_ms: itemElapsedSumMs,
    },
  });

  await updateTestRecord(testResult.test_id, {
    status: 'ready',
  });
}
