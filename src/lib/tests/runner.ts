import { runBexChatTurn } from '~/lib/bex/run-chat-turn';

import type { NewTestResultItemRecord, TestItemRecord } from './types';

type RunSingleItemResult = {
  item: NewTestResultItemRecord;
  passed: boolean;
};

function shouldExpectAnswer(item: TestItemRecord) {
  return item.expected_should_answer;
}

function evaluateResult(params: {
  item: TestItemRecord;
  hasError: boolean;
  responseText: string;
}) {
  const expectedShouldAnswer = shouldExpectAnswer(params.item);
  const expectedResultType = (params.item.expected_result_type || '')
    .trim()
    .toLowerCase();

  const hasResponse = !params.hasError && params.responseText.trim().length > 0;

  if (expectedShouldAnswer === null) {
    return !params.hasError;
  }

  if (expectedShouldAnswer === true) {
    return hasResponse;
  }

  if (expectedShouldAnswer === false) {
    if (!hasResponse) {
      return true;
    }

    if (expectedResultType === 'decline' || expectedResultType === 'none') {
      const lowered = params.responseText.toLowerCase();
      return lowered.includes("can't") || lowered.includes('cannot');
    }

    return false;
  }

  return false;
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
    const passed = evaluateResult({
      item: testItem,
      hasError: false,
      responseText,
    });

    return {
      passed,
      item: {
        test_result_id: testResultId,
        test_item_id: testItem.id,
        row_index: testItem.row_index,
        elapsed_ms: elapsedMs,
        status: 'completed',
        passed,
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
