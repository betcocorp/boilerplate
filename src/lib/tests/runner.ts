import { runBexChatTurn } from '~/lib/bex/run-chat-turn';
import {
  DEFAULT_BEX_CHAT_AGENT_MODE,
  type BexChatAgentMode,
} from '~/lib/agents/agent-registry';
import { APP_VERSION } from '~/lib/app-version';
import {
  resolveHistoryMaxMessages,
  type RouterTypeOverride,
} from '~/lib/workflows/product-support/run-product-support-workflow';

import { gradeWithCriteria } from './criteria-grader';
import { expectedCriteriaSchema } from './criteria-schemas';
import {
  gradeChatTestResponse,
  responseIndicatesDeclineStyleAnswer,
  responseIndicatesUnableToAssistOrRefusal,
  UNABLE_TO_ASSIST_FAILURE_REASON,
  type EvaluationOutcome,
  type GradableExpectations,
} from './grading';
import {
  evaluateMultiTurnScenario,
  type ExecutedTurn,
} from './multi-turn-evaluator';
import {
  MULTI_TURN_RESULT_PAYLOAD_KEY,
  type MultiTurnResultPayload,
} from './multi-turn-result';
import { parseMultiTurnFromInputPayload, type MultiTurnScenario } from './multi-turn';
import type { NewTestResultItemRecord, TestItemRecord } from './types';

/**
 * B0-537 — the response-grading layer that used to live inline here now lives in `./grading` (pure,
 * workflow-free) so the multi-turn evaluator can reuse per-turn grading without importing this
 * module and its live workflow/conversation stack. These re-exports are the ONLY definition path:
 * the byte-identical duplicate that shipped alongside `grading.ts` (which the commit that added it
 * claimed to have removed, but did not) has been deleted, so there is exactly one copy of the
 * decline heuristics again.
 */
export {
  gradeChatTestResponse,
  responseIndicatesDeclineStyleAnswer,
  responseIndicatesUnableToAssistOrRefusal,
  UNABLE_TO_ASSIST_FAILURE_REASON,
};
export type { EvaluationOutcome, GradableExpectations };

type RunSingleItemResult = {
  item: NewTestResultItemRecord;
  passed: boolean;
};

type RunItemOptions = {
  modelTag?: string;
  useValidator?: boolean;
  /**
   * B0-351 — the specialist this run forces every turn onto, from
   * `test_results.run_options.agentMode`. Omitted (and every run created before this ticket)
   * means `orchestrator`, which is exactly what was hardcoded here before, so historical
   * behaviour is unchanged.
   */
  agentMode?: BexChatAgentMode;
  testName?: string | null;
  routerTypeOverride?: RouterTypeOverride;
};

/**
 * B0-537 — the pass/fail entry point for one `test_items` row, unchanged for every single-turn row.
 *
 * Dispatch only: rows whose `input_payload.multi_turn` is absent (the entire pre-B0-537 corpus) go
 * to `runSingleTurnTestItem`, which is the original function verbatim, so single-turn behaviour is
 * byte-identical. Rows carrying a valid scenario go to `runMultiTurnTestItem`; rows carrying an
 * INVALID one fail immediately with the parse message and cost nothing, rather than silently
 * running as single-turn and hiding an authoring mistake.
 */
export async function runSingleTestItem(
  testResultId: string,
  testItem: TestItemRecord,
  options?: RunItemOptions,
): Promise<RunSingleItemResult> {
  const parsed = parseMultiTurnFromInputPayload(testItem.input_payload);

  if (parsed.kind === 'multi_turn') {
    return runMultiTurnTestItem(testResultId, testItem, parsed.scenario, options);
  }

  if (parsed.kind === 'invalid') {
    return {
      passed: false,
      item: {
        test_result_id: testResultId,
        test_item_id: testItem.id,
        row_index: testItem.row_index,
        elapsed_ms: 0,
        ttft_ms: null,
        status: 'failed',
        passed: false,
        error_message: parsed.message,
        response_text: null,
        response_payload: null,
        app_version: APP_VERSION,
      },
    };
  }

  return runSingleTurnTestItem(testResultId, testItem, options);
}

async function runSingleTurnTestItem(
  testResultId: string,
  testItem: TestItemRecord,
  options?: RunItemOptions,
): Promise<RunSingleItemResult> {
  const startedAt = Date.now();
  let firstDeltaAt: number | null = null;

  try {
    // Use the same path as BEX chat so test runs reflect real workflow behavior.
    const result = await runBexChatTurn({
      conversationId: null,
      message: testItem.prompt,
      source: 'harness',
      modelTag: options?.modelTag,
      /**
       * B0-600 / B0-603 — the validator pass used to be hard-off for every harness run, which made
       * the Phase 1 "Use Validator: true" A/B test impossible to actually configure. Now opt-in per
       * run via `test_results.run_options.useValidator`; still defaults to false so existing suites
       * keep their current cost and behaviour.
       */
      useValidator: options?.useValidator ?? false,
      // B0-351 — was hardcoded `'orchestrator'`; now per-run, defaulting to the same value.
      agentMode: options?.agentMode ?? DEFAULT_BEX_CHAT_AGENT_MODE,
      routerTypeOverride: options?.routerTypeOverride,
      // B0-450: eval-harness conversations are never attributed to whoever kicked off the run.
      owner: { kind: 'system' },
      // B0-645: stamps the source test's name onto the conversation so the admin sidebar shows
      // which test produced it instead of a generic "Admin" badge.
      testName: options?.testName,
      onAssistantDelta: () => {
        if (firstDeltaAt === null) firstDeltaAt = Date.now();
      },
    });

    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const ttftMs = firstDeltaAt !== null ? Math.max(0, firstDeltaAt - startedAt) : null;
    const responseText = result.answerText || '';

    /**
     * B0-616 — when this item carries `expected_criteria`, per-criterion grading is the
     * pass/fail signal (tier-1-must-all-pass), not the legacy behavior-only heuristic below.
     * Items without criteria are completely unaffected — `gradeWithCriteria` returns `null`
     * and `gradeChatTestResponse` decides, exactly as before (zero migration required).
     */
    const parsedCriteria = expectedCriteriaSchema.safeParse(testItem.expected_criteria);
    const criteria = parsedCriteria.success ? parsedCriteria.data : [];
    const criteriaOutcome = await gradeWithCriteria({
      prompt: testItem.prompt,
      responseText,
      criteria,
      modelTag: options?.modelTag,
    }).catch(() => null);

    const outcome =
      criteriaOutcome ??
      gradeChatTestResponse({
        item: testItem,
        hasError: false,
        responseText,
      });

    // Loose `any` (matching the original `JSON.parse(JSON.stringify(result))` call this
    // replaces) — `response_payload` is `Json`, and threading a precise type through would
    // require re-declaring `result`'s entire shape as JSON-safe for no real benefit here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const responsePayload: any = JSON.parse(JSON.stringify(result));
    if (criteriaOutcome) {
      responsePayload.criteriaGrading = criteriaOutcome;
    }

    return {
      passed: outcome.passed,
      item: {
        test_result_id: testResultId,
        test_item_id: testItem.id,
        row_index: testItem.row_index,
        elapsed_ms: elapsedMs,
        ttft_ms: ttftMs,
        status: 'completed',
        passed: outcome.passed,
        error_message: outcome.passed ? null : outcome.failureReason,
        response_text: responseText,
        response_payload: responsePayload,
        // B0-416 — real FK alongside the payload copy, so the trace stays reachable from the
        // graded item (and vice versa) without parsing JSON.
        workflow_run_id: result.workflowRunId,
        app_version: APP_VERSION,
      },
    };
  } catch (error) {
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const message = error instanceof Error ? error.message : 'Unknown test item run failure.';

    return {
      passed: false,
      item: {
        test_result_id: testResultId,
        test_item_id: testItem.id,
        row_index: testItem.row_index,
        elapsed_ms: elapsedMs,
        ttft_ms: firstDeltaAt !== null ? Math.max(0, firstDeltaAt - startedAt) : null,
        status: 'failed',
        passed: false,
        error_message: message,
        response_text: null,
        response_payload: null,
        app_version: APP_VERSION,
      },
    };
  }
}

/**
 * B0-537 — replays an ordered multi-turn scenario against the real chat path.
 *
 * The execution primitive needed no change: `runBexChatTurn` derives history from the DB and
 * RETURNS the `conversationId` it used, so multi-turn execution is simply feeding turn N's returned
 * conversation id back in as turn N+1's. Turn 1 passes `conversationId: null` (identical to the
 * single-turn path) and therefore creates the conversation, stamped with the same
 * `owner: { kind: 'system' }` / `testName` as before.
 *
 * A turn that throws stops the replay: the remaining turns would run without the context the
 * scenario is testing, so continuing would produce misleading verdicts rather than more data. The
 * partial run is still graded and persisted, and `summary.executedTurnCount` records the truncation.
 */
async function runMultiTurnTestItem(
  testResultId: string,
  testItem: TestItemRecord,
  scenario: MultiTurnScenario,
  options?: RunItemOptions,
): Promise<RunSingleItemResult> {
  const scenarioStartedAt = Date.now();
  const executedTurns: ExecutedTurn[] = [];
  let conversationId: string | null = null;
  let lastResult: Awaited<ReturnType<typeof runBexChatTurn>> | null = null;
  let firstTurnTtftMs: number | null = null;
  let fatalError: string | null = null;

  for (const [zeroBasedIndex, turn] of scenario.turns.entries()) {
    const turnIndex = zeroBasedIndex + 1;
    const turnStartedAt = Date.now();
    let firstDeltaAt: number | null = null;

    try {
      const result = await runBexChatTurn({
        // The whole point: turn 1 creates the conversation, every later turn resumes it, so
        // `listMessagesForConversation` hands the workflow the real prior turns as `priorMessages`.
        conversationId,
        message: turn.prompt,
        source: 'harness',
        modelTag: options?.modelTag,
        useValidator: options?.useValidator ?? false,
        // B0-351 — same per-run agent mode as the single-turn path; every turn of a scenario runs
        // under it, so a multi-turn run cannot drift between specialists mid-conversation.
        agentMode: options?.agentMode ?? DEFAULT_BEX_CHAT_AGENT_MODE,
        routerTypeOverride: options?.routerTypeOverride,
        owner: { kind: 'system' },
        testName: options?.testName,
        onAssistantDelta: () => {
          if (firstDeltaAt === null) firstDeltaAt = Date.now();
        },
      });

      conversationId = result.conversationId;
      lastResult = result;

      const ttftMs = firstDeltaAt !== null ? Math.max(0, firstDeltaAt - turnStartedAt) : null;
      if (turnIndex === 1) {
        firstTurnTtftMs = ttftMs;
      }

      executedTurns.push({
        turnIndex,
        prompt: turn.prompt,
        responseText: result.answerText || '',
        hasError: false,
        errorMessage: null,
        elapsedMs: Math.max(0, Date.now() - turnStartedAt),
        ttftMs,
        conversationId: result.conversationId,
        workflowRunId: result.workflowRunId ?? null,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown multi-turn test item run failure.';
      fatalError = `Turn ${turnIndex} failed: ${message}`;
      executedTurns.push({
        turnIndex,
        prompt: turn.prompt,
        responseText: '',
        hasError: true,
        errorMessage: message,
        elapsedMs: Math.max(0, Date.now() - turnStartedAt),
        ttftMs: firstDeltaAt !== null ? Math.max(0, firstDeltaAt - turnStartedAt) : null,
        conversationId,
        workflowRunId: null,
      });
      break;
    }
  }

  const evaluation = evaluateMultiTurnScenario({ scenario, turns: executedTurns });

  /**
   * A multi-turn row that ALSO carries `expected_criteria` is graded by BOTH: the criteria are
   * applied to the FINAL turn's answer (the turn the scenario is driving toward) and folded in as
   * an additional required check, so criteria authored on a scenario row can't silently do nothing.
   * Rows without criteria are unaffected — `gradeWithCriteria` returns null.
   */
  const finalTurn = executedTurns.find((turn) => turn.turnIndex === scenario.turns.length);
  const parsedCriteria = expectedCriteriaSchema.safeParse(testItem.expected_criteria);
  const criteria = parsedCriteria.success ? parsedCriteria.data : [];
  const criteriaOutcome =
    finalTurn && !finalTurn.hasError
      ? await gradeWithCriteria({
          prompt: finalTurn.prompt,
          responseText: finalTurn.responseText,
          criteria,
          modelTag: options?.modelTag,
        }).catch(() => null)
      : null;

  const passed = evaluation.passed && (criteriaOutcome?.passed ?? true);

  const elapsedMs = executedTurns.reduce(
    (sum, turn) => sum + (turn.elapsedMs ?? 0),
    0,
  ) || Math.max(0, Date.now() - scenarioStartedAt);

  const multiTurnPayload: MultiTurnResultPayload = {
    version: 1,
    scenarioId: scenario.scenario_id ?? null,
    title: scenario.title ?? null,
    passed: evaluation.passed,
    summary: evaluation.summary,
    turns: executedTurns.map((turn) => {
      const verdict = evaluation.turnVerdicts.find((v) => v.turnIndex === turn.turnIndex);
      return {
        turnIndex: turn.turnIndex,
        prompt: turn.prompt,
        responseText: turn.responseText,
        passed: verdict?.passed ?? false,
        failureReason: verdict?.failureReason ?? null,
        behaviorPassed: verdict?.behaviorPassed ?? false,
        declined: verdict?.declined ?? false,
        mustMention: verdict?.mustMention ?? [],
        mustNotMention: verdict?.mustNotMention ?? [],
        hasError: turn.hasError,
        errorMessage: turn.errorMessage ?? null,
        elapsedMs: turn.elapsedMs ?? null,
        ttftMs: turn.ttftMs ?? null,
        conversationId: turn.conversationId ?? null,
        workflowRunId: turn.workflowRunId ?? null,
      };
    }),
    assertions: evaluation.assertionVerdicts.map((verdict) => ({
      type: verdict.type,
      turns: verdict.turns,
      passed: verdict.passed,
      reason: verdict.reason,
      description: verdict.description,
      caveat: verdict.caveat,
      observed: verdict.observed,
    })),
    routingComparisonScope: 'first_turn_only',
    conversationId,
    /**
     * B0-519's `capConversationHistory` keeps only the last `BEX_HISTORY_MAX_MESSAGES` (default 12)
     * messages, and each turn contributes two (user + assistant). A scenario deeper than half that
     * cap loses its earliest turns from the model's view, which is exactly what a `context_carry`
     * from turn 1 asks about — flagged here so a failure can be read as a cap effect rather than a
     * model regression.
     */
    historyCapAtRisk: scenario.turns.length * 2 > resolveHistoryMaxMessages(),
  };

  // Loose `any` for the same reason as the single-turn path: `response_payload` is `Json`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const responsePayload: any = lastResult ? JSON.parse(JSON.stringify(lastResult)) : {};
  responsePayload[MULTI_TURN_RESULT_PAYLOAD_KEY] = JSON.parse(
    JSON.stringify(multiTurnPayload),
  );
  if (criteriaOutcome) {
    responsePayload.criteriaGrading = criteriaOutcome;
  }

  const failureReason =
    [
      fatalError,
      evaluation.failureReason,
      criteriaOutcome && !criteriaOutcome.passed
        ? 'Final-turn expected_criteria were not met.'
        : null,
    ]
      .filter(Boolean)
      .join(' ') || null;

  return {
    passed,
    item: {
      test_result_id: testResultId,
      test_item_id: testItem.id,
      row_index: testItem.row_index,
      // Scenario-level rollups (see the persistence note in ./multi-turn-result.ts): total wall
      // clock across every turn, and turn 1's time-to-first-token (the only one comparable with a
      // single-turn row's `ttft_ms`).
      elapsed_ms: elapsedMs,
      ttft_ms: firstTurnTtftMs,
      status: fatalError ? 'failed' : 'completed',
      passed,
      error_message: passed ? null : failureReason,
      response_text: finalTurn?.responseText || executedTurns.at(-1)?.responseText || null,
      response_payload: responsePayload,
      // The FINAL turn's workflow run, matching which turn's result the rest of the payload holds.
      workflow_run_id: lastResult?.workflowRunId ?? null,
      app_version: APP_VERSION,
    },
  };
}
