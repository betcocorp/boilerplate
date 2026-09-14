import { APP_VERSION } from '~/lib/app-version';
import { searchProductChunks, type RagSearchMatch } from '~/lib/rag/search';

import { analyzeAndPersistFailureRootCause } from './failure-root-cause';
import { mandatoryConceptPhrases } from './grading';
import {
  computeAvgSimilarityForResult,
  countPassedAndFailedByResultId,
  getExistingResultItemIds,
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  insertTestResultItems,
  sumResultItemsElapsedMsByResultId,
  updateTestRecord,
  updateTestResult,
} from './repository';
import { isTerminalRunStatus, type TestItemRecord } from './types';

/**
 * Retrieval eval pass/fail logic.
 *
 * B0-932 — the two behaviour columns this used to branch on are gone from `test_items`:
 *
 *  - `expected_should_answer = false` selected a NEGATIVE retrieval test ("nothing relevant should
 *    come back above the similarity cap"). There is no replacement signal on the row — a search
 *    run has no answer text, so mandatory concept coverage, the new chat pass axis, cannot stand
 *    in for it. The branch is therefore removed rather than reconstructed from
 *    `metadata.legacy_expected_should_answer`, which would be resurrecting a dropped column
 *    through a side door. Any negative retrieval row now grades as an ordinary positive one.
 *  - `expected_result_type` constrained the matched chunk's `section_type` (16 rows repo-wide).
 *    Removed for the same reason.
 *
 * What remains:
 * - `expected_canonical_products` non-empty (B0-993): pass only when EVERY listed product line
 *   has at least one match — a prompt about two products expects retrieval to cover both. A
 *   single-value row therefore grades exactly as it did when the column was scalar.
 * - no constraint: pass if any result was returned.
 */
function evaluateSearchPass(matches: RagSearchMatch[], item: TestItemRecord): boolean {
  const expectedKeys = [
    ...new Set(
      (item.expected_canonical_products ?? [])
        .map((key) => key.trim().toLowerCase())
        .filter((key) => key !== ''),
    ),
  ];

  if (expectedKeys.length === 0) {
    return matches.length > 0;
  }

  const matchedKeys = new Set(
    matches.map((m) => m.product_line_key?.toLowerCase() ?? '').filter((key) => key !== ''),
  );
  return expectedKeys.every((key) => matchedKeys.has(key));
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
  // B0-617 — fetched once per run, purely for the root-cause analyzer's context (same pattern
  // as run-executor.ts's `test` fetch); never influences search grading itself.
  const test = await getTestById(testResult.test_id);
  const existingItemIds = await getExistingResultItemIds(testResult.id);
  let currentSummary = asSummaryObject(testResult.summary);
  let completedItems = existingItemIds.size;
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

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;

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
        passReason: passed ? 'constraint_satisfied' : 'constraint_not_satisfied',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Search failed.';
      passed = false;
      responsePayload = { error: message, matchCount: 0 };
    }

    const elapsedMs = Math.max(0, Date.now() - startedAt);
    itemElapsedSumMs += elapsedMs;

    const [insertedItem] = await insertTestResultItems([
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
        app_version: APP_VERSION,
      },
    ]);

    // B0-617 — same auto root-cause call as the chat-eval runner (run-executor.ts), so
    // search/retrieval-eval failures land in the failure queue with a generated cause too.
    if (!passed && insertedItem) {
      const matches = Array.isArray((responsePayload as { matches?: unknown }).matches)
        ? ((responsePayload as { matches: RagSearchMatch[] }).matches)
        : [];
      const similarities = matches.map((m) => m.similarity).filter((s): s is number => typeof s === 'number');
      await analyzeAndPersistFailureRootCause({
        testResultItemId: insertedItem.id,
        testName: test.name,
        prompt: item.prompt,
        mandatoryConcepts: mandatoryConceptPhrases(item),
        responseText: null,
        errorMessage:
          typeof (responsePayload as { error?: unknown }).error === 'string'
            ? ((responsePayload as { error: string }).error)
            : null,
        retrieval: {
          similarityMin: similarities.length > 0 ? Math.min(...similarities) : null,
          similarityMax: similarities.length > 0 ? Math.max(...similarities) : null,
          matchCount: matches.length,
        },
      });
    }

    existingItemIds.add(item.id);
    completedItems = existingItemIds.size;
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
  const completedCount = existingItemIds.size;
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
