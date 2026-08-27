import {
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
} from '~/lib/tests/repository';
import { extractItemSimilarityScore, extractRetrievedDocumentChunks } from '~/lib/tests/response-payload';
import type {
  TestItemRecord,
  TestRecord,
  TestResultItemRecord,
  TestResultRecord,
} from '~/lib/tests/types';

import type { ReportCase, ReportDataResponse, ReportMetricsData } from './data-schemas';
import { computeReportMetrics, tierLabel, type ReportCaseInput, type ReportMetrics } from './metrics';
import type { CaseHarnessAside } from './render';
import { caseAnchorId, latencyBandLabel, orderCasesByTier } from './render';
import { parseReportState, type CaseScore, type ReportState, type ReportSynthesis } from './schemas';

/**
 * B0-586 — the single assembly step that turns a run's raw rows (`tests`, `test_results`,
 * `test_items`, `test_result_items`) plus its persisted grading state into the exact structures
 * the report needs.
 *
 * Both consumers go through here, so the Markdown document and the structured
 * `/report/data` endpoint are guaranteed to be the same report:
 *
 * - `generateReport` (`./orchestrator.ts`) assembles, hands `metrics`/`cases`/`synthesis` straight
 *   to `renderReportMarkdown`, and persists the resulting Markdown.
 * - `loadReportData` re-assembles from the persisted `report_state` and projects the result onto
 *   the wire contract in `./data-schemas.ts`.
 *
 * `computeReportMetrics` is called from exactly one place in this module and nowhere else in the
 * report path.
 *
 * Regulated-data rule: every expected/actual string, sub-score and latency is copied by reference
 * or by value with no parsing, rounding or unit conversion.
 */

const NO_RESPONSE_PLACEHOLDER = '(no response recorded)';

/** The score stood in for an item that the persisted report never graded (dataset drift). */
function unscoredPlaceholder(): CaseScore {
  return {
    unableToEvaluate: true,
    uteReason: 'Not scored in this report — the dataset changed after the report was generated.',
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

/**
 * Keeps the most recent result row per test item — a retried case leaves more than one row for the
 * same `test_item_id`, and the report always grades the latest attempt.
 */
export function indexLatestResultItems(
  resultItems: TestResultItemRecord[],
): Map<string, TestResultItemRecord> {
  const byTestItemId = new Map<string, TestResultItemRecord>();
  for (const resultItem of resultItems) {
    const existing = byTestItemId.get(resultItem.test_item_id);
    if (!existing || resultItem.created_at > existing.created_at) {
      byTestItemId.set(resultItem.test_item_id, resultItem);
    }
  }
  return byTestItemId;
}

export type AssembleReportCasesParams = {
  test: TestRecord;
  run: TestResultRecord;
  items: TestItemRecord[];
  resultItems: TestResultItemRecord[];
  /** `report_state.caseScores`, keyed by `test_items.id`. */
  caseScores: Record<string, CaseScore>;
};

export type AssembledReportCases = {
  test: TestRecord;
  run: TestResultRecord;
  /** The raw metrics object, exactly as `renderReportMarkdown` consumes it. */
  metrics: ReportMetrics;
  /** Already ordered by tier, so the Markdown's own ordering pass is a no-op. */
  cases: ReportCase[];
  /** True when the dataset's item count no longer matches what the report was graded against. */
  stale: boolean;
};

export type AssembleReportParams = AssembleReportCasesParams & {
  synthesis: ReportSynthesis;
  generatedAt: string;
};

export type AssembledReport = AssembledReportCases & {
  synthesis: ReportSynthesis;
  generatedAt: string;
};

function latencySecondsOf(resultItem: TestResultItemRecord | undefined): number | null {
  return resultItem ? resultItem.elapsed_ms / 1000 : null;
}

/**
 * Pure assembly: raw rows + grading state in, metrics + per-case records out. No I/O, and no
 * synthesis — the generation path has to compute metrics *before* it can synthesize findings from
 * them, so this is the half both paths share and the only place `computeReportMetrics` is called.
 */
export function assembleReportCases(params: AssembleReportCasesParams): AssembledReportCases {
  const { test, run, items, caseScores } = params;
  const resultItemByTestItemId = indexLatestResultItems(params.resultItems);

  const caseInputs: ReportCaseInput[] = items.map((item) => {
    const resultItem = resultItemByTestItemId.get(item.id);
    return {
      testItemId: item.id,
      question: item.prompt,
      priorityRaw: item.priority,
      category: item.prompt_category,
      score: caseScores[item.id] ?? unscoredPlaceholder(),
      latencySeconds: latencySecondsOf(resultItem),
    };
  });

  const metrics = computeReportMetrics(caseInputs);
  const evaluatedById = new Map(metrics.perCase.map((c) => [c.id, c]));

  const cases: ReportCase[] = items.map((item, index) => {
    const resultItem = resultItemByTestItemId.get(item.id);
    const score = caseInputs[index].score;
    const latencySeconds = latencySecondsOf(resultItem);
    const harness: CaseHarnessAside | null = resultItem
      ? {
          passed: resultItem.passed,
          status: resultItem.status,
          similarity: extractItemSimilarityScore(resultItem.response_payload),
        }
      : null;

    const responseText = resultItem?.response_text?.trim();
    const documentIds = new Set(
      extractRetrievedDocumentChunks(resultItem?.response_payload).map((c) => c.document_id),
    );

    return {
      id: item.id,
      anchorId: caseAnchorId(item.id),
      question: item.prompt,
      tier: tierLabel(item.priority),
      priorityRaw: item.priority,
      category: item.prompt_category ?? 'Uncategorized',
      idealResponse: item.ideal_response,
      expectedConcepts: item.expected_concepts,
      minimumConcepts: item.minimum_concepts,
      expectedSources: item.expected_sources,
      expectedShouldAnswer: item.expected_should_answer,
      actual: responseText || NO_RESPONSE_PLACEHOLDER,
      responseRecorded: Boolean(responseText),
      score,
      unableToEvaluate: score.unableToEvaluate,
      evaluated: evaluatedById.get(item.id) ?? null,
      latencySeconds,
      latencyMs: resultItem ? resultItem.elapsed_ms : null,
      latencyBand:
        latencySeconds != null && metrics.latency
          ? latencyBandLabel(latencySeconds, metrics.latency.thresholds)
          : null,
      harness,
      retrievedDocumentIds: [...documentIds],
      workflowRunId: resultItem?.workflow_run_id ?? null,
    };
  });

  return {
    test,
    run,
    metrics,
    cases: orderCasesByTier(cases),
    stale: items.some((item) => !(item.id in caseScores)),
  };
}

/** `assembleReportCases` plus the synthesis and timestamp that complete a finished report. */
export function assembleReportData(params: AssembleReportParams): AssembledReport {
  const { synthesis, generatedAt, ...rest } = params;
  return { ...assembleReportCases(rest), synthesis, generatedAt };
}

/** Projects the tuple-keyed metric groups onto the named-object wire shape. */
function toMetricsPayload(metrics: ReportMetrics): ReportMetricsData {
  return {
    totalCases: metrics.totalCases,
    evaluated: metrics.evaluated,
    uteCount: metrics.uteCount,
    ute: metrics.ute,
    overall: metrics.overall,
    highest: metrics.highest,
    lowest: metrics.lowest,
    perCase: metrics.perCase,
    tiers: metrics.tiers.map(([name, block]) => ({ name, block })),
    categories: metrics.categories.map(([name, block]) => ({ name, block })),
    strongestCategory: metrics.strongestCategory,
    weakestCategory: metrics.weakestCategory,
    latency: metrics.latency,
    warnings: metrics.warnings,
  };
}

/** The `status: 'ready'` wire body for an assembled report. */
export function toReportDataPayload(assembled: AssembledReport): ReportDataResponse {
  return {
    ok: true,
    status: 'ready',
    runId: assembled.run.id,
    testId: assembled.test.id,
    testName: assembled.test.name,
    intendedAgent: assembled.test.intended_agent,
    generatedAt: assembled.generatedAt,
    stale: assembled.stale,
    metrics: toMetricsPayload(assembled.metrics),
    synthesis: assembled.synthesis,
    cases: assembled.cases,
  };
}

/**
 * The explicit "no report to show yet" body. Carries the generation state machine's progress so a
 * caller can distinguish "never started" from "still scoring" from "failed" without a second fetch.
 */
export function toNotGeneratedPayload(
  runId: string,
  state: ReportState | null,
): ReportDataResponse {
  return {
    ok: true,
    status: 'not_generated',
    runId,
    reportStatus: state?.status ?? null,
    totalCases: state?.totalCases ?? 0,
    completedCases: state?.completedCases ?? 0,
    error: state?.error ?? null,
  };
}

/**
 * Loads a run and returns its report as data, or `null` when the run itself does not exist (the
 * caller's 404). A run that exists but has no finished report returns the `not_generated` body —
 * an explicit state the UI branches on, never an empty object.
 */
export async function loadReportData(runId: string): Promise<ReportDataResponse | null> {
  const run = await getTestResultById(runId).catch(() => null);
  if (!run) return null;

  const state = parseReportState(run.report_state);
  // Readiness is deliberately the same condition the Markdown endpoint uses (`run.report` exists),
  // plus the synthesis that only gets written once every case is scored. So "the Markdown endpoint
  // has a document" and "this endpoint is ready" can never disagree — including while a completed
  // report is being regenerated, where both keep serving the last finished report.
  if (!run.report || !state || state.synthesis == null) {
    return toNotGeneratedPayload(runId, state);
  }

  const [test, items, resultItems] = await Promise.all([
    getTestById(run.test_id),
    getTestItemsByTestId(run.test_id),
    listAllResultItemsByResultId(run.id),
  ]);

  return toReportDataPayload(
    assembleReportData({
      test,
      run,
      items,
      resultItems,
      caseScores: state.caseScores,
      synthesis: state.synthesis,
      generatedAt: run.report_generated_at ?? state.updatedAt,
    }),
  );
}
