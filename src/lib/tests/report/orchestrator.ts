import {
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
  saveReportMarkdown,
  saveReportState,
} from '~/lib/tests/repository';
import type { ModelEffort } from '~/lib/constants/models';
import type { TestItemRecord, TestResultItemRecord } from '~/lib/tests/types';

import { assembleReportCases, indexLatestResultItems } from './assemble';
import { splitConcepts } from './case-concepts';
import { GRADING_PROMPT_HASH, scoreCase, unableToEvaluateScore } from './case-scorer';
import { consolidateCasePasses, loadConsistencyConfig } from './consolidate';
import {
  effortForModel,
  effortFromState,
  loadGradingEffort,
  loadGradingModelTag,
  resolveGradingModel,
} from './grading-model';
import { renderReportMarkdown } from './render';
import {
  emptyReportState,
  gradingConfigFromState,
  parseReportState,
  type CaseScore,
  type ReportState,
} from './schemas';
import { loadJudgedThresholds, loadPassMark, loadScoringRules } from './scoring-config';
import { synthesizeReportFindings } from './synthesizer';

/** Concurrent grading calls in flight, counted in (case, pass) units — not in cases. */
const BATCH_SIZE = 5;
/** Leaves headroom under the route's `maxDuration = 300` for the final save + response. */
const WALL_CLOCK_BUDGET_MS = 260_000;

function noResponseScore(reason: string): CaseScore {
  return unableToEvaluateScore(reason);
}

/**
 * B0-719 — a report persisted before per-pass scores existed has its one grading pass in
 * `caseScores` and nothing in `casePassScores`. Seeding pass 0 from it is what stops a resume
 * re-grading (and re-paying for) every case that was already scored.
 */
export function hydrateLegacyPassScores(state: ReportState): void {
  if (Object.keys(state.casePassScores).length > 0) return;
  for (const [itemId, score] of Object.entries(state.caseScores)) {
    state.casePassScores[itemId] = [score];
  }
}

/** One grading call still owed: this case, this pass index. */
export type PendingPass = { item: TestItemRecord; passIndex: number };

/**
 * Pass-major, so pass 1 finishes for every case before pass 2 starts on any of them. That is what
 * makes an interruption cheap: a crash part-way through pass 2 leaves every pass-1 score on the
 * record and only the incomplete pass is re-run.
 */
export function pendingPasses(items: TestItemRecord[], state: ReportState): PendingPass[] {
  const pending: PendingPass[] = [];
  for (let passIndex = 0; passIndex < state.passes; passIndex += 1) {
    for (const item of items) {
      if ((state.casePassScores[item.id]?.length ?? 0) <= passIndex) {
        pending.push({ item, passIndex });
      }
    }
  }
  return pending;
}

async function scoreOnePass(
  item: TestItemRecord,
  resultItem: TestResultItemRecord | undefined,
  modelTag: string,
  effort: ModelEffort | undefined,
): Promise<CaseScore> {
  const responseText = resultItem?.response_text?.trim();
  if (!resultItem) {
    return noResponseScore('No result recorded for this item in this run.');
  }
  if (!responseText) {
    return noResponseScore(
      resultItem.error_message
        ? `No response text recorded; harness error: ${resultItem.error_message}`
        : 'No response text recorded for this item in this run.',
    );
  }
  /**
   * Every pass sees exactly this — the question, the golden answer, the split concept lists and the
   * response. **No pass is ever told what another pass scored, or shown another pass's narrative**,
   * and the grading prompt is untouched: passes that could see each other would agree by
   * construction, and their agreement would measure nothing.
   *
   * B0-809 — the concept columns are split here, once, with the same splitter the reference skill
   * uses, so the grader judges the exact phrases the report will print. An item with neither column
   * is Unable to Evaluate by rule and `scoreCase` returns that without a model call.
   */
  return scoreCase({
    question: item.prompt,
    category: item.prompt_category,
    priorityRaw: item.priority,
    idealResponse: item.ideal_response,
    expectedSources: item.expected_sources,
    expectedShouldAnswer: item.expected_should_answer,
    mandatoryConcepts: splitConcepts(item.minimum_concepts),
    expectedConcepts: splitConcepts(item.expected_concepts),
    actualResponseText: responseText,
    modelTag,
    effort,
  });
}

/**
 * Consolidates one case's passes into `state.caseScores` if every pass is in and it hasn't been
 * consolidated yet. Split out so a resume can retry this for a case whose passes all landed on a
 * prior call but whose consolidation never got recorded (the call crashed, or the process died,
 * between the passes being saved and this running) — `pendingPasses` only checks
 * `casePassScores`, so without this a case in that state is never revisited and generation stalls
 * forever with nothing left to score and nothing telling the caller why.
 */
export function finalizeCaseIfReady(itemId: string, state: ReportState): void {
  if (state.caseScores[itemId]) return;
  const scores = state.casePassScores[itemId];
  if (!scores || scores.length < state.passes) return;

  const consolidated = consolidateCasePasses(
    scores.map((passScore) => ({
      score: passScore,
      concepts: passScore.concepts ?? undefined,
    })),
    {
      spreadThreshold: state.spreadThreshold ?? undefined,
      passMark: state.passMark,
      scoringRules: state.scoringRules,
    },
  );
  state.caseScores[itemId] = {
    ...consolidated.score,
    concepts: consolidated.concepts ?? null,
  };
}

async function scoreRemainingCases(
  resultId: string,
  items: TestItemRecord[],
  resultItemByTestItemId: Map<string, TestResultItemRecord>,
  state: ReportState,
  deadline: number,
  modelTag: string,
  effort: ModelEffort | undefined,
): Promise<ReportState> {
  // Reconcile before looking at what's still pending: a case can have every pass recorded already
  // (so `pendingPasses` will never surface it again) and still be missing from `caseScores`.
  const completedBefore = Object.keys(state.caseScores).length;
  for (const item of items) finalizeCaseIfReady(item.id, state);
  if (Object.keys(state.caseScores).length !== completedBefore) {
    state.completedCases = Object.keys(state.caseScores).length;
    state.updatedAt = new Date().toISOString();
    await saveReportState(resultId, state);
  }

  const pending = pendingPasses(items, state);

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    if (Date.now() >= deadline) break;

    const batch = pending.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async ({ item, passIndex }) => {
        const score = await scoreOnePass(
          item,
          resultItemByTestItemId.get(item.id),
          modelTag,
          effort,
        );
        return { itemId: item.id, passIndex, score } as const;
      }),
    );

    for (const { itemId, passIndex, score } of results) {
      const scores = (state.casePassScores[itemId] ??= []);
      scores[passIndex] = score;
      // Consolidated only once every pass for this case is in, so `caseScores` never holds a
      // half-consolidated verdict that a crash could leave behind as if it were final. The
      // consolidated concept block rides on the consolidated score so single-score readers see it.
      finalizeCaseIfReady(itemId, state);
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

  // B0-765 — read once per call so a report already in flight can't have half its cases graded
  // on one model and the other half on a mid-run settings change.
  const modelTag = await loadGradingModelTag();
  const model = await resolveGradingModel(modelTag);
  // B0-806 — how hard an Anthropic grader thinks; recorded only when the model honours it, and
  // persisted on the state like everything else here so a resume grades at the same effort.
  const gradingEffort = effortForModel(model, await loadGradingEffort());
  // B0-719/B0-720 — read once, and only ever written into a *fresh* state. A report already
  // part-way through keeps the pass count and threshold it started with, so changing the setting
  // mid-report can never leave one half of its cases graded three times and the other half once.
  const config = await loadConsistencyConfig();
  // B0-812 — same contract: the pass mark is resolved once and persisted on a fresh state, so a
  // settings change mid-report cannot rate one half of its cases at 60 and the other at 70.
  const passMark = await loadPassMark();
  // B0-835 — same contract again: the four concept rules are resolved once and persisted on a fresh
  // state, so flipping the gate or the floor mid-report can never score one half of its cases under
  // one rulebook and the other half under another.
  const scoringRules = await loadScoringRules();
  const judgedThresholds = await loadJudgedThresholds();
  // B0-810/B0-811 — the prompt that grades this report and the thresholds it is read at, resolved
  // once and persisted, so two reports that disagree can be told apart.
  const fresh = () => ({
    ...emptyReportState(
      model,
      items.length,
      config.passes,
      config.spreadThreshold,
      passMark,
      scoringRules,
    ),
    gradingPromptHash: GRADING_PROMPT_HASH,
    judgedThresholds,
    gradingEffort,
  });
  let state = parseReportState(run.report_state) ?? fresh();
  if (state.totalCases !== items.length) {
    // The run's item set changed (e.g. items added) since a prior partial report — start fresh.
    state = fresh();
  }
  hydrateLegacyPassScores(state);
  state.status = 'scoring';
  state.updatedAt = new Date().toISOString();
  await saveReportState(testResultId, state);

  try {
    state = await scoreRemainingCases(
      testResultId,
      items,
      resultItemByTestItemId,
      state,
      deadline,
      modelTag,
      effortFromState(state.gradingEffort),
    );

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
      // B0-720 — the per-pass scores are what the consistency block is computed from. Assembly
      // consolidates them through the same pure function this module already used above, so the
      // score it lands on and the score persisted in `caseScores` cannot disagree.
      casePassScores: state.casePassScores,
      spreadThreshold: state.spreadThreshold,
      passMark: state.passMark,
      judgedThresholds: state.judgedThresholds,
      scoringRules: state.scoringRules,
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
    const synthesis = await synthesizeReportFindings(
      metrics,
      findingsByCaseId,
      modelTag,
      effortFromState(state.gradingEffort),
    );
    state.synthesis = synthesis;

    const generatedAt = new Date().toISOString();
    const markdown = renderReportMarkdown({
      test,
      run,
      metrics,
      cases,
      synthesis,
      generatedAt,
      config: gradingConfigFromState(state),
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
