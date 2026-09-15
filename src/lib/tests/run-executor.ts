import { after } from 'next/server';

import { modelProviderFor } from '~/lib/constants/models';
import {
  isGenerationRuntime,
  selectGenerationRuntime,
} from '~/lib/llm/generation-runtime';
import { resolveModel } from '~/lib/llm/resolve-model';
import { logError, logWarn } from '~/lib/observability/logger';
import { classifyUserIntent, type IntentClassification } from '~/lib/orchestrator/intent-classifier';
import {
  classifyUserIntentSemantic,
  type SemanticRouteDecision,
} from '~/lib/orchestrator/semantic-router';
import { routeUserMessageToSme, type SmeRouteDecision } from '~/lib/orchestrator/sme-routing';
import { getBooleanSetting } from '~/lib/settings/settings-service';

import {
  getExistingResultItemIds,
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  insertTestResultItems,
  listOrchestrationPlannerStepOutputsByWorkflowRunIds,
  sumResultItemsElapsedMsByResultId,
  updateTestRecord,
  updateTestResult,
} from './repository';
import type { CriteriaGradingOutcome } from './criteria-schemas';
import { analyzeAndPersistFailureRootCause } from './failure-root-cause';
import { mandatoryConceptPhrases } from './grading';
import {
  PROVIDER_FAULT_ABORT_STREAK,
  PROVIDER_FAULT_LABEL,
  type ProviderFaultKind,
} from './provider-fault';
import { scheduleReportGeneration } from './report/schedule-report-generation';
import { parseTestRunConfig } from './run-config';
import { runSingleTestItem } from './runner';
import { canScheduleRunContinuation } from './schedule-run-continuation';
import { generateAndSaveRunInsights } from './run-insights';
import { runRunComparisonAnalysis, startRunComparison } from './run-comparison';
import {
  buildRoutingComparisonFields,
  describeRoutingFallback,
  normalizeKeywordRoute,
  resolveIntendedAgentLabel,
  type RoutingComparisonFields,
  type SemanticRouteInstrumentation,
} from './routing-comparison';
import { parseSignalsAnalysisGate } from './signal-accuracy';
import { isTerminalRunStatus } from './types';
import type { NewTestResultItemRecord, TestItemRecord, TestRecord } from './types';

/**
 * B0-501 / B0-652 — runs ALL THREE routers for a chat-style eval item: the keyword router
 * (`routeUserMessageToSme`), the LLM intent classifier (`classifyUserIntent`) and the semantic
 * router (`classifyUserIntentSemantic`), purely for instrumentation — no call
 * influences the answer already produced by `runSingleTestItem` above it (which goes through the
 * real `runBexChatTurn` → orchestrator path independently). Ground truth is resolved once per item
 * from `test_items.intended_agent_item` (B0-498), falling back to the suite-level `tests.intended_agent`.
 *
 * `classifyUserIntent` is documented to never throw — on any LLM error/timeout it already degrades
 * to its `ambiguous` fallback internally (B0-511 hardening: no keyword consultation) — but this is
 * wrapped anyway so a future change to that contract can't take an eval run down with it; the
 * catch falls back to the keyword decision already in hand, which for an offline comparison column
 * is a reasonable stand-in.
 *
 * Cost/latency note: since the B0-511 cutover `BEX_LLM_ROUTER_ENABLED` defaults ON, so this is one
 * real `gpt-4o-mini` structured-output call (bounded by `BEX_ROUTER_TIMEOUT_MS`) per item on top
 * of the existing chat-turn call — the same call the chat turn itself now pays, and the B0-505
 * cache dedupes replays of identical items. Set `BEX_LLM_ROUTER_ENABLED=false` to make this column
 * free (it then records the degraded `ambiguous` fallback).
 *
 * **B0-537 — multi-turn behaviour (deliberate, unchanged).** For a multi-turn scenario row this
 * still classifies `item.prompt` — i.e. TURN 1 ONLY, with `[]` history. Two reasons:
 *   1. The B0-500 comparison columns are one SET per `test_result_items` row (one keyword route, one
 *      LLM route, one semantic route, one agreement flag). There is nowhere to put N per-turn
 *      routes without the `turn_index` column this ticket deliberately did not add, so a scenario
 *      can only be represented by one turn.
 *   2. Turn 1 with empty history is exactly what the live chat classifies on a first message, so
 *      routing accuracy stays apples-to-apples with the single-turn corpus these columns were built
 *      for. Comparing a turn-3 route (which the live router sees WITH history) against a turn-1
 *      ground truth would silently poison the routing-accuracy dashboards.
 * The scope is recorded explicitly as `multiTurn.routingComparisonScope = 'first_turn_only'` on the
 * result payload so no one has to infer it. Per-turn routing instrumentation is a follow-up.
 */
async function computeRoutingComparisonForItem(
  item: TestItemRecord,
  test: TestRecord,
  /**
   * B0-911 — this item's `workflow_run_id`, so the LIVE `signals_analysis` gate can be read for the
   * fallback reason. `null` when the item errored before a workflow run existed; the router
   * instrumentation reason below then stands alone.
   */
  workflowRunId: string | null,
): Promise<RoutingComparisonFields> {
  const intendedAgentLabel = resolveIntendedAgentLabel({
    itemIntendedAgent: item.intended_agent_item,
    testIntendedAgent: test.intended_agent,
  });

  const keywordStartedAt = performance.now();
  const keywordDecision: SmeRouteDecision = routeUserMessageToSme(item.prompt);
  const keywordRouteLatencyMs = Math.round(performance.now() - keywordStartedAt);

  /**
   * B0-911 — the classification is kept WHOLE (not narrowed to `intent`/`confidence` as it was)
   * because `source`/`fallbackReason` are the point: `classifyUserIntent` never throws, so a
   * provider outage arrives as an ordinary-looking result whose only tell is
   * `source: 'keyword_fallback'`. Read at the call site by design — the classifier module itself is
   * unchanged.
   */
  let llmClassification: Pick<
    IntentClassification,
    'intent' | 'confidence' | 'source' | 'fallbackReason'
  >;
  const llmStartedAt = performance.now();
  try {
    llmClassification = await classifyUserIntent(item.prompt, []);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logWarn('test_run_dual_router_llm_classification_failed', {
      testItemId: item.id,
      message,
    });
    llmClassification = {
      intent: normalizeKeywordRoute(keywordDecision),
      confidence: keywordDecision.agent ? 0.5 : 0,
      // This stand-in IS a fallback, and a contract-breaking throw is the most serious kind — so it
      // is recorded as one rather than passed off as a clean classification.
      source: 'keyword_fallback',
      fallbackReason: `classifyUserIntent threw: ${message}`,
    };
  }
  // B0-524 — measured even on the fallback path above: a fast keyword-fallback is still a real,
  // informative latency sample, not a missing one (only a thrown-before-start case has no timing).
  const llmRouteLatencyMs = Math.round(performance.now() - llmStartedAt);

  /**
   * B0-652 — third router in the comparison. `classifyUserIntentSemantic` is contracted never to
   * throw (it degrades to `path: 'fallback'`, `route: 'ambiguous'`, `error: <reason>`), and its own
   * `latencyMs`/`embeddingMs`/`scoringMs` are used rather than a wrapper measurement so the
   * embedding round-trip stays separable from the cosine pass — the ONLY way the ticket's ~10ms
   * budget can be reported honestly.
   *
   * The catch below exists for the same reason as the LLM one above: a future contract change must
   * not be able to take an eval run down. On that path the semantic fields are left UNSET (not
   * zeroed), because "not measured" and "measured as ambiguous in 0ms" are different facts.
   *
   * Cost note: this is one embedding call per chat item on top of the existing chat turn and LLM
   * classification. The B0-647 cache dedupes identical prompts within its TTL, and the router
   * returns a cheap degraded decision when it isn't initialized/enabled.
   */
  let semanticDecision: SemanticRouteInstrumentation | null = null;
  try {
    const decision: SemanticRouteDecision = await classifyUserIntentSemantic(item.prompt, []);
    semanticDecision = {
      route: decision.route,
      confidence: decision.confidence,
      margin: decision.margin,
      path: decision.path,
      latencyMs: Math.round(decision.latencyMs),
      embeddingMs: Math.round(decision.embeddingMs),
      scoringMs: Math.round(decision.scoringMs),
    };
  } catch (error) {
    logWarn('test_run_semantic_router_classification_failed', {
      testItemId: item.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * B0-911 — the LIVE half of the fallback record: `analyzeTurnSignals` is what actually routed the
   * answer this item was graded on, and it degrades the same silent way the classifier does. Its
   * `source`/`fallbackReason` are already persisted on the `signals_analysis` gate of the
   * `orchestration_planner` step (B0-786), so they are READ here rather than recomputed — no second
   * model call, and no edit to `analyze-turn-signals.ts`.
   *
   * Best-effort by design: a failure to read the gate must never take down a run that just
   * answered successfully, and `null` simply means "the live pass could not be inspected", which
   * leaves the router-instrumentation reason as the record.
   */
  const signalsClassification = workflowRunId
    ? await readSignalsFallbackForWorkflowRun(workflowRunId, item.id)
    : null;

  return buildRoutingComparisonFields({
    keywordDecision,
    llmClassification,
    intendedAgentLabel,
    keywordRouteLatencyMs,
    llmRouteLatencyMs,
    semanticDecision,
    routingFallbackReason: describeRoutingFallback({
      signals: signalsClassification,
      llmRouter: llmClassification,
    }),
  });
}

/**
 * B0-911 — `source` + `fallbackReason` off this item's persisted `signals_analysis` gate, or `null`
 * when there is no gate to read (a run that took a non-signals path, a step row not yet written, or
 * a read failure). Never throws.
 */
async function readSignalsFallbackForWorkflowRun(
  workflowRunId: string,
  testItemId: string,
): Promise<Pick<IntentClassification, 'source' | 'fallbackReason'> | null> {
  try {
    const rows = await listOrchestrationPlannerStepOutputsByWorkflowRunIds([workflowRunId]);
    const signals = parseSignalsAnalysisGate(rows[0]?.output);
    if (!signals) {
      return null;
    }
    return { source: signals.source, fallbackReason: signals.fallbackReason };
  } catch (error) {
    logWarn('test_run_signals_fallback_read_failed', {
      testItemId,
      workflowRunId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function asSummaryObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

/**
 * B0-990 — how long one invocation of {@link executeTestRun} may keep starting new items. The route
 * that hosts it has `maxDuration = 300`; the gap is headroom for the item in flight to finish and
 * for the yield checkpoint to be written. Items average 15–18 s but the slow tail is real, so the
 * headroom is a whole minute rather than the 40 s the report orchestrator keeps.
 */
export const RUN_WALL_CLOCK_BUDGET_MS = 240_000;

/** `summary.runner_state` written when the executor stopped itself to be continued in a new hop. */
export const RUNNER_STATE_YIELDED = 'yielded';

/** B0-1014 — `summary.runner_state` written when the provider-fault circuit breaker tripped. */
export const RUNNER_STATE_ABORTED = 'aborted';

/**
 * How {@link executeTestRun} returned.
 * - `completed` — every item ran; the run is terminal.
 * - `yielded`   — B0-990: the wall-clock budget ran out with items left; the run is back to `queued`
 *                 with `runner_state: 'yielded'` and the caller must schedule a continuation hop.
 * - `aborted`   — B0-1014: {@link PROVIDER_FAULT_ABORT_STREAK} consecutive items were refused by the
 *                 model provider; the run is terminal (`failed`) and must NOT be continued or graded.
 * - `paused` / `cancelled` — a control action stopped the loop.
 * - `skipped`   — nothing to do (already terminal or paused on entry).
 */
export type ExecuteTestRunOutcome =
  | 'completed'
  | 'yielded'
  | 'aborted'
  | 'paused'
  | 'cancelled'
  | 'skipped';

/**
 * B0-1014 — the line a human reads on `/admin/tests` and can act on immediately. Names the fault
 * kind (which decides whether the fix is a billing top-up, a key rotation, or just waiting) and how
 * much of the run actually executed, so nobody mistakes the abort for a quality result.
 */
export function describeProviderFaultAbort(input: {
  faultKind: ProviderFaultKind;
  streak: number;
  completedItems: number;
  totalItems: number;
}): string {
  return (
    `Run aborted after ${input.streak} consecutive provider faults ` +
    `(${input.faultKind} — ${PROVIDER_FAULT_LABEL[input.faultKind]}). ` +
    'The model provider refused every request; this run measured nothing. ' +
    `${input.completedItems} of ${input.totalItems} items ran before the run was stopped.`
  );
}

export type ExecuteTestRunOptions = {
  /** Wall-clock budget for THIS invocation. Defaults to {@link RUN_WALL_CLOCK_BUDGET_MS}. */
  budgetMs?: number;
  /**
   * Whether the executor may yield at all. Defaults to `canScheduleRunContinuation()`: a run that
   * nobody can pick up again must never be left `queued`, so without a service token the loop runs
   * to completion exactly as it did before B0-990 (local dev has no function ceiling anyway).
   */
  canYield?: boolean;
};

export async function executeTestRun(
  testResultId: string,
  options: ExecuteTestRunOptions = {},
): Promise<ExecuteTestRunOutcome> {
  const deadline = Date.now() + (options.budgetMs ?? RUN_WALL_CLOCK_BUDGET_MS);
  const canYield = options.canYield ?? canScheduleRunContinuation();
  const testResult = await getTestResultById(testResultId);

  if (isTerminalRunStatus(testResult.status) || testResult.status === 'paused') {
    return 'skipped';
  }

  const items = await getTestItemsByTestId(testResult.test_id);
  // B0-501 — fetched once per run (not per item): `tests.intended_agent` is the suite-level
  // ground-truth fallback `resolveIntendedAgentLabel` uses when a row has no `intended_agent_item`.
  const test = await getTestById(testResult.test_id);
  /**
   * B0-351 — the run's immutable execution config, read ONCE here from the `run_options` blob that
   * `runTestAction` wrote when the row was created. `parseTestRunConfig` replaces the three
   * hand-rolled extractions that used to live in this file (modelTag B0-632, useValidator
   * B0-600/603, routerType B0-681) and adds `agentMode`; the admin pages and CSV export read the
   * same parser, so what is displayed for a run cannot drift from what executed.
   */
  const runConfig = parseTestRunConfig(testResult.run_options);
  const modelTag = runConfig.modelTag ?? undefined;
  const useValidator = runConfig.useValidator;
  const agentMode = runConfig.agentMode;
  const routerTypeOverride = runConfig.routerType ?? undefined;
  // Use per-item existence check rather than an index offset so that retry (which
  // deletes only errored rows) and normal resume both work correctly when there
  // are gaps in the result set.
  const existingItemIds = await getExistingResultItemIds(testResult.id);
  let currentSummary = asSummaryObject(testResult.summary);
  let passedItems = Math.max(0, testResult.passed_items ?? 0);
  let failedItems = Math.max(0, testResult.failed_items ?? 0);
  let completedItems = existingItemIds.size;
  const resumedAt = new Date().toISOString();
  const totalItems = items.length;
  const resumedProgressPercent =
    totalItems > 0 ? Number(((completedItems / totalItems) * 100).toFixed(2)) : 0;
  let itemElapsedSumMs = await sumResultItemsElapsedMsByResultId(testResult.id);
  /**
   * B0-1014 — consecutive items the model provider refused. Reset by ANY item that got an answer,
   * so a lone transient 429 mid-run can never trip the breaker; only a sustained outage can.
   * Deliberately NOT seeded from already-persisted rows on resume: a continuation hop starts a fresh
   * provider connection, and a run that yielded an hour ago may well be answerable now.
   */
  let providerFaultStreak = 0;
  let lastProviderFault: ProviderFaultKind | null = null;

  /**
   * B0-757 — the CONCRETE model id this run actually executes on, resolved once here (not
   * re-derived at render time from the raw tag, which drifts the moment the BEX_RESPONSES_MODEL
   * settings default changes). Every item's `workflow_steps.output.model` is the item-level source
   * of truth (B0-563); this is the run-level mirror of that same resolution, for the run-list page
   * where joining every item's workflow run would be expensive. Preserved across a resume (never
   * re-resolved) so a run's displayed model can't change mid-run if the settings default does.
   */
  const resolvedModel =
    (typeof currentSummary.resolvedModel === 'string' && currentSummary.resolvedModel) ||
    (await resolveModel(modelTag));

  /**
   * B0-905 — which VENDOR answered, alongside the model id. Derived from `resolvedModel` rather
   * than stored independently, so the two can never disagree and a run written before this field
   * existed still badges correctly from its persisted model (`ModelProviderBadge` re-derives the
   * same way). Preserved across a resume for the same reason `resolvedModel` is.
   */
  const resolvedProvider = modelProviderFor(resolvedModel);

  /**
   * B0-912 — WHICH GENERATION LOOP served this run. On 2026-09-08 a paired OpenAI-vs-Anthropic
   * comparison was read as a vendor verdict, when the Anthropic arm had in fact run on the AI SDK
   * `streamText` loop (forced: the OpenAI Responses loop rejects a `claude-*` id by design) and the
   * OpenAI arm on the canonical Responses loop (`BEX_AI_SDK_GENERATION_ENABLED` defaults false) —
   * two different runtimes, and no report said so.
   *
   * Persisted in `summary`, the SAME jsonb blob (and the same write) that already carries
   * `resolvedModel`/`resolvedProvider` (B0-757/B0-905), rather than `run_options`: `run_options` is
   * written by `runTestAction` when the row is created and is immutable by design, but a queued run
   * can execute much later, and the runtime depends on a settings row that may move in between —
   * writing it there would record an intention, not a fact. Resolved through the very same
   * `selectGenerationRuntime` seam the workflow uses per turn, so the label cannot disagree with
   * the loop that ran. Preserved across a resume for the same reason `resolvedModel` is.
   */
  const generationRuntime =
    (isGenerationRuntime(currentSummary.generationRuntime) && currentSummary.generationRuntime) ||
    selectGenerationRuntime({
      model: resolvedModel,
      aiSdkGenerationSetting: await getBooleanSetting('BEX_AI_SDK_GENERATION_ENABLED', false),
    });

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
      resolvedModel,
      resolvedProvider,
      generationRuntime,
    },
  });

  await updateTestRecord(testResult.test_id, {
    status: 'running',
  });

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];

    // Skip items that already have a result — handles both normal resume and retry.
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
      await updateTestRecord(testResult.test_id, {
        status: 'ready',
      });
      return 'paused';
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
      await updateTestRecord(testResult.test_id, {
        status: 'ready',
      });
      return 'cancelled';
    }

    if (isTerminalRunStatus(controlRun.status)) {
      await updateTestRecord(testResult.test_id, {
        status: 'ready',
      });
      return 'skipped';
    }

    /**
     * B0-990 — yield before the platform kills us. Every finished item is already its own
     * `test_result_items` row and the loop above skips rows that exist, so the checkpoint is simply
     * "hand the run back as `queued`": the continuation hop claims it (`queued` → `running`, the
     * same compare-and-set every start uses) and resumes from the first unfinished item. The
     * `tests.status` stays `running` — the run has not stopped, only this invocation has.
     */
    if (canYield && Date.now() >= deadline) {
      const controlSummary = asSummaryObject(controlRun.summary);
      itemElapsedSumMs = await sumResultItemsElapsedMsByResultId(testResult.id);
      const priorHops =
        typeof controlSummary.continuation_hops === 'number' ? controlSummary.continuation_hops : 0;
      await updateTestResult(testResult.id, {
        status: 'queued',
        elapsed_ms: itemElapsedSumMs,
        summary: {
          ...controlSummary,
          runner_state: RUNNER_STATE_YIELDED,
          running_since: null,
          yielded_at: new Date().toISOString(),
          continuation_hops: priorHops + 1,
          elapsed_accumulated_ms: itemElapsedSumMs,
        },
      });
      return 'yielded';
    }

    const itemResult = await runSingleTestItem(testResult.id, item, {
      modelTag,
      useValidator,
      agentMode,
      routerTypeOverride,
      // B0-645: stamps the source test's name onto the created conversation.
      testName: test.name,
    });
    // B0-501 — dual-router instrumentation, independent of the answer `runSingleTestItem` already
    // produced above: never changes `itemResult.item`'s pass/fail or response fields, only adds the
    // B0-500 comparison columns before the single insert below.
    const routingComparisonFields = await computeRoutingComparisonForItem(
      item,
      test,
      itemResult.item.workflow_run_id ?? null,
    );
    const itemToInsert: NewTestResultItemRecord = {
      ...itemResult.item,
      ...routingComparisonFields,
    };
    const [insertedItem] = await insertTestResultItems([itemToInsert]);
    existingItemIds.add(item.id);

    /**
     * B0-617 — auto-fires the moment a failure is recorded, so the failure queue is
     * populated with a generated root cause by the time anyone views it (rather than the
     * static `suggestResolution()` heuristic it replaces). Awaited, not fire-and-forget:
     * the function itself never throws (see failure-root-cause.ts), and a full chat-eval
     * turn already dominates per-item wall-clock, so one more model call here is a small
     * marginal cost for a queue entry with an actual cause instead of a guess.
     */
    // B0-1014 — a provider-faulted item is skipped: its cause is already recorded in
    // `provider_fault`, and the root-cause grader is itself a model call that would hit the same
    // dead provider and log a second failure for the same incident.
    if (!itemResult.passed && !itemResult.providerFault && insertedItem) {
      const payload = insertedItem.response_payload as { criteriaGrading?: CriteriaGradingOutcome } | null;
      await analyzeAndPersistFailureRootCause({
        testResultItemId: insertedItem.id,
        testName: test.name,
        prompt: item.prompt,
        mandatoryConcepts: mandatoryConceptPhrases(item),
        responseText: insertedItem.response_text,
        errorMessage: insertedItem.error_message,
        criteriaGrading: payload?.criteriaGrading ?? null,
        modelTag,
      });
    }

    itemElapsedSumMs += itemResult.item.elapsed_ms;

    // B0-1014 — streak bookkeeping before the progress write, so the abort check below sees it.
    if (itemResult.providerFault) {
      providerFaultStreak += 1;
      lastProviderFault = itemResult.providerFault;
    } else {
      providerFaultStreak = 0;
      lastProviderFault = null;
    }

    if (itemResult.passed) {
      passedItems += 1;
    } else {
      failedItems += 1;
    }

    completedItems = existingItemIds.size;
    const progressPercent =
      items.length > 0 ? Number(((completedItems / items.length) * 100).toFixed(2)) : 0;
    const liveRun = await getTestResultById(testResult.id);
    currentSummary = asSummaryObject(liveRun.summary);

    await updateTestResult(testResult.id, {
      passed_items: passedItems,
      failed_items: failedItems,
      elapsed_ms: itemElapsedSumMs,
      summary: {
        ...currentSummary,
        completed_items: completedItems,
        total_items: items.length,
        progress_percent: progressPercent,
        pass_rate: items.length > 0 ? passedItems / items.length : 0,
        runner_state: 'running',
        elapsed_accumulated_ms: itemElapsedSumMs,
      },
    });

    /**
     * B0-1014 — circuit breaker. On 2026-09-14 the OpenAI org ran out of credits and the
     * 00:00 UTC golden sweep still spent six minutes per set producing 0/106 and a letter grade
     * computed off it. Once the provider has refused {@link PROVIDER_FAULT_ABORT_STREAK} items in a
     * row, the remaining items cannot produce a measurement, so the run stops and closes `failed`
     * rather than `completed_with_failures` — a terminal, NON-completed status, so every
     * completed-run aggregate (dataset averages, trends, the sweep ledger) excludes it by the rules
     * it already has. No continuation is scheduled and no report is generated: there is nothing to
     * grade, and a report would only launder the outage into a score.
     */
    if (lastProviderFault && providerFaultStreak >= PROVIDER_FAULT_ABORT_STREAK) {
      const abortReason = describeProviderFaultAbort({
        faultKind: lastProviderFault,
        streak: providerFaultStreak,
        completedItems,
        totalItems: items.length,
      });

      logError('test_run_aborted_provider_fault', {
        testResultId: testResult.id,
        testId: testResult.test_id,
        providerFault: lastProviderFault,
        streak: providerFaultStreak,
        completedItems,
        totalItems: items.length,
        resolvedModel,
        resolvedProvider,
      });

      await updateTestResult(testResult.id, {
        status: 'failed',
        passed_items: passedItems,
        failed_items: failedItems,
        elapsed_ms: itemElapsedSumMs,
        completed_at: new Date().toISOString(),
        summary: {
          ...currentSummary,
          completed_items: completedItems,
          total_items: items.length,
          progress_percent: progressPercent,
          runner_state: RUNNER_STATE_ABORTED,
          running_since: null,
          elapsed_accumulated_ms: itemElapsedSumMs,
          abort_reason: abortReason,
          provider_fault: lastProviderFault,
          provider_fault_streak: providerFaultStreak,
        },
      });

      await updateTestRecord(testResult.test_id, {
        status: 'ready',
      });

      return 'aborted';
    }
  }

  completedItems = existingItemIds.size;
  const finalRun = await getTestResultById(testResult.id);
  const finalSummary = asSummaryObject(finalRun.summary);
  itemElapsedSumMs = await sumResultItemsElapsedMsByResultId(testResult.id);

  await updateTestResult(testResult.id, {
    status: failedItems > 0 ? 'completed_with_failures' : 'completed',
    passed_items: passedItems,
    failed_items: failedItems,
    elapsed_ms: itemElapsedSumMs,
    completed_at: new Date().toISOString(),
    summary: {
      ...finalSummary,
      completed_items: completedItems,
      total_items: items.length,
      progress_percent: 100,
      pass_rate: items.length > 0 ? passedItems / items.length : 0,
      runner_state: 'completed',
      running_since: null,
      elapsed_accumulated_ms: itemElapsedSumMs,
    },
  });

  await updateTestRecord(testResult.test_id, {
    status: 'ready',
  });

  // B0-517 — auto-populate `test_results.insights` on every terminal chat run so the
  // "Run insights" panel has something on load instead of relying on someone clicking
  // "Analyze this run" (previously true of only 1 of 92 runs). Best-effort: a failure here
  // must not undo the run that just completed successfully, so it is logged, not thrown.
  try {
    const insightsResult = await generateAndSaveRunInsights(testResult.id);
    if (!insightsResult.ok && insightsResult.reason !== 'no_items') {
      logWarn('test_run_insights_auto_generate_failed', {
        testResultId: testResult.id,
        reason: insightsResult.reason,
      });
    }
  } catch (error) {
    logWarn('test_run_insights_auto_generate_error', {
      testResultId: testResult.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  // B0-608 — auto-generate the eval report on every terminal chat run so the run detail page
  // can show "View report" without anyone clicking "Generate report" first.
  //
  // B0-943 — generation runs in its OWN invocation chain, NOT here. This function is called from
  // `POST /api/admin/tests/runs/[runId]`, which has already spent most of its `maxDuration = 300`
  // executing the run itself (real runs take 170–350 s), so an `after()` that graded inline
  // inherited 0–130 s and was killed before finishing even one slice — which is why 24 of 154
  // completed runs in a 30-day window ended up with no report at all. `scheduleReportGeneration`
  // instead POSTs the report route, which answers 202 immediately and grades under its own fresh
  // 300 s, re-scheduling itself until the report is complete. Best-effort and non-throwing: a
  // report failure must never affect the run's own success.
  after(async () => {
    try {
      await scheduleReportGeneration({ testResultId: testResult.id, hop: 1 });
    } catch (error) {
      logWarn('test_run_report_auto_generate_error', {
        testResultId: testResult.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // B0-311 — post-mortem comparison against the previous completed run (Phase 1 of the "Test Run
  // Post-Mortem Analysis" epic, B0-310). The 'generating' (or 'no_baseline') row is written
  // SYNCHRONOUSLY, before after() fires, so the run-detail page can render a state on the very next
  // request; the LLM cause/fix analysis itself runs in the background via after(), same idiom as the
  // report/insights blocks above. `startRunComparison` is idempotent (a comparison row already
  // existing for this result id is left untouched), so re-entry never enqueues a second job, and any
  // failure here is logged, never thrown, so it can't undo the run that just completed successfully.
  try {
    const started = await startRunComparison(testResult.id);
    if (started.started) {
      after(async () => {
        try {
          await runRunComparisonAnalysis(testResult.id);
        } catch (error) {
          logWarn('test_run_comparison_auto_generate_error', {
            testResultId: testResult.id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      });
    }
  } catch (error) {
    logWarn('test_run_comparison_start_error', {
      testResultId: testResult.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return 'completed';
}
