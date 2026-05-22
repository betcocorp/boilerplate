import { searchProductChunks, type RagSearchMatch } from '~/lib/rag/search';

import {
  computeAvgSimilarityForResult,
  countPassedAndFailedByResultId,
  countResultItemsByResultId,
  getTestItemsByTestId,
  getTestResultById,
  insertTestResultItems,
  sumResultItemsElapsedMsByResultId,
  updateTestRecord,
  updateTestResult,
} from './repository';
import { isTerminalRunStatus, type TestItemRecord } from './types';

/** Similarity floor below which a match is not considered relevant for negative-test evaluation. */
const NEGATIVE_SIMILARITY_CAP = 0.45;

/**
 * Gold eval pass/fail logic:
 * - Negative test (expected_should_answer = false): pass if no match exceeds the similarity cap.
 * - Positive test with expected_canonical_product and/or expected_result_type: pass if at least
 *   one match satisfies BOTH constraints in the same chunk.
 * - Positive test with no constraints: pass if any result was returned.
 */
function evaluateSearchPass(matches: RagSearchMatch[], item: TestItemRecord): boolean {
  if (item.expected_should_answer === false) {
    return !matches.some((m) => m.similarity >= NEGATIVE_SIMILARITY_CAP);
  }

  const expectedKey =
    typeof item.expected_canonical_product === 'string' && item.expected_canonical_product.trim()
      ? item.expected_canonical_product.trim().toLowerCase()
      : null;

  const expectedSection =
    typeof item.expected_result_type === 'string' && item.expected_result_type.trim()
      ? item.expected_result_type.trim()
      : null;

  if (!expectedKey && !expectedSection) {
    return matches.length > 0;
  }

  return matches.some((m) => {
    const keyMatch = !expectedKey || (m.product_line_key?.toLowerCase() ?? '') === expectedKey;
    const sectionMatch = !expectedSection || m.section_type === expectedSection;
    return keyMatch && sectionMatch;
  });
}

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

  const runOpts = (testResult.run_options as Record<string, unknown>) ?? {};
  const useHybrid = runOpts['useHybrid'] === true;
  const useReranker = runOpts['useReranker'] === true;
  const useMultiIntent = runOpts['useMultiIntent'] === true;
  const runRetrievalStrategy =
    useHybrid && useReranker ? 'hybrid+reranked'
    : useHybrid              ? 'hybrid'
    : useReranker            ? 'vector+reranked'
    :                          'vector';

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
        useHybrid,
        useReranker,
        useMultiIntent,
      });

      passed = evaluateSearchPass(result.matches, item);
      responsePayload = {
        matches: result.matches,
        embeddingSource: result.embeddingSource,
        retrieval_strategy: result.retrieval_strategy,
        rerankMs: result.timings.rerankMs,
        timings: result.timings,
        query: result.query,
        queryRewritten: result.query !== item.prompt.trim() ? result.query : null,
        model: result.model,
        matchCount: result.matches.length,
        passReason: passed
          ? (item.expected_should_answer === false ? 'no_relevant_match_above_cap' : 'constraint_satisfied')
          : (item.expected_should_answer === false ? 'unexpected_relevant_match' : 'constraint_not_satisfied'),
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
  const { passed: passedCount, failed: failedCount } = await countPassedAndFailedByResultId(testResult.id);
  itemElapsedSumMs = await sumResultItemsElapsedMsByResultId(testResult.id);
  const avgSimilarity = await computeAvgSimilarityForResult(testResult.id);

  await updateTestResult(testResult.id, {
    status: 'completed',
    passed_items: passedCount,
    failed_items: failedCount,
    elapsed_ms: itemElapsedSumMs,
    completed_at: new Date().toISOString(),
    avg_similarity: avgSimilarity,
    retrieval_strategy: runRetrievalStrategy,
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
