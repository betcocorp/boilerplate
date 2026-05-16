import { searchProductChunks } from '~/lib/rag/search';

import {
  countResultItemsByResultId,
  getTestItemsByTestId,
  getTestResultById,
  insertTestResultItems,
  sumResultItemsElapsedMsByResultId,
  updateTestRecord,
  updateTestResult,
} from './repository';
import { isTerminalRunStatus } from './types';

function asSummaryObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export async function executeSearchRun(testResultId: string) {
  const testResult = await getTestResultById(testResultId);

  if (isTerminalRunStatus(testResult.status) || testResult.status === 'paused') {
    return;
  }

  const items = await getTestItemsByTestId(testResult.test_id);
  let currentSummary = asSummaryObject(testResult.summary);
  const completedFromRows = await countResultItemsByResultId(testResult.id);
  let completedItems = Math.max(completedFromRows, 0);
  const totalItems = items.length;
  const resumedAt = new Date().toISOString();
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

  await updateTestRecord(testResult.test_id, { status: 'running' });

  for (let index = completedItems; index < items.length; index += 1) {
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
      await updateTestRecord(testResult.test_id, { status: 'ready' });
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
      await updateTestRecord(testResult.test_id, { status: 'ready' });
      return;
    }

    if (isTerminalRunStatus(controlRun.status)) {
      await updateTestRecord(testResult.test_id, { status: 'ready' });
      return;
    }

    const item = items[index]!;
    const startedAt = Date.now();
    let responsePayload: Record<string, unknown>;
    let passed = false;

    try {
      const result = await searchProductChunks({
        query: item.prompt,
        scope: 'all',
        limit: 10,
      });

      passed = result.matches.length > 0;
      responsePayload = {
        matches: result.matches,
        embeddingSource: result.embeddingSource,
        timings: result.timings,
        query: result.query,
        queryRewritten: result.query !== item.prompt.trim() ? result.query : null,
        model: result.model,
        matchCount: result.matches.length,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Search failed.';
      passed = false;
      responsePayload = { error: message, matchCount: 0 };
    }

    const elapsedMs = Math.max(0, Date.now() - startedAt);
    itemElapsedSumMs += elapsedMs;
    completedItems = index + 1;

    await insertTestResultItems([
      {
        test_result_id: testResult.id,
        test_item_id: item.id,
        row_index: item.row_index,
        elapsed_ms: elapsedMs,
        status: 'completed',
        passed,
        error_message: null,
        response_text: null,
        response_payload: JSON.parse(JSON.stringify(responsePayload)),
      },
    ]);

    const progressPercent =
      items.length > 0 ? Number(((completedItems / items.length) * 100).toFixed(2)) : 0;
    const liveRun = await getTestResultById(testResult.id);
    currentSummary = asSummaryObject(liveRun.summary);

    await updateTestResult(testResult.id, {
      elapsed_ms: itemElapsedSumMs,
      summary: {
        ...currentSummary,
        completed_items: completedItems,
        total_items: items.length,
        progress_percent: progressPercent,
        runner_state: 'running',
        elapsed_accumulated_ms: itemElapsedSumMs,
      },
    });
  }

  const finalRun = await getTestResultById(testResult.id);
  const finalSummary = asSummaryObject(finalRun.summary);
  const completedCount = await countResultItemsByResultId(testResult.id);
  itemElapsedSumMs = await sumResultItemsElapsedMsByResultId(testResult.id);

  await updateTestResult(testResult.id, {
    status: 'completed',
    passed_items: completedCount,
    failed_items: 0,
    elapsed_ms: itemElapsedSumMs,
    completed_at: new Date().toISOString(),
    summary: {
      ...finalSummary,
      completed_items: completedCount,
      total_items: items.length,
      progress_percent: 100,
      runner_state: 'completed',
      running_since: null,
      elapsed_accumulated_ms: itemElapsedSumMs,
    },
  });

  await updateTestRecord(testResult.test_id, { status: 'ready' });
}
