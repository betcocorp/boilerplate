import {
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
} from '~/lib/tests/repository';
import {
  extractItemSimilarityScore,
  extractRetrievedDocumentChunks,
} from '~/lib/tests/response-payload';
import type {
  TestItemRecord,
  TestRecord,
  TestResultItemRecord,
  TestResultRecord,
} from '~/lib/tests/types';

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
import {
  gradingConfigFromState,
  parseReportState,
  type CaseScore,
  type ReportGradingConfig,
  type ReportState,
  type ReportSynthesis,
} from './schemas';
import type { JudgedThresholds, ScoringRules } from './scoring-config';

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
  /** B0-812 — `report_state.passMark`; null falls back to `DEFAULT_PASS_MARK`. */
  passMark?: number | null;
  /** B0-811 — `report_state.judgedThresholds`; null falls back to `DEFAULT_JUDGED_THRESHOLDS`. */
  judgedThresholds?: JudgedThresholds | null;
  /**
   * B0-835 — `report_state.scoringRules`; null falls back to `DEFAULT_SCORING_RULES`. Handed to the
   * consolidation and the metrics computation alike, so a pass's own overall in the variance block
   * and the consolidated headline are derived under the same rules.
   */
  scoringRules?: ScoringRules | null;
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
  /** B0-825 — what the report was graded with; printed in the header and carried on the wire. */
  config?: ReportGradingConfig | null;
};

export type AssembledReport = AssembledReportCases & {
  synthesis: ReportSynthesis;
  generatedAt: string;
  config: ReportGradingConfig | null;
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
     * B0-809 — per-concept verdicts are the grader's, authored on every pass and persisted on the
     * pass's `CaseScore`. When multi-pass, `consolidateCasePasses` takes the majority verdict per
     * phrase; single-pass, the one pass's block is the block. A case whose grader saw no concept
     * columns carries none, and `computeReportMetrics` marks it Unable to Evaluate rather than
     * inventing a Completeness for it. Nothing here reads the harness's `criteriaGrading` any more.
     *
     * The timings are handed to every pass so the agreement check inside `consolidateCasePasses`
     * stays armed: they are recorded once per case, so passes cannot legitimately disagree.
     */
    const passScores = params.casePassScores?.[item.id];
    const consolidated =
      passScores && passScores.length > 0
        ? consolidateCasePasses(
            passScores.map((score) => ({
              score,
              concepts: score.concepts ?? undefined,
              ttftSeconds,
              totalSeconds: latencySeconds,
            })),
            {
              spreadThreshold: params.spreadThreshold ?? undefined,
              passMark: params.passMark,
              scoringRules: params.scoringRules,
            },
          )
        : null;
    if (consolidated?.variance) varianceByCaseId.set(item.id, consolidated.variance);

    const score = consolidated?.score ?? caseScores[item.id] ?? unscoredPlaceholder();

    return {
      testItemId: item.id,
      question: item.prompt,
      priorityRaw: item.priority,
      category: item.prompt_category,
      score,
      latencySeconds,
      ttftSeconds,
      concepts: consolidated ? consolidated.concepts : (score.concepts ?? undefined),
      variance: consolidated?.variance ?? null,
    };
  });

  const metrics = computeReportMetrics(caseInputs, {
    invariantSeverity: params.invariantSeverity,
    passMark: params.passMark,
    judgedThresholds: params.judgedThresholds,
    scoringRules: params.scoringRules,
  });
  const evaluatedById = new Map(metrics.perCase.map((c) => [c.id, c]));
  // A case the metrics could not evaluate for want of expected concepts carries a stored score that
  // says otherwise; the rendered record has to say what the metrics decided, with the reason.
  const uteReasonById = new Map(metrics.ute.map((u) => [u.id, u.reason]));
  // Looked up, never recomputed — the same objects `computeReportMetrics` built the aggregates
  // from, so a case's speed line and the run's speed table can never disagree.
  const speedById = new Map((metrics.speed?.perCase ?? []).map((c) => [c.id, c]));

  const cases: ReportCase[] = items.map((item, index) => {
    const resultItem = resultItemByTestItemId.get(item.id);
    const storedScore = caseInputs[index].score;
    const uteReason = uteReasonById.get(item.id);
    const score: CaseScore =
      uteReason != null && !storedScore.unableToEvaluate
        ? { ...storedScore, unableToEvaluate: true, uteReason }
        : storedScore;
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
      unableToEvaluate: uteReason != null,
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
  const { synthesis, generatedAt, config, ...rest } = params;
  return { ...assembleReportCases(rest), synthesis, generatedAt, config: config ?? null };
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
    passMark: metrics.passMark,
    strictPassMark: metrics.strictPassMark,
    passOnlyUnderCurrentMark: metrics.passOnlyUnderCurrentMark,
    // B0-835 — the rules the numbers were derived under, and what each one actually did.
    scoringRules: metrics.scoringRules,
    gateFloor: metrics.gateFloor,
    speed: metrics.speed,
    concepts: metrics.concepts,
    // B0-811 — null when no case carries a judged metric.
    judged: metrics.judged,
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
    config: assembled.config,
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
      passMark: state.passMark,
      judgedThresholds: state.judgedThresholds,
      scoringRules: state.scoringRules,
      synthesis: state.synthesis,
      generatedAt: run.report_generated_at ?? state.updatedAt,
      config: gradingConfigFromState(state),
      // Read path: surface a reconciliation failure on `metrics.warnings` rather than throwing.
      // Generation already refused to persist a report that does not reconcile; a report that is
      // nonetheless stored stays viewable, with the violation named.
      invariantSeverity: 'warn',
    }),
  );
}
