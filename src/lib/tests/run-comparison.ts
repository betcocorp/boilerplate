/**
 * B0-311 — orchestrates the post-mortem comparison job triggered on run completion
 * (`~/lib/tests/run-executor.ts`), wiring together the B0-313 diff and B0-314 LLM analysis and
 * persisting through the B0-312 repository methods.
 *
 * Split into a synchronous half (`startRunComparison`) and an async half
 * (`runRunComparisonAnalysis`) so the caller can write the 'generating' (or 'no_baseline') row
 * BEFORE scheduling the background job via `after()` — the run-detail page can then show a state on
 * the very next request instead of a blank panel until the job finishes.
 */
import { logWarn } from '~/lib/observability/logger';

import {
  createGeneratingRunComparison,
  createNoBaselineRunComparison,
  getPreviousCompletedTestResult,
  getRunComparisonByResultId,
  getTestResultById,
  listAllResultItemsByResultId,
  saveRunComparisonFailed,
  saveRunComparisonReady,
} from './repository';
import { resolveRunItems } from './resolve-run-items';
import { analyzeRunComparison } from './run-comparison-analysis';
import { computeRunComparisonDiff, type ComparisonResultItem } from './run-comparison-diff';

export type StartRunComparisonResult =
  | { started: true }
  | { started: false; reason: 'already_exists' | 'no_baseline' | 'partial_run' };

/**
 * B0-1110 — persisted on the `no_baseline` row of a partial run (`error_message`) so the run
 * detail page can say why there is no diff. Kept as a plain note on the existing status rather than
 * a new one: `test_result_comparisons_status_check` pins the status set in the database.
 */
export const PARTIAL_RUN_COMPARISON_NOTE =
  'Partial runs are not compared: they re-run only a threshold-filtered subset of the dataset, so a pass-rate diff against a full run would not be like for like.';

/**
 * Idempotent: relies on the `test_result_id` UNIQUE constraint (via
 * `createGeneratingRunComparison`/`createNoBaselineRunComparison`'s plain INSERT) rather than a
 * check-then-insert race, so a retry/re-entry for the same run never enqueues a second job.
 */
export async function startRunComparison(resultId: string): Promise<StartRunComparisonResult> {
  const existing = await getRunComparisonByResultId(resultId);
  if (existing) {
    return { started: false, reason: 'already_exists' };
  }

  const result = await getTestResultById(resultId);

  // B0-1110 — a partial run covers a scoped subset, so it is never diffed against a full run (and
  // never becomes a baseline: `getPreviousCompletedTestResult` is full-only). The `no_baseline`
  // row is still written so the panel renders a state rather than nothing.
  if (result.run_mode === 'partial') {
    const inserted = await createNoBaselineRunComparison(resultId, PARTIAL_RUN_COMPARISON_NOTE);
    return { started: false, reason: inserted.created ? 'partial_run' : 'already_exists' };
  }

  const previous = await getPreviousCompletedTestResult(result.test_id, resultId);

  if (!previous) {
    const inserted = await createNoBaselineRunComparison(resultId);
    return { started: false, reason: inserted.created ? 'no_baseline' : 'already_exists' };
  }

  const created = await createGeneratingRunComparison(resultId, previous.id);
  return created.created ? { started: true } : { started: false, reason: 'already_exists' };
}

/**
 * The async half, run inside `after()`. Re-resolves the previous run id from the persisted
 * 'generating' row (written by `startRunComparison`) rather than trusting a value passed across the
 * `after()` boundary. No-ops if the row is missing or already past 'generating' — defensive against
 * being invoked more than once for the same run.
 */
export async function runRunComparisonAnalysis(resultId: string): Promise<void> {
  const comparison = await getRunComparisonByResultId(resultId);
  if (!comparison || comparison.status !== 'generating' || !comparison.previous_test_result_id) {
    return;
  }
  const previousResultId = comparison.previous_test_result_id;

  try {
    const current = await getTestResultById(resultId);
    const [previous, currentItems, previousItems, testItems] = await Promise.all([
      getTestResultById(previousResultId),
      listAllResultItemsByResultId(resultId),
      listAllResultItemsByResultId(previousResultId),
      resolveRunItems(current),
    ]);

    const promptByTestItemId = new Map(testItems.map((item) => [item.id, item.prompt]));

    const diff = computeRunComparisonDiff({
      currentItems: currentItems as ComparisonResultItem[],
      previousItems: previousItems as ComparisonResultItem[],
      promptByTestItemId,
    });

    const analysisResult = await analyzeRunComparison({
      diff,
      currentNotes: current.notes,
      previousNotes: previous.notes,
    });

    if (!analysisResult.ok) {
      await saveRunComparisonFailed(
        resultId,
        `Comparison analysis output failed validation (${analysisResult.reason}).`,
      );
      return;
    }

    const causeFixByTestItemId = new Map(
      analysisResult.analysis.failures.map((failure) => [failure.testItemId, failure]),
    );

    const newFailures = diff.newFailures.map((failure) => {
      const analyzed = causeFixByTestItemId.get(failure.testItemId);
      return {
        ...failure,
        cause: analyzed?.cause ?? 'Not analyzed — exceeded the per-run analysis limit.',
        fix: analyzed?.fix ?? 'Not analyzed — exceeded the per-run analysis limit.',
      };
    });

    await saveRunComparisonReady(resultId, {
      verdict: analysisResult.analysis.verdict,
      verdictSummary: analysisResult.analysis.verdictSummary,
      currentPassRate: diff.currentPassRate,
      previousPassRate: diff.previousPassRate,
      scoreDelta: diff.scoreDelta,
      newFailures,
      fixes: diff.fixes,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await saveRunComparisonFailed(resultId, message);
    } catch (persistError) {
      logWarn('test_run_comparison_persist_failed_error', {
        testResultId: resultId,
        message: persistError instanceof Error ? persistError.message : String(persistError),
      });
    }
  }
}
