import { runBexChatTurn } from '~/lib/bex/run-chat-turn';

import type { NewTestResultItemRecord, TestItemRecord } from './types';

type RunSingleItemResult = {
  item: NewTestResultItemRecord;
  passed: boolean;
};

function shouldExpectAnswer(item: TestItemRecord) {
  return item.expected_should_answer;
}

type EvaluationOutcome = {
  passed: boolean;
  /** Human-readable explanation when `passed` is false (stored on `error_message`). */
  failureReason: string | null;
};

/**
 * Same pass/fail rules as the historical boolean helper; adds `failureReason` for failed assertions.
 */
function evaluateTestOutcome(params: {
  item: TestItemRecord;
  hasError: boolean;
  responseText: string;
}): EvaluationOutcome {
  const expectedShouldAnswer = shouldExpectAnswer(params.item);
  const expectedResultType = (params.item.expected_result_type || '')
    .trim()
    .toLowerCase();

  const hasResponse = !params.hasError && params.responseText.trim().length > 0;

  if (expectedShouldAnswer === null) {
    const passed = !params.hasError;
    return {
      passed,
      failureReason: passed
        ? null
        : 'This row has no expectation (expected_should_answer is null) but the run reported an error before a final answer.',
    };
  }

  if (expectedShouldAnswer === true) {
    if (hasResponse) {
      return { passed: true, failureReason: null };
    }
    return {
      passed: false,
      failureReason:
        'This row expects an assistant answer (expected_should_answer = true) but the response text was empty.',
    };
  }

  if (expectedShouldAnswer === false) {
    if (!hasResponse) {
      return { passed: true, failureReason: null };
    }

    if (expectedResultType === 'decline' || expectedResultType === 'none') {
      const lowered = params.responseText.toLowerCase();
      const declined = lowered.includes("can't") || lowered.includes('cannot');
      if (declined) {
        return { passed: true, failureReason: null };
      }
      return {
        passed: false,
        failureReason: `This row expects a decline-style answer (expected_result_type "${expectedResultType}") containing "can't" or "cannot"; the response did not include those phrases.`,
      };
    }

    return {
      passed: false,
      failureReason:
        'This row expects no assistant answer (expected_should_answer = false) but the model returned a non-empty response.',
    };
  }

  return {
    passed: false,
    failureReason:
      'expected_should_answer is not true, false, or null, so this item cannot be evaluated with the current rules.',
  };
}

export async function runSingleTestItem(
  testResultId: string,
  testItem: TestItemRecord,
): Promise<RunSingleItemResult> {
  const startedAt = Date.now();

  try {
    // Use the same path as BEX chat so test runs reflect real workflow behavior.
    const result = await runBexChatTurn({
      conversationId: null,
      message: testItem.prompt,
      useValidator: false,
      agentMode: 'orchestrator',
    });

    const elapsedMs = Math.max(0, Date.now() - startedAt);
    const responseText = result.answerText || '';
    const outcome = evaluateTestOutcome({
      item: testItem,
      hasError: false,
      responseText,
    });

    return {
      passed: outcome.passed,
      item: {
        test_result_id: testResultId,
        test_item_id: testItem.id,
        row_index: testItem.row_index,
        elapsed_ms: elapsedMs,
        status: 'completed',
        passed: outcome.passed,
        error_message: outcome.passed ? null : outcome.failureReason,
        response_text: responseText,
        response_payload: JSON.parse(JSON.stringify(result)),
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
        status: 'failed',
        passed: false,
        error_message: message,
        response_text: null,
        response_payload: null,
      },
    };
  }
}
