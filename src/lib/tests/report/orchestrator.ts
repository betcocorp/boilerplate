import { resolveResponsesModel } from '~/lib/openai/client';
import {
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
  saveReportMarkdown,
  saveReportState,
} from '~/lib/tests/repository';
import type { TestItemRecord, TestResultItemRecord } from '~/lib/tests/types';

import { assembleReportCases, indexLatestResultItems } from './assemble';
import { scoreCase } from './case-scorer';
import { renderReportMarkdown } from './render';
import { emptyReportState, parseReportState, type CaseScore, type ReportState } from './schemas';
import { synthesizeReportFindings } from './synthesizer';

const MODEL_TAG = 'gpt-4.1';
const BATCH_SIZE = 5;
/** Leaves headroom under the route's `maxDuration = 300` for the final save + response. */
const WALL_CLOCK_BUDGET_MS = 260_000;

function noResponseScore(reason: string): CaseScore {
  return {
    unableToEvaluate: true,
    uteReason: reason,
    accuracy: null,
    completeness: null,
    relevance: null,
    clarity: null,
    explanation: '',
    missed: '',
    incorrect: '',
    improvement: '',
  };
}

async function scoreRemainingCases(
  resultId: string,
  items: TestItemRecord[],
  resultItemByTestItemId: Map<string, TestResultItemRecord>,
  state: ReportState,
  deadline: number,
): Promise<ReportState> {
  const pending = items.filter((item) => !(item.id in state.caseScores));

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    if (Date.now() >= deadline) break;

    const batch = pending.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (item) => {
        const resultItem = resultItemByTestItemId.get(item.id);
        const responseText = resultItem?.response_text?.trim();
        if (!resultItem) {
          return [item.id, noResponseScore('No result recorded for this item in this run.')] as const;
        }
        if (!responseText) {
          const reason = resultItem.error_message
            ? `No response text recorded; harness error: ${resultItem.error_message}`
            : 'No response text recorded for this item in this run.';
          return [item.id, noResponseScore(reason)] as const;
        }
        const score = await scoreCase({
          question: item.prompt,
          category: item.prompt_category,
          priorityRaw: item.priority,
          idealResponse: item.ideal_response,
          expectedConcepts: item.expected_concepts,
          minimumConcepts: item.minimum_concepts,
          expectedSources: item.expected_sources,
          expectedShouldAnswer: item.expected_should_answer,
          actualResponseText: responseText,
          modelTag: MODEL_TAG,
        });
        return [item.id, score] as const;
      }),
    );

    for (const [itemId, score] of results) {
      state.caseScores[itemId] = score;
    }
    state.completedCases = Object.keys(state.caseScores).length;
    state.updatedAt = new Date().toISOString();
    await saveReportState(resultId, state);
  }

  return state;
}

/**
 * Generates (or resumes) the LLM-graded eval report for a run (B0-453). Scores every case in
 * bounded-concurrency batches, checkpointing `report_state` after each batch so a large run
 * (200+ items) that can't finish inside one request's time budget picks up where it left off on
 * the next call instead of restarting. Once every case is scored, synthesizes the Top-3
 * recommendations and renders the final Markdown report.
 */
export async function generateReport(testResultId: string): Promise<ReportState> {
  const deadline = Date.now() + WALL_CLOCK_BUDGET_MS;
  const run = await getTestResultById(testResultId);
  const test = await getTestById(run.test_id);
  const [items, resultItems] = await Promise.all([
    getTestItemsByTestId(run.test_id),
    listAllResultItemsByResultId(run.id),
  ]);

  const resultItemByTestItemId = indexLatestResultItems(resultItems);

  const model = resolveResponsesModel(MODEL_TAG);
  let state = parseReportState(run.report_state) ?? emptyReportState(model, items.length);
  if (state.totalCases !== items.length) {
    // The run's item set changed (e.g. items added) since a prior partial report — start fresh.
    state = emptyReportState(model, items.length);
  }
  state.status = 'scoring';
  state.updatedAt = new Date().toISOString();
  await saveReportState(testResultId, state);

  try {
    state = await scoreRemainingCases(testResultId, items, resultItemByTestItemId, state, deadline);

    if (state.completedCases < state.totalCases) {
      // Time budget exhausted with cases still pending — leave status 'scoring' so the caller
      // (or the report page's auto-continue) re-invokes generateReport to pick up where we left off.
      await saveReportState(testResultId, state);
      return state;
    }

    state.status = 'synthesizing';
    state.updatedAt = new Date().toISOString();
    await saveReportState(testResultId, state);

    // B0-586 — one shared assembly for both the Markdown below and `/report/data`.
    // B0-714 — this is also where the structural invariants run (`computeReportMetrics` asserts
    // them). A violation throws a `ReportInvariantError` from inside this try, so the catch below
    // persists `status: 'failed'` with an `INVARIANT:`-prefixed `state.error` and execution never
    // reaches `saveReportMarkdown` — a report that does not reconcile can never be written as
    // `completed`.
    const { metrics, cases } = assembleReportCases({
      test,
      run,
      items,
      resultItems,
      caseScores: state.caseScores,
    });

    const findingsByCaseId = new Map(
      items.map((item) => {
        const score = state.caseScores[item.id];
        return [
          item.id,
          { explanation: score.explanation, missed: score.missed, incorrect: score.incorrect },
        ] as const;
      }),
    );
    const synthesis = await synthesizeReportFindings(metrics, findingsByCaseId, MODEL_TAG);
    state.synthesis = synthesis;

    const generatedAt = new Date().toISOString();
    const markdown = renderReportMarkdown({
      test,
      run,
      metrics,
      cases,
      synthesis,
      generatedAt,
    });

    // B0-609 — persist the aggregate score/grade alongside the report so the "Recent runs" table
    // can render it without recomputing metrics from per-item data it doesn't otherwise load.
    state.overall = { avg: metrics.overall.avg, grade: metrics.overall.grade };
    state.status = 'completed';
    state.error = null;
    state.updatedAt = generatedAt;
    await saveReportState(testResultId, state);
    await saveReportMarkdown(testResultId, markdown, generatedAt);

    return state;
  } catch (error) {
    state.status = 'failed';
    state.error = error instanceof Error ? error.message : 'Report generation failed.';
    state.updatedAt = new Date().toISOString();
    await saveReportState(testResultId, state);
    return state;
  }
}
