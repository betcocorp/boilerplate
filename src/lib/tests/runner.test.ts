import { describe, expect, it } from 'vitest';

import { gradeChatTestResponse as gradeFromGradingModule } from './grading';
import { parseMultiTurnFromInputPayload } from './multi-turn';
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

  describe('B0-300 follow-up — canonical "no confident equivalent" decline copy', () => {
    // Both are the exact response texts from the B0-97 "No-Equivalent Probes" eval run that
    // prompted this fix: XREF_DECLINE_COPY (product/cross-reference agent) matched none of the
    // existing keyword/regex patterns and was failing a negative row despite being a correct decline.
    const xrefDeclineCopyResponse =
      "I couldn't confidently identify a Betco equivalent for this product. A Betco sales representative can help identify the right match — please reach out to your rep.";
    const recommendationsDeclineCopyResponse =
      "I'm sorry, but I don't have enough information to provide that answer. Please contact a Betco sales representative directly.";

    it('passes a negative row when the product agent returns XREF_DECLINE_COPY verbatim', () => {
      const outcome = gradeChatTestResponse({
        item: item({ expected_should_answer: false, expected_result_type: 'decline' }),
        hasError: false,
        responseText: xrefDeclineCopyResponse,
      });

      expect(outcome.passed).toBe(true);
    });

    it('passes a negative row when the recommendations agent returns its canonical decline copy verbatim', () => {
      const outcome = gradeChatTestResponse({
        item: item({ expected_should_answer: false, expected_result_type: 'decline' }),
        hasError: false,
        responseText: recommendationsDeclineCopyResponse,
      });

      expect(outcome.passed).toBe(true);
    });
  });

  describe('B0-518 — early-decline gate copy and the missing expected_result_type tag', () => {
    // Regression: the "Product Golden Test Set" run (6203d34f-…) showed 0/13 early-decline rows
    // passing — all 199 rows in that set have expected_result_type = null (like every other
    // negative-expectation row in the database), which used to defeat the "unable to assist"
    // override's exemption entirely.
    it('passes a negative row with NO expected_result_type when the assistant declines', () => {
      const outcome = gradeChatTestResponse({
        item: item({ expected_should_answer: false, expected_result_type: null }),
        hasError: false,
        responseText: "I don't have the verified information needed to answer that.",
      });

      expect(outcome.passed).toBe(true);
    });

    it('recognizes the chemical-mixing early-decline copy verbatim ("advise" is not in the decline vocabulary)', () => {
      const outcome = gradeChatTestResponse({
        item: item({ expected_should_answer: false, expected_result_type: null }),
        hasError: false,
        responseText:
          "I'm not able to advise on chemical mixing. Follow the product label and SDS, and involve your EHS lead.",
      });

      expect(outcome.passed).toBe(true);
    });

    it('recognizes the legal/compliance early-decline copy verbatim', () => {
      const outcome = gradeChatTestResponse({
        item: item({ expected_should_answer: false, expected_result_type: null }),
        hasError: false,
        responseText:
          "I'm not able to provide legal or compliance guidance. Please use your official compliance process.",
      });

      expect(outcome.passed).toBe(true);
    });

    it('recognizes the storage/expiration early-decline copy verbatim', () => {
      const outcome = gradeChatTestResponse({
        item: item({ expected_should_answer: false, expected_result_type: null }),
        hasError: false,
        responseText:
          "I'm not able to verify safety for expired or stored products. Follow the product label and SDS before use.",
      });

      expect(outcome.passed).toBe(true);
    });

    it('recognizes the broad-recommendation-without-context early-decline copy, which carries no decline vocabulary at all', () => {
      const outcome = gradeChatTestResponse({
        item: item({ expected_should_answer: false, expected_result_type: null }),
        hasError: false,
        responseText:
          'I need more details to make a specific recommendation. Please share your surface, soil type, and application method.',
      });

      expect(outcome.passed).toBe(true);
    });

    it('still fails a POSITIVE row (expected_should_answer = true) that declines instead of answering', () => {
      // The override must still do its job when an answer was actually expected.
      const outcome = gradeChatTestResponse({
        item: item({ expected_should_answer: true, expected_result_type: null }),
        hasError: false,
        responseText: "I'm not able to advise on chemical mixing. Follow the product label and SDS, and involve your EHS lead.",
      });

      expect(outcome.passed).toBe(false);
    });
  });
  /**
   * B0-537 / B0-538 — single-turn grading must be BYTE-IDENTICAL after (a) the runner/grading
   * dedupe and (b) the multi-turn dispatch. The identity assertion is the strongest available
   * proof for (a): `runner.gradeChatTestResponse` is now literally the `./grading` function, not a
   * second copy that could drift. (b) is covered by the `parseMultiTurnFromInputPayload` cases —
   * every payload shape the existing corpus actually uses resolves to `single_turn`, so those rows
   * never reach the multi-turn path at all.
   */
  describe('B0-537 — single-turn grading is unchanged', () => {
    it('runner.gradeChatTestResponse IS the ./grading implementation (no second copy)', () => {
      expect(gradeChatTestResponse).toBe(gradeFromGradingModule);
    });

    it.each([
      ['null input_payload', null],
      ['empty object', {}],
      ['the real CSV-imported shape', { product_mention: 'pH7Q', question_category: 'dilution' }],
      ['a non-object payload', 'not an object'],
      ['an array payload', [1, 2, 3]],
      ['an explicit null multi_turn key', { multi_turn: null }],
    ])('treats %s as single-turn', (_label, payload) => {
      expect(parseMultiTurnFromInputPayload(payload).kind).toBe('single_turn');
    });

    it('reports a present-but-invalid scenario instead of silently running it single-turn', () => {
      const parsed = parseMultiTurnFromInputPayload({ multi_turn: { version: 1, turns: [] } });
      expect(parsed.kind).toBe('invalid');
    });
  });
});
