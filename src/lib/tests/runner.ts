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
import { buildExpectedCriteria } from './criteria-schemas';
import { gradeSemanticDecline } from './decline-grader';
import {
  gradeChatTestResponse,
  gradeChatTestResponseAsync,
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
import { classifyProviderFault, type ProviderFaultKind } from './provider-fault';
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
  gradeChatTestResponseAsync,
  responseIndicatesDeclineStyleAnswer,
  responseIndicatesUnableToAssistOrRefusal,
  UNABLE_TO_ASSIST_FAILURE_REASON,
};
export type { EvaluationOutcome, GradableExpectations };

type RunSingleItemResult = {
  item: NewTestResultItemRecord;
  passed: boolean;
  /**
   * B0-1014 — non-null when the item never got an answer because the model provider refused the
   * request (out of credits, bad key, rate limit, outage). Mirrors `item.provider_fault`, returned
   * separately so `run-executor.ts` can count a fault streak without re-parsing the record.
   */
  providerFault?: ProviderFaultKind | null;
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
      // An authoring mistake, never an infrastructure fault — the provider was never called.
      providerFault: null,
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
     * B0-932 — the item's three concept columns ARE the criteria: `minimum_concepts` become
     * tier-1 (a miss fails the item) and `expected_concepts` tier-2, deduped
     * by concept identity so a phrase in both the mandatory and expected sets is scored once.
     * `gradeWithCriteria` judges each phrase; `gradeChatTestResponse` turns that verdict into the
     * item's pass/fail alongside the error/emptiness gate and the decline visibility override.
     */
    const criteria = buildExpectedCriteria({
      minimumConcepts: testItem.minimum_concepts,
      expectedConcepts: testItem.expected_concepts,
    });
    const criteriaOutcome = await gradeWithCriteria({
      prompt: testItem.prompt,
      responseText,
      criteria,
      modelTag: options?.modelTag,
    }).catch(() => null);

    /**
     * B0-755/932 — the async superset only matters when the item declares mandatory concepts but
     * `gradeWithCriteria` produced no verdict at all (it threw). Then, and only then, the LLM
     * semantic-decline grader gets a last look, with the mandatory concepts as its description of
     * what a correct refusal says. Every other item is decided synchronously above.
     */
    const outcome = await gradeChatTestResponseAsync({
      item: testItem,
      hasError: false,
      responseText,
      conceptGrading: criteriaOutcome,
      context: {
        prompt: testItem.prompt,
        idealResponse: testItem.ideal_response,
        expectedConcepts: testItem.expected_concepts,
        minimumConcepts: testItem.minimum_concepts,
      },
      checkSemanticDecline: gradeSemanticDecline,
    });

    // Loose `any` (matching the original `JSON.parse(JSON.stringify(result))` call this
    // replaces) — `response_payload` is `Json`, and threading a precise type through would
    // require re-declaring `result`'s entire shape as JSON-safe for no real benefit here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const responsePayload: any = JSON.parse(JSON.stringify(result));
    if (criteriaOutcome) {
      responsePayload.criteriaGrading = criteriaOutcome;
    }
    if ('semanticDeclineCheck' in outcome && outcome.semanticDeclineCheck) {
      responsePayload.semanticDeclineGrading = outcome.semanticDeclineCheck;
    }
    // B0-902 — the LLM decline check was needed but could not run (refusal/truncation/transport);
    // persisted so the row reads "unable to evaluate", not "the model said this was an answer".
    if ('semanticDeclineUnavailable' in outcome && outcome.semanticDeclineUnavailable) {
      responsePayload.semanticDeclineUnavailable = outcome.semanticDeclineUnavailable;
    }

    return {
      passed: outcome.passed,
      // The provider answered, so whatever the verdict is, it is a real quality verdict.
      providerFault: null,
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
    /**
     * B0-1014 — additive ONLY. `passed`, `status` and `error_message` are deliberately unchanged:
     * a provider refusal is still a failed item, it is just now labelled as an infrastructure
     * fault rather than being indistinguishable from a wrong answer.
     */
    const providerFault = classifyProviderFault(error);

    return {
      passed: false,
      providerFault,
      item: {
        test_result_id: testResultId,
        test_item_id: testItem.id,
        row_index: testItem.row_index,
        elapsed_ms: elapsedMs,
        ttft_ms: firstDeltaAt !== null ? Math.max(0, firstDeltaAt - startedAt) : null,
        status: 'failed',
        passed: false,
        error_message: message,
        provider_fault: providerFault,
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
  /** B0-1014 — the fault kind of the turn that killed the replay, if the provider refused it. */
  let fatalProviderFault: ProviderFaultKind | null = null;

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

      /**
       * B0-932 — this turn's own concept expectations are judged the same way an item's are:
       * `minimum_concepts` → tier 1, `expected_concepts` → tier 2, judged by `gradeWithCriteria`.
       * It happens here rather than in `evaluateMultiTurnScenario` because that evaluator is pure
       * and this is a model call; the verdict rides on the executed turn.
       */
      const turnResponseText = result.answerText || '';
      const turnCriteria = buildExpectedCriteria({
        minimumConcepts: turn.expectations?.minimum_concepts,
        expectedConcepts: turn.expectations?.expected_concepts,
      });
      const turnConceptGrading = await gradeWithCriteria({
        prompt: turn.prompt,
        responseText: turnResponseText,
        criteria: turnCriteria,
        modelTag: options?.modelTag,
      }).catch(() => null);

      executedTurns.push({
        turnIndex,
        prompt: turn.prompt,
        responseText: turnResponseText,
        hasError: false,
        errorMessage: null,
        elapsedMs: Math.max(0, Date.now() - turnStartedAt),
        ttftMs,
        conversationId: result.conversationId,
        workflowRunId: result.workflowRunId ?? null,
        conceptGrading: turnConceptGrading,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown multi-turn test item run failure.';
      fatalError = `Turn ${turnIndex} failed: ${message}`;
      // B0-1014 — a refused turn stops the replay for an infrastructure reason, not a behavioural
      // one; recorded so the scenario row reads as a provider fault rather than a failed scenario.
      fatalProviderFault = classifyProviderFault(error);
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
   * A multi-turn row that ALSO carries item-level concepts is graded by BOTH: the item's criteria
   * are applied to the FINAL turn's answer (the turn the scenario is driving toward) and folded in
   * as an additional required check, so concepts authored on a scenario row can't silently do
   * nothing. Rows without any concepts are unaffected — `gradeWithCriteria` returns null.
   */
  const finalTurn = executedTurns.find((turn) => turn.turnIndex === scenario.turns.length);
  const criteria = buildExpectedCriteria({
    minimumConcepts: testItem.minimum_concepts,
    expectedConcepts: testItem.expected_concepts,
  });
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
        ? (criteriaOutcome.failureReason ??
          "The item's mandatory concepts were not covered by the final turn.")
        : null,
    ]
      .filter(Boolean)
      .join(' ') || null;

  return {
    passed,
    providerFault: fatalProviderFault,
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
      // B0-1014 — additive: status/passed/error_message above are untouched.
      provider_fault: fatalProviderFault,
      response_text: finalTurn?.responseText || executedTurns.at(-1)?.responseText || null,
      response_payload: responsePayload,
      // The FINAL turn's workflow run, matching which turn's result the rest of the payload holds.
      workflow_run_id: lastResult?.workflowRunId ?? null,
      app_version: APP_VERSION,
    },
  };
}
