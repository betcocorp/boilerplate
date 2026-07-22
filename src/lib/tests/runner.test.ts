import { describe, expect, it } from 'vitest';

import { gradeChatTestResponse } from './runner';
import type { TestItemRecord } from './types';

/** Minimal item factory — the grader only reads these two expectation fields. */
function item(
  overrides: Partial<TestItemRecord> = {},
): TestItemRecord {
  return {
    expected_should_answer: true,
    expected_result_type: null,
    ...overrides,
  } as TestItemRecord;
}

describe('gradeChatTestResponse', () => {
  it('fails a positive row when the assistant declines with "don\'t have the verified information" phrasing', () => {
    // Regression: this exact response was previously scored Passed because the fixed substring
    // list ("don't have verified") missed the inserted "the".
    const responseText =
      "I don't have the verified information on the required wet contact time for disinfection " +
      'with GE Fight Bac RTU. For accurate and safe usage, please refer to the product label ' +
      'or official Betco documentation.';

    const outcome = gradeChatTestResponse({
      item: item({ expected_should_answer: true }),
      hasError: false,
      responseText,
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.failureReason).toBeTruthy();
  });

  it('passes a positive row for a genuine substantive answer', () => {
    const responseText =
      'GE Fight Bac RTU must remain visibly wet on the surface for at least 60 seconds to disinfect.';

    const outcome = gradeChatTestResponse({
      item: item({ expected_should_answer: true }),
      hasError: false,
      responseText,
    });

    expect(outcome.passed).toBe(true);
  });

  it('does not misclassify a real answer that merely cites the label as a decline', () => {
    const responseText =
      'Per the product label, dilute at 2 oz per gallon; refer to the product label for the full directions.';

    const outcome = gradeChatTestResponse({
      item: item({ expected_should_answer: true }),
      hasError: false,
      responseText,
    });

    expect(outcome.passed).toBe(true);
  });

  it('fails a positive row on an empty response', () => {
    const outcome = gradeChatTestResponse({
      item: item({ expected_should_answer: true }),
      hasError: false,
      responseText: '   ',
    });

    expect(outcome.passed).toBe(false);
  });

  it('passes a negative row when the assistant declines', () => {
    const outcome = gradeChatTestResponse({
      item: item({
        expected_should_answer: false,
        expected_result_type: 'decline',
      }),
      hasError: false,
      responseText: "I don't have the verified information needed to answer that.",
    });

    expect(outcome.passed).toBe(true);
  });
});
