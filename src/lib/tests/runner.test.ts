import { describe, expect, it } from 'vitest';

import type { CriteriaGradingOutcome } from './criteria-schemas';
import { gradeChatTestResponse as gradeFromGradingModule } from './grading';
import { parseMultiTurnFromInputPayload } from './multi-turn';
import { gradeChatTestResponse } from './runner';
import type { TestItemRecord } from './types';

/**
 * B0-932 — minimal item factory. The grader reads only the three concept columns now; the
 * default is an item that declares nothing mandatory, which is what the old
 * `expected_should_answer = true` row effectively was: it passes on having answered.
 */
function item(overrides: Partial<TestItemRecord> = {}): TestItemRecord {
  return {
    expected_concepts: [],
    minimum_concepts: [],
    expected_criteria: [],
    ...overrides,
  } as TestItemRecord;
}

/** An item whose mandatory concepts describe the refusal — the old "negative row". */
function declineItem(): TestItemRecord {
  return item({
    minimum_concepts: [
      'says the requested information is not available or cannot be verified',
      'directs the customer to a Betco representative',
    ],
  });
}

/** A `gradeWithCriteria` verdict stub; only `passed` feeds the mandatory-coverage decision. */
function conceptVerdict(passed: boolean): CriteriaGradingOutcome {
  return {
    passed,
    score: passed ? 1 : 0.5,
    verdicts: [],
    failureReason: passed ? null : 'Missed 1 tier-1 (must-have) criterion: "…".',
  };
}

describe('gradeChatTestResponse', () => {
  it('fails an item with nothing mandatory when the assistant declines with "don\'t have the verified information" phrasing', () => {
    // Regression: this exact response was previously scored Passed because the fixed substring
    // list ("don't have verified") missed the inserted "the".
    const responseText =
      "I don't have the verified information on the required wet contact time for disinfection " +
      'with GE Fight Bac RTU. For accurate and safe usage, please refer to the product label ' +
      'or official Betco documentation.';

    const outcome = gradeChatTestResponse({
      item: item(),
      hasError: false,
      responseText,
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.failureReason).toBeTruthy();
  });

  it('passes an item with nothing mandatory for a genuine substantive answer', () => {
    const responseText =
      'GE Fight Bac RTU must remain visibly wet on the surface for at least 60 seconds to disinfect.';

    const outcome = gradeChatTestResponse({
      item: item(),
      hasError: false,
      responseText,
    });

    expect(outcome.passed).toBe(true);
  });

  it('does not misclassify a real answer that merely cites the label as a decline', () => {
    const responseText =
      'Per the product label, dilute at 2 oz per gallon; refer to the product label for the full directions.';

    const outcome = gradeChatTestResponse({
      item: item(),
      hasError: false,
      responseText,
    });

    expect(outcome.passed).toBe(true);
  });

  it('fails on an empty response', () => {
    const outcome = gradeChatTestResponse({
      item: item(),
      hasError: false,
      responseText: '   ',
    });

    expect(outcome.passed).toBe(false);
  });

  it('passes a decline whose mandatory concepts the concept grader judged covered', () => {
    const outcome = gradeChatTestResponse({
      item: declineItem(),
      hasError: false,
      responseText: "I don't have the verified information needed to answer that.",
      conceptGrading: conceptVerdict(true),
    });

    expect(outcome.passed).toBe(true);
  });

  it('fails a decline whose mandatory concepts the concept grader judged missed', () => {
    const outcome = gradeChatTestResponse({
      item: declineItem(),
      hasError: false,
      responseText: "I don't have the verified information needed to answer that.",
      conceptGrading: conceptVerdict(false),
    });

    expect(outcome.passed).toBe(false);
  });

  describe('B0-300 follow-up — canonical "no confident equivalent" decline copy', () => {
    // Both are the exact response texts from the B0-97 "No-Equivalent Probes" eval run that
    // prompted this fix: XREF_DECLINE_COPY (product/cross-reference agent) matched none of the
    // existing keyword/regex patterns and was failing a negative row despite being a correct decline.
    const xrefDeclineCopyResponse =
      "I couldn't confidently identify a Betco equivalent for this product. A Betco sales representative can help identify the right match — please reach out to your rep.";
    const recommendationsDeclineCopyResponse =
      "I'm sorry, but I don't have enough information to provide that answer. Please contact a Betco sales representative directly.";

    it.each([
      ['XREF_DECLINE_COPY (product / cross-reference agent)', xrefDeclineCopyResponse],
      ['the recommendations agent canonical copy', recommendationsDeclineCopyResponse],
    ])('recognizes %s as a decline and surfaces it on an item with nothing mandatory', (_label, responseText) => {
      const outcome = gradeChatTestResponse({
        item: item(),
        hasError: false,
        responseText,
      });

      expect(outcome.passed).toBe(false);
      expect(outcome.failureReason).toContain('could not answer');
    });

    it.each([
      ['XREF_DECLINE_COPY (product / cross-reference agent)', xrefDeclineCopyResponse],
      ['the recommendations agent canonical copy', recommendationsDeclineCopyResponse],
    ])('passes %s once its mandatory concepts are judged covered (B0-932 exemption)', (_label, responseText) => {
      const outcome = gradeChatTestResponse({
        item: declineItem(),
        hasError: false,
        responseText,
        conceptGrading: conceptVerdict(true),
      });

      expect(outcome.passed).toBe(true);
    });
  });

  describe('B0-518 — early-decline gate copy is still recognized as a decline', () => {
    /**
     * The four canned early-decline copies use vocabulary the phrase/regex heuristics did not
     * cover ("advise"; the broad-recommendation copy has no decline words at all). Each must be
     * recognized so it is SURFACED on an item with nothing mandatory to cover, and each must be
     * exempted once the item's mandatory concepts are judged covered.
     *
     * B0-932 — the exemption used to key off `expected_should_answer === false` with a second,
     * always-null `expected_result_type` condition. Both columns are gone; concept coverage is
     * the condition now, and it is the thing the old flag was standing in for.
     */
    const EARLY_DECLINE_COPIES: ReadonlyArray<[string, string]> = [
      [
        'chemical-mixing ("advise" is not in the decline vocabulary)',
        "I'm not able to advise on chemical mixing. Follow the product label and SDS, and involve your EHS lead.",
      ],
      [
        'legal/compliance',
        "I'm not able to provide legal or compliance guidance. Please use your official compliance process.",
      ],
      [
        'storage/expiration',
        "I'm not able to verify safety for expired or stored products. Follow the product label and SDS before use.",
      ],
      [
        'broad-recommendation-without-context (no decline vocabulary at all)',
        'I need more details to make a specific recommendation. Please share your surface, soil type, and application method.',
      ],
      [
        'the canonical "no verified information" phrasing',
        "I don't have the verified information needed to answer that.",
      ],
    ];

    it.each(EARLY_DECLINE_COPIES)(
      'surfaces the %s copy as a failure when the item has nothing mandatory to cover',
      (_label, responseText) => {
        const outcome = gradeChatTestResponse({
          item: item(),
          hasError: false,
          responseText,
        });

        expect(outcome.passed).toBe(false);
      },
    );

    it.each(EARLY_DECLINE_COPIES)(
      'exempts the %s copy once the mandatory concepts are judged covered',
      (_label, responseText) => {
        const outcome = gradeChatTestResponse({
          item: declineItem(),
          hasError: false,
          responseText,
          conceptGrading: conceptVerdict(true),
        });

        expect(outcome.passed).toBe(true);
      },
    );

    it('still fails a decline when the mandatory concepts were NOT covered', () => {
      // The override must still do its job when content was genuinely required.
      const outcome = gradeChatTestResponse({
        item: declineItem(),
        hasError: false,
        responseText:
          "I'm not able to advise on chemical mixing. Follow the product label and SDS, and involve your EHS lead.",
        conceptGrading: conceptVerdict(false),
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
