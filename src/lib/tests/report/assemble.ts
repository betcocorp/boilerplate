import {
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
} from '~/lib/tests/repository';
import {
  extractCriteriaGrading,
  extractItemSimilarityScore,
  extractRetrievedDocumentChunks,
} from '~/lib/tests/response-payload';
import type {
  TestItemRecord,
  TestRecord,
  TestResultItemRecord,
  TestResultRecord,
} from '~/lib/tests/types';

import { deriveCaseConcepts } from './case-concepts';
import { consolidateCasePasses, type CaseGradingVariance } from './consolidate';
import type { ReportCase, ReportDataResponse, ReportMetricsData } from './data-schemas';
import {
  computeReportMetrics,
  tierLabel,
  type InvariantSeverity,
  type ReportCaseInput,
  type ReportMetrics,
} from './metrics';
import type { CaseHarnessAside } from './render';
import { caseAnchorId, orderCasesByTier } from './render';
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
 * Regulated-data rule: every expected/actual string, sub-score and timing is copied by reference
 * or by value with no parsing, rounding or unit conversion. The one conversion in this module is
 * milliseconds → seconds, isolated in `latencySecondsOf` / `ttftSecondsOf` below.
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
  /** `report_state.caseScores`, keyed by `test_items.id`. Already consolidated when multi-pass. */
  caseScores: Record<string, CaseScore>;
  /**
   * B0-719/B0-720 — `report_state.casePassScores`: each pass's independent score, keyed by
   * `test_items.id`. Absent (or empty) for a report graded before per-pass scoring existed, which
   * then assembles from `caseScores` alone exactly as it always did, with no variance block.
   */
  casePassScores?: Record<string, CaseScore[]>;
  /** B0-720 — `report_state.spreadThreshold`; null falls back to the shipped default. */
  spreadThreshold?: number | null;
  /**
   * B0-714 — how a failed structural invariant is treated. Defaults to `'throw'`, so the
   * generation path can never persist a report whose numbers contradict each other. `loadReportData`
   * passes `'warn'`: re-deriving an already-stored report is a read, and a historical record should
   * surface its contradiction loudly rather than become unopenable.
   */
  invariantSeverity?: InvariantSeverity;
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

/**
 * **The unit boundary.** `test_result_items` stores both timings in milliseconds; everything
 * downstream of these two functions — scoring, thresholds, aggregates, both renderers — works in
 * seconds and only in seconds. The `/ 1000` happens here, once, and nowhere else.
 *
 * This is the single worst trap in the speed work: a raw `1826` that never got divided scores a
 * 1.8 s first token as "Very slow" and looks entirely plausible on the page. `IMPLAUSIBLE_SECONDS`
 * in `./speed-rules` is the backstop that catches it, but the fix is to keep the conversion here.
 */
function latencySecondsOf(resultItem: TestResultItemRecord | undefined): number | null {
  return resultItem ? resultItem.elapsed_ms / 1000 : null;
}

/**
 * B0-715 — time to first token, in seconds. Null stays null: `ttft_ms` has only been populated
 * since B0-318/319, so older runs legitimately have none, and an unrecorded measurement is not a
 * fast one. It never becomes 0 and never affects whether a case is Unable to Evaluate.
 */
function ttftSecondsOf(resultItem: TestResultItemRecord | undefined): number | null {
  const ttftMs = resultItem?.ttft_ms;
  return typeof ttftMs === 'number' && Number.isFinite(ttftMs) ? ttftMs / 1000 : null;
}

/**
 * Pure assembly: raw rows + grading state in, metrics + per-case records out. No I/O, and no
 * synthesis — the generation path has to compute metrics *before* it can synthesize findings from
 * them, so this is the half both paths share and the only place `computeReportMetrics` is called.
 */
export function assembleReportCases(params: AssembleReportCasesParams): AssembledReportCases {
  const { test, run, items, caseScores } = params;
  const resultItemByTestItemId = indexLatestResultItems(params.resultItems);

  const varianceByCaseId = new Map<string, CaseGradingVariance>();

  const caseInputs: ReportCaseInput[] = items.map((item) => {
    const resultItem = resultItemByTestItemId.get(item.id);
    const latencySeconds = latencySecondsOf(resultItem);
    const ttftSeconds = ttftSecondsOf(resultItem);
    /**
     * B0-711 — per-concept verdicts come from the criteria grading the *run* already persisted
     * (`response_payload.criteriaGrading`), not from a second model call: the concepts were
     * judged once, at run time, and the report reads that judgment. Items without criteria get
     * `undefined` and behave exactly as they did before the concept rules existed.
     */
    const concepts = deriveCaseConcepts({
      criteriaGrading: extractCriteriaGrading(resultItem?.response_payload),
      minimumConcepts: item.minimum_concepts,
      expectedConcepts: item.expected_concepts,
    });

    /**
     * B0-720 — the passes are consolidated here, through the same pure function the generation
     * path already ran, so `caseScores` and this can never land on different numbers.
     *
     * The concepts and both timings are handed to every pass deliberately: they are derived once
     * per case (from the run's own row), not once per pass, so the agreement checks inside
     * `consolidateCasePasses` are guards rather than live comparisons. Feeding them through keeps
     * those guards armed if per-pass concepts or timings ever appear.
     */
    const passScores = params.casePassScores?.[item.id];
    const consolidated =
      passScores && passScores.length > 0
        ? consolidateCasePasses(
            passScores.map((score) => ({ score, concepts, ttftSeconds, totalSeconds: latencySeconds })),
            { spreadThreshold: params.spreadThreshold ?? undefined },
          )
        : null;
    if (consolidated?.variance) varianceByCaseId.set(item.id, consolidated.variance);

    return {
      testItemId: item.id,
      question: item.prompt,
      priorityRaw: item.priority,
      category: item.prompt_category,
      score: consolidated?.score ?? caseScores[item.id] ?? unscoredPlaceholder(),
      latencySeconds,
      ttftSeconds,
      concepts: consolidated ? consolidated.concepts : concepts,
      variance: consolidated?.variance ?? null,
    };
  });

  const metrics = computeReportMetrics(caseInputs, {
    invariantSeverity: params.invariantSeverity,
  });
  const evaluatedById = new Map(metrics.perCase.map((c) => [c.id, c]));
  // Looked up, never recomputed — the same objects `computeReportMetrics` built the aggregates
  // from, so a case's speed line and the run's speed table can never disagree.
  const speedById = new Map((metrics.speed?.perCase ?? []).map((c) => [c.id, c]));

  const cases: ReportCase[] = items.map((item, index) => {
    const resultItem = resultItemByTestItemId.get(item.id);
    const score = caseInputs[index].score;
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
      // The same object `computeReportMetrics` rated this case with — surfaced on the case record
      // so a renderer never has to reach back into `evaluated` (or re-derive) to show coverage.
      concepts: caseInputs[index].concepts ?? null,
      latencySeconds: caseInputs[index].latencySeconds,
      latencyMs: resultItem ? resultItem.elapsed_ms : null,
      ttftSeconds: caseInputs[index].ttftSeconds,
      ttftMs: resultItem?.ttft_ms ?? null,
      speed: speedById.get(item.id) ?? null,
      // B0-720 — null for a single-pass case, which is what omits every consistency readout.
      variance: varianceByCaseId.get(item.id) ?? null,
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
    speed: metrics.speed,
    concepts: metrics.concepts,
    // B0-721 — null for a single-pass report, so the whole consistency block is omitted.
    consistency: metrics.consistency,
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
      casePassScores: state.casePassScores,
      spreadThreshold: state.spreadThreshold,
      synthesis: state.synthesis,
      generatedAt: run.report_generated_at ?? state.updatedAt,
      // Read path: surface a reconciliation failure on `metrics.warnings` rather than throwing.
      // Generation already refused to persist a report that does not reconcile; a report that is
      // nonetheless stored stays viewable, with the violation named.
      invariantSeverity: 'warn',
    }),
  );
}
