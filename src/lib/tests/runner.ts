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

const UNABLE_TO_ASSIST_FAILURE_REASON =
  'The assistant indicated it could not answer (e.g. no verified information, could not find a hazard, or cannot provide). Marked failed so you can review and investigate.';

/**
 * Declines, hedges, and “no answer” phrasing — treated as **failed** outcomes for visibility,
 * even when row expectations would otherwise accept a short decline.
 */
function responseIndicatesUnableToAssistOrRefusal(responseText: string): boolean {
  const t = responseText.trim().toLowerCase();
  if (!t) {
    return false;
  }

  const phrases = [
    "can't provide",
    'cannot provide',
    'unable to provide',
    'not able to provide',
    "couldn't provide",
    'could not provide',
    "i can't",
    'i cannot',
    "can't find",
    'cannot find',
    'could not find',
    "couldn't find",
    'unable to find',
    'unable to retrieve',
    "don't have verified",
    'do not have verified',
    'verified first-aid',
    'verified first aid',
    'could not find specific',
    "couldn't find specific",
    'cannot find specific',
    "can't find specific",
    'insufficient information',
    'not sufficient information',
    "don't have that information",
    'do not have that information',
    'unable to locate',
    'could not locate',
    // Clarification-seeking responses — the model is asking for more info instead of answering.
    // For expected_should_answer=true items these are failures, not passes.
    'need a bit more detail',
    'need more detail',
    'need more specific',
    'need more information to',
    'do not have enough retrieved',
    'not have enough retrieved',
    'what i still need',
    'what i need to answer',
    'currently unable to retrieve',
    // Tool failure / technical issue patterns — model acknowledged it could not retrieve docs
    'i encountered a technical issue',
    'encountered a technical issue',
    "i'm unable to provide a verified answer",
    'i am unable to provide a verified answer',
    'unable to provide a verified answer',
    "i'm unable to respond with an answer",
    'i am unable to respond with an answer',
    'unable to respond with an answer',
    'unable to respond with a verified',
    // Canonical normalized decline phrase used across all agents
    "i don't have the information needed",
    'i do not have the information needed',
    "don't have the information needed",
    'do not have the information needed',
    // Scope gate phrase — agent rejected an in-scope question by treating it as out-of-scope
    "i'm not able to help with that topic",
    'i am not able to help with that topic',
    'not able to help with that topic',
    // Guessing / speculation patterns — agent speculated instead of declining
    'experiencing difficulty retrieving',
    'difficulty retrieving',
    'betco typically offers',
    'betco typically provides',
    'would you like me to attempt another search',
    'would you like to attempt another search',
    'i can try again to find',
    'you may consult with a betco',
    'consult with a betco sales representative',
  ];

  return phrases.some((p) => t.includes(p));
}

/**
 * True when the assistant is clearly declining, hedging, or refusing to confirm — beyond only
 * "can't"/"cannot" (e.g. "don't have verified information", "unable to verify").
 */
function responseIndicatesDeclineStyleAnswer(responseText: string): boolean {
  const t = responseText.trim().toLowerCase();
  if (!t) {
    return false;
  }

  const indicators = [
    "can't",
    'cannot',
    "don't have verified",
    'do not have verified',
    'no verified information',
    "don't have that information",
    'do not have that information',
    'insufficient information',
    'not sufficient information',
    'unable to verify',
    'unable to confirm',
    'unable to provide',
    'unable to locate',
    'could not verify',
    "couldn't verify",
    'could not find',
    "couldn't find",
    'cannot find',
    "can't find",
    'unable to find',
    'not able to verify',
    'cannot determine',
    "can't determine",
    'outside the scope',
    'outside of the scope',
    "i'm sorry, but that topic",
    'that topic is outside',
    // Soft redirects — model refuses to answer and points elsewhere
    'you might want to consult',
    'i recommend consulting',
    'i would recommend consulting',
    'you may want to consult',
    'i suggest consulting',
    'recommend reaching out to',
    'i focus on providing information about betco',
    "i'm here to provide information and support related to betco",
    // Tool failure acknowledgements
    'i encountered a technical issue',
    'encountered a technical issue',
    'unable to provide a verified answer',
    'unable to respond with an answer',
    'unable to respond with a verified',
    // Canonical normalized decline phrase used across all agents
    "i don't have the information needed",
    'i do not have the information needed',
    "don't have the information needed",
    'do not have the information needed',
    // Scope gate phrase
    "i'm not able to help with that topic",
    'i am not able to help with that topic',
    'not able to help with that topic',
  ];

  return indicators.some((p) => t.includes(p));
}

/** Rows configured for decline-style expectations should not be failed by the "unable to assist" visibility override. */
function expectsDeclineStyleOutcome(item: TestItemRecord): boolean {
  if (shouldExpectAnswer(item) !== false) {
    return false;
  }
  const expectedResultType = (item.expected_result_type || '').trim().toLowerCase();
  return expectedResultType === 'decline' || expectedResultType === 'none';
}

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

    // A proper decline is always a pass for negative tests, regardless of expected_result_type.
    if (responseIndicatesDeclineStyleAnswer(params.responseText)) {
      return { passed: true, failureReason: null };
    }

    if (expectedResultType === 'decline' || expectedResultType === 'none') {
      return {
        passed: false,
        failureReason: `This row expects a decline-style answer (expected_result_type "${expectedResultType}") — e.g. inability to verify, no verified information, or phrasing with "can't"/"cannot" or "outside the scope"; the response did not match decline-style criteria.`,
      };
    }

    return {
      passed: false,
      failureReason:
        'This row expects no assistant answer (expected_should_answer = false) but the model returned a non-empty response without a recognizable decline.',
    };
  }

  return {
    passed: false,
    failureReason:
      'expected_should_answer is not true, false, or null, so this item cannot be evaluated with the current rules.',
  };
}

function withUnableToAssistFailureOverride(
  responseText: string,
  outcome: EvaluationOutcome,
  item: TestItemRecord,
): EvaluationOutcome {
  const hasText = responseText.trim().length > 0;
  if (!hasText || !outcome.passed) {
    return outcome;
  }

  if (expectsDeclineStyleOutcome(item)) {
    return outcome;
  }

  if (!responseIndicatesUnableToAssistOrRefusal(responseText)) {
    return outcome;
  }

  return {
    passed: false,
    failureReason: UNABLE_TO_ASSIST_FAILURE_REASON,
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
    const baseOutcome = evaluateTestOutcome({
      item: testItem,
      hasError: false,
      responseText,
    });
    const outcome = withUnableToAssistFailureOverride(
      responseText,
      baseOutcome,
      testItem,
    );

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
