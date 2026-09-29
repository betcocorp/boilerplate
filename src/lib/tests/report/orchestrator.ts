import {
  getTestById,
  getTestResultById,
  listAllResultItemsByResultId,
  saveReportMarkdown,
  saveReportState,
} from '~/lib/tests/repository';
import { resolveRunItems } from '~/lib/tests/resolve-run-items';
import type { ModelEffort } from '~/lib/constants/models';
import type { TestItemRecord, TestResultItemRecord } from '~/lib/tests/types';

import { assembleReportCases, indexLatestResultItems } from './assemble';
import { GRADING_PROMPT_HASH, scoreCase, unableToEvaluateScore } from './case-scorer';
import { consolidateCasePasses, loadConsistencyConfig } from './consolidate';
import { resolveExpectedSourceRefs, type ExpectedSourceIndex } from './expected-sources';
import { loadExpectedSourceIndexForItems } from './expected-sources-repository';
import {
  describeGradingProviderGap,
  effortForModel,
  effortFromState,
  loadGradingEffort,
  loadGradingModelTag,
  resolveGradingModel,
} from './grading-model';
import { renderReportMarkdown } from './render';
import {
  GRADING_CALL_FAILED_PREFIX,
  emptyReportState,
  gradingConfigFromState,
  isResumableFailure,
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
/**
 * B0-943 — how long a worker's claim on a report is honoured: one invocation's worth. A worker that
 * dies mid-slice therefore blocks the next one for at most this long.
 */
const LEASE_TTL_MS = 300_000;

/**
 * B0-943 — options for one invocation of {@link generateReport}.
 *
 * `skipIfLeased` is what the background hop chain and the stalled-run sweeper pass so they never
 * fight a human sitting on the report page. The interactive path deliberately does NOT pass it: a
 * person clicking "Generate report" is allowed to take the lease over.
 */
export type GenerateReportOptions = {
  /** Opaque id for this worker; a fresh uuid is minted when omitted. */
  workerId?: string;
  /** Return immediately (no grading, no status write) if another worker's lease is still live. */
  skipIfLeased?: boolean;
};

/**
 * True when `state` is held by a *different* worker whose lease has not yet expired.
 *
 * This is an ADVISORY lease, not an atomic one: the read and the write are separate round-trips, so
 * a narrow race can still let two workers in. That is accepted — the TTL bounds a stuck lease, and
 * `pendingPasses` re-derives correctly from `casePassScores` either way, so the worst case is a few
 * duplicated grading calls rather than a corrupt report. What it actually prevents is the common
 * and expensive case: an open report page and the background chain overlapping for minutes, each
 * paying for three `claude-opus-5` passes per case and overwriting the other's `saveReportState`.
 */
export function isLeasedByAnother(state: ReportState, workerId: string): boolean {
  if (!state.activeUntil || !state.activeWorker) return false;
  if (state.activeWorker === workerId) return false;
  const expiry = Date.parse(state.activeUntil);
  return Number.isFinite(expiry) && expiry > Date.now();
}

/** Stamps this worker's claim (and its refreshed expiry) onto the state about to be persisted. */
function takeLease(state: ReportState, workerId: string): void {
  state.activeWorker = workerId;
  state.activeUntil = new Date(Date.now() + LEASE_TTL_MS).toISOString();
}

/** Releases the claim so the next worker (or a human) can pick the report up immediately. */
function clearLease(state: ReportState): void {
  state.activeWorker = null;
  state.activeUntil = null;
}

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

/**
 * B0-991 — drops every pass that is Unable to Evaluate because the grading CALL failed (no key,
 * provider down, timeout), and un-consolidates the cases that lost one, so `pendingPasses` owes
 * those calls again. A pass the grader actually judged — including a judged Unable to Evaluate — is
 * kept: on the 2026-09-11 reports all 20 cases were graded before the key vanished and only the
 * synthesis failed; throwing those away to "start fresh" would have re-paid for 60 Opus calls.
 *
 * Returns how many passes were dropped.
 */
export function stripFailedGradingPasses(state: ReportState): number {
  let removed = 0;
  for (const [itemId, passes] of Object.entries(state.casePassScores)) {
    const kept = passes.filter(
      (pass) => !(pass.unableToEvaluate && pass.uteReason?.startsWith(GRADING_CALL_FAILED_PREFIX)),
    );
    if (kept.length === passes.length) continue;
    removed += passes.length - kept.length;
    state.casePassScores[itemId] = kept;
    delete state.caseScores[itemId];
  }
  if (removed > 0) {
    state.completedCases = Object.keys(state.caseScores).length;
  }
  return removed;
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
  expectedSourceIndex: ExpectedSourceIndex,
  resultId: string,
  passIndex: number,
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
   * B0-933 — both concept columns are `text[]`, one phrase per element, so the grader is handed the
   * stored phrases directly: no splitting, no re-spelling, and the exact phrases the report prints.
   * An item with neither column is Unable to Evaluate by rule and `scoreCase` returns that without
   * a model call. `expected_sources` is a `uuid[]`; it is resolved to `rag.document` titles from the
   * index built once for the whole run, never looked up here per case.
   */
  return scoreCase(
    {
      question: item.prompt,
      category: item.prompt_category,
      priorityRaw: item.priority,
      idealResponse: item.ideal_response,
      expectedSources: resolveExpectedSourceRefs(item.expected_sources, expectedSourceIndex),
      shouldCite: item.should_cite,
      mandatoryConcepts: item.minimum_concepts,
      expectedConcepts: item.expected_concepts,
      actualResponseText: responseText,
      modelTag,
      effort,
    },
    {},
    // B0-1115 — this pass's identity, so a successful grading call is attributed to the exact
    // (report, item, pass) it graded in `test_grading_usage`.
    { testResultId: resultId, testItemId: item.id, passIndex },
  );
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
  expectedSourceIndex: ExpectedSourceIndex,
  workerId: string,
): Promise<ReportState> {
  // Reconcile before looking at what's still pending: a case can have every pass recorded already
  // (so `pendingPasses` will never surface it again) and still be missing from `caseScores`.
  const completedBefore = Object.keys(state.caseScores).length;
  for (const item of items) finalizeCaseIfReady(item.id, state);
  if (Object.keys(state.caseScores).length !== completedBefore) {
    state.completedCases = Object.keys(state.caseScores).length;
    state.updatedAt = new Date().toISOString();
    takeLease(state, workerId);
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
          expectedSourceIndex,
          resultId,
          passIndex,
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
    // B0-943 — every checkpoint also renews the lease, so a long slice never lets its own claim
    // expire underneath it and invite a second worker in mid-grading.
    takeLease(state, workerId);
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
export async function generateReport(
  testResultId: string,
  options?: GenerateReportOptions,
): Promise<ReportState> {
  const workerId = options?.workerId ?? crypto.randomUUID();
  const deadline = Date.now() + WALL_CLOCK_BUDGET_MS;
  const run = await getTestResultById(testResultId);
  const test = await getTestById(run.test_id);
  // B0-1110 — a partial run grades only its `item_scope`; un-run items must never appear as
  // "Unable to Evaluate" placeholders, so `totalCases` below equals the scope size.
  const [items, resultItems] = await Promise.all([
    resolveRunItems(run),
    listAllResultItemsByResultId(run.id),
  ]);

  const resultItemByTestItemId = indexLatestResultItems(resultItems);

  // B0-933 — one batched `rag.document` read for every `expected_sources` uuid in the dataset, so
  // the grader payload and the rendered report both name documents rather than uuids, and neither
  // the per-pass loop nor assembly ever queries per case.
  const expectedSourceIndex = await loadExpectedSourceIndexForItems(items);

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
  // B0-991 — a report that failed only because its host had no provider credentials is resumed,
  // not restarted: the failure is cleared so the loop below runs, and the strip just after
  // `hydrateLegacyPassScores` re-owes every pass whose grading call never happened.
  if (isResumableFailure(state)) {
    state.error = null;
    state.failureClass = null;
  }
  // B0-943 — before any grading (and before any status write): stand down if another worker is
  // already on this report and we were told not to fight it. Returning the state unchanged leaves
  // the incumbent's lease, status and scores exactly as they were.
  if (options?.skipIfLeased && isLeasedByAnother(state, workerId)) {
    return state;
  }

  // B0-991 — preflight the provider BEFORE any grading call or `scoring` write. A missing key used
  // to surface as one thrown call per (case, pass), each recorded as UTE, with the report failing
  // only at synthesis; now it fails at once, names the host, and is classed so the pending-report
  // sweep can regenerate it once the host is fixed.
  const providerGap = describeGradingProviderGap(model);
  if (providerGap) {
    state.status = 'failed';
    state.error = providerGap;
    state.failureClass = 'provider_unconfigured';
    state.updatedAt = new Date().toISOString();
    clearLease(state);
    await saveReportState(testResultId, state);
    return state;
  }

  hydrateLegacyPassScores(state);
  /**
   * B0-991 — on EVERY entry, not only after a classed failure. A pass that is Unable to Evaluate
   * because the grading call threw is not a verdict, and a report resumed on top of such passes
   * skips straight to synthesis: run 77905ba4 was graded 60× "ANTHROPIC_API_KEY is not configured"
   * on the deploy, then "Retry" on a host WITH the key found every case complete, synthesised the
   * 20 UTEs, and produced a `completed` report asserting the agent "produced no answers". Dropping
   * those passes here makes Retry, the hop chain and the sweep all re-grade what was never graded.
   */
  stripFailedGradingPasses(state);
  state.status = 'scoring';
  state.updatedAt = new Date().toISOString();
  takeLease(state, workerId);
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
      expectedSourceIndex,
      workerId,
    );

    if (state.completedCases < state.totalCases) {
      // Time budget exhausted with cases still pending — leave status 'scoring' so the caller
      // (the B0-943 background hop chain, or the report page's auto-continue) re-invokes
      // generateReport to pick up where we left off. The lease is released here so the next hop
      // does not have to wait out its TTL.
      clearLease(state);
      await saveReportState(testResultId, state);
      return state;
    }

    state.status = 'synthesizing';
    state.updatedAt = new Date().toISOString();
    takeLease(state, workerId);
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
      expectedSourceIndex,
    });

    // B0-863 — sourced from the already-assembled `cases` (not `items`/`state.caseScores` alone)
    // so the synthesis call sees the same harness provenance (`answerProvenance`, `routingDecision`,
    // fired gates, draft-discarded, retrieved-chunk count) the per-case "Harness signal" line
    // renders — evidence for a recommendation, never a metric input (see the synthesis prompt).
    const findingsByCaseId = new Map(
      cases.map((c) => [
        c.id,
        {
          explanation: c.score.explanation,
          missed: c.score.missed,
          incorrect: c.score.incorrect,
          harness: c.harness,
        },
      ]),
    );
    const synthesis = await synthesizeReportFindings(
      metrics,
      findingsByCaseId,
      testResultId,
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
    state.failureClass = null;
    state.updatedAt = generatedAt;
    clearLease(state);
    await saveReportState(testResultId, state);
    await saveReportMarkdown(testResultId, markdown, generatedAt);

    return state;
  } catch (error) {
    state.status = 'failed';
    state.error = error instanceof Error ? error.message : 'Report generation failed.';
    // A failure that got this far is about the grading or the data, never the host's config.
    state.failureClass = null;
    state.updatedAt = new Date().toISOString();
    clearLease(state);
    await saveReportState(testResultId, state);
    return state;
  }
}
