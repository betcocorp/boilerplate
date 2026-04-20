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

export async function executeTestRun(testResultId: string) {
  const testResult = await getTestResultById(testResultId);

  if (
    testResult.status === 'completed' ||
    testResult.status === 'completed_with_failures' ||
    testResult.status === 'failed'
  ) {
    return;
  }

  const items = await getTestItemsByTestId(testResult.test_id);
  const initialSummary = asSummaryObject(testResult.summary);

  await updateTestResult(testResult.id, {
    status: 'running',
    summary: {
      ...initialSummary,
      completed_items: 0,
      total_items: items.length,
      progress_percent: 0,
      runner_state: 'running',
    },
  });

  let passedItems = 0;
  let failedItems = 0;
  const startedAtMs = Date.now();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const itemResult = await runSingleTestItem(testResult.id, item);
    await insertTestResultItems([itemResult.item]);

    if (itemResult.passed) {
      passedItems += 1;
    } else {
      failedItems += 1;
    }

    const completedItems = index + 1;
    const progressPercent =
      items.length > 0 ? Number(((completedItems / items.length) * 100).toFixed(2)) : 0;

    await updateTestResult(testResult.id, {
      passed_items: passedItems,
      failed_items: failedItems,
      summary: {
        ...initialSummary,
        completed_items: completedItems,
        total_items: items.length,
        progress_percent: progressPercent,
        pass_rate: items.length > 0 ? passedItems / items.length : 0,
        runner_state: 'running',
      },
    });
  }

  const completedItems = await countResultItemsByResultId(testResult.id);
  const elapsedMs = Math.max(0, Date.now() - startedAtMs);

  await updateTestResult(testResult.id, {
    status: failedItems > 0 ? 'completed_with_failures' : 'completed',
    passed_items: passedItems,
    failed_items: failedItems,
    elapsed_ms: elapsedMs,
    completed_at: new Date().toISOString(),
    summary: {
      ...initialSummary,
      completed_items: completedItems,
      total_items: items.length,
      progress_percent: 100,
      pass_rate: items.length > 0 ? passedItems / items.length : 0,
      runner_state: 'completed',
    },
  });

  await updateTestRecord(testResult.test_id, {
    status: 'ready',
  });
}
