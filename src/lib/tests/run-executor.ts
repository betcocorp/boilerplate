import { after } from 'next/server';

import { logWarn } from '~/lib/observability/logger';
import { classifyUserIntent, type IntentClassification } from '~/lib/orchestrator/intent-classifier';
import { routeUserMessageToSme, type SmeRouteDecision } from '~/lib/orchestrator/sme-routing';

import {
  getExistingResultItemIds,
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  insertTestResultItems,
  sumResultItemsElapsedMsByResultId,
  updateTestRecord,
  updateTestResult,
} from './repository';
import type { CriteriaGradingOutcome } from './criteria-schemas';
import { analyzeAndPersistFailureRootCause } from './failure-root-cause';
import { generateReport } from './report/orchestrator';
import { runSingleTestItem } from './runner';
import { generateAndSaveRunInsights } from './run-insights';
import {
  buildRoutingComparisonFields,
  normalizeKeywordRoute,
  resolveIntendedAgentLabel,
  type RoutingComparisonFields,
} from './routing-comparison';
import { isTerminalRunStatus } from './types';
import type { NewTestResultItemRecord, TestItemRecord, TestRecord } from './types';

/**
 * B0-501 — runs BOTH the keyword router (`routeUserMessageToSme`) and the LLM intent classifier
 * (`classifyUserIntent`) for a chat-style eval item, purely for instrumentation: neither call
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
 */
async function computeRoutingComparisonForItem(
  item: TestItemRecord,
  test: TestRecord,
): Promise<RoutingComparisonFields> {
  const intendedAgentLabel = resolveIntendedAgentLabel({
    itemIntendedAgent: item.intended_agent_item,
    testIntendedAgent: test.intended_agent,
  });

  const keywordStartedAt = performance.now();
  const keywordDecision: SmeRouteDecision = routeUserMessageToSme(item.prompt);
  const keywordRouteLatencyMs = Math.round(performance.now() - keywordStartedAt);

  let llmClassification: Pick<IntentClassification, 'intent' | 'confidence'>;
  const llmStartedAt = performance.now();
  try {
    llmClassification = await classifyUserIntent(item.prompt, []);
  } catch (error) {
    logWarn('test_run_dual_router_llm_classification_failed', {
      testItemId: item.id,
      message: error instanceof Error ? error.message : String(error),
    });
    llmClassification = {
      intent: normalizeKeywordRoute(keywordDecision),
      confidence: keywordDecision.agent ? 0.5 : 0,
    };
  }
  // B0-524 — measured even on the fallback path above: a fast keyword-fallback is still a real,
  // informative latency sample, not a missing one (only a thrown-before-start case has no timing).
  const llmRouteLatencyMs = Math.round(performance.now() - llmStartedAt);

  return buildRoutingComparisonFields({
    keywordDecision,
    llmClassification,
    intendedAgentLabel,
    keywordRouteLatencyMs,
    llmRouteLatencyMs,
  });
}

function asSummaryObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

export async function executeTestRun(testResultId: string) {
  const testResult = await getTestResultById(testResultId);

  if (isTerminalRunStatus(testResult.status) || testResult.status === 'paused') {
    return;
  }

  const items = await getTestItemsByTestId(testResult.test_id);
  // B0-501 — fetched once per run (not per item): `tests.intended_agent` is the suite-level
  // ground-truth fallback `resolveIntendedAgentLabel` uses when a row has no `intended_agent_item`.
  const test = await getTestById(testResult.test_id);
  const runOptions = asSummaryObject(testResult.run_options);
  const modelTag =
    typeof runOptions.modelTag === 'string' && runOptions.modelTag.trim()
      ? runOptions.modelTag.trim()
      : undefined;
  // B0-600 / B0-603 — opt-in validator pass, read from the same run_options blob as modelTag.
  const useValidator = runOptions.useValidator === true;
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
      await updateTestRecord(testResult.test_id, {
        status: 'ready',
      });
      return;
    }

    if (isTerminalRunStatus(controlRun.status)) {
      await updateTestRecord(testResult.test_id, {
        status: 'ready',
      });
      return;
    }

    const itemResult = await runSingleTestItem(testResult.id, item, {
      modelTag,
      useValidator,
    });
    // B0-501 — dual-router instrumentation, independent of the answer `runSingleTestItem` already
    // produced above: never changes `itemResult.item`'s pass/fail or response fields, only adds the
    // B0-500 comparison columns before the single insert below.
    const routingComparisonFields = await computeRoutingComparisonForItem(item, test);
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
    if (!itemResult.passed && insertedItem) {
      const payload = insertedItem.response_payload as { criteriaGrading?: CriteriaGradingOutcome } | null;
      await analyzeAndPersistFailureRootCause({
        testResultItemId: insertedItem.id,
        testName: test.name,
        prompt: item.prompt,
        expectedShouldAnswer: item.expected_should_answer,
        responseText: insertedItem.response_text,
        errorMessage: insertedItem.error_message,
        criteriaGrading: payload?.criteriaGrading ?? null,
        modelTag,
      });
    }

    itemElapsedSumMs += itemResult.item.elapsed_ms;

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
  // can show "View report" without anyone clicking "Generate report" first. Scheduled via
  // `after()` (not awaited inline) because `generateReport` can take minutes on large runs and
  // this function is called from a route that shares its own `maxDuration = 300` budget with the
  // run execution itself; `generateReport` is checkpointed/resumable via `report_state`, so a
  // background run that gets cut off (or errors) is picked up again by the report page's own
  // auto-continue POSTs. Best-effort: never let a report failure affect the run's own success.
  after(async () => {
    try {
      await generateReport(testResult.id);
    } catch (error) {
      logWarn('test_run_report_auto_generate_error', {
        testResultId: testResult.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
}
