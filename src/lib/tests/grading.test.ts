import { describe, expect, it, vi } from 'vitest';

import {
  gradeChatTestResponse,
  gradeChatTestResponseAsync,
  type SemanticDeclineChecker,
} from './grading';

/**
 * B0-755 — the eval harness's pass/fail count was a phrasing detector, not a quality metric:
 * `gradeChatTestResponse` only recognized a decline when the wording matched a fixed phrase/regex
 * list (`responseIndicatesDeclineStyleAnswer`), so the model's paraphrased declines ("Pricing is
 * not published… please contact your distributor") were scored as failures even though they are
 * substantively correct declines. `gradeChatTestResponseAsync` adds an LLM semantic-decline
 * fallback for exactly that gap, while leaving the deterministic fast path untouched.
 *
 * These tests stub `checkSemanticDecline` rather than calling the real `gradeSemanticDecline`
 * (~/lib/tests/decline-grader.ts) — that function makes a live OpenAI Responses API call and has
 * no place in an offline `vitest run`. Its actual judgement was spot-checked live against these
 * same four transcripts before writing this file (via a scratch script using the real client) and
 * returned isDecline=true for both known-bad transcripts below and isDecline=false for both
 * control transcripts, confirming the prompt design; that live behavior is exactly what these tests
 * assert the ORCHESTRATION logic (grading.ts) does with a matching verdict.
 */

const NEGATIVE_ITEM = { expected_should_answer: false, expected_result_type: null } as const;
const POSITIVE_ITEM = { expected_should_answer: true, expected_result_type: null } as const;

function throwingChecker(): SemanticDeclineChecker {
  return vi.fn(async () => {
    throw new Error('checkSemanticDecline should not have been called for this row');
  });
}

describe('gradeChatTestResponseAsync (B0-755)', () => {
  describe('real known-bad transcripts (B0-755 evidence, run c6ad57e5-…)', () => {
    // Actual `response_text` pulled from test_result_items for runs
    // 5c38830e-b5f2-4156-b694-3d113b71689c / e1bb47d3-b7e8-4f70-a56f-36450552952c — both scored
    // 96/100 by the LLM report grader on every run, but failed the harness on every run because
    // `responseIndicatesDeclineStyleAnswer` doesn't recognize "is not listed in", "does not
    // confirm", or a redirect to Betco Customer Service / Regulatory Affairs as decline vocabulary.
    it('"How much does Grease Solv cost?" passes when the semantic checker says it is a decline', async () => {
      const responseText =
        "The cost of Grease Solv is not listed in Betco's product documentation or sustainability brochure.\n\n" +
        '- Betco does not publish pricing information in its product literature or technical documents.\n' +
        '- Grease Solv is available in several sizes, including 4 x 1-gallon bottles (item #260104-00), 5-gallon pail (260105-00), 55-gallon drum (260155-00), 275-gallon tote (260127-00), and 4 x 575-gram SoliChem solids (821E3-00), but no MSRP or price is provided in the retrieved sources.\n' +
        '- For current pricing, availability, and ordering, please contact Betco Customer Service (customerservice@betco.com, 1-888-GO-BETCO) or your authorized Betco distributor.\n' +
        '- I can provide product usage, dilution, and safety information from the label or SDS if needed.\n\n' +
        'Source: Betco Sustainability in Action brochure; Solid Industrial Degreaser product line profile.';

      // Confirm the OLD heuristic really does fail this transcript, i.e. this is the bug.
      const syncOutcome = gradeChatTestResponse({
        item: NEGATIVE_ITEM,
        hasError: false,
        responseText,
      });
      expect(syncOutcome.passed).toBe(false);

      const checkSemanticDecline: SemanticDeclineChecker = vi.fn(async () => ({
        isDecline: true,
        rationale:
          'States pricing is not published and redirects to Betco Customer Service / distributor instead of giving a price.',
      }));

      const outcome = await gradeChatTestResponseAsync({
        item: NEGATIVE_ITEM,
        hasError: false,
        responseText,
        context: {
          prompt: 'How much does Grease Solv cost?',
          idealResponse:
            "I don't have pricing. Pricing varies by distributor and agreement, so any figure I gave you would be unreliable.\n\nYour Betco representative or distributor can quote it.",
          expectedConcepts:
            'no pricing information | pricing varies by distributor and agreement so any figure would be unreliable | Betco representative or distributor can quote it | can provide the item numbers and pack sizes to quote against',
          minimumConcepts: 'no pricing information | Betco representative or distributor can quote it',
        },
        checkSemanticDecline,
      });

      expect(outcome.passed).toBe(true);
      expect(outcome.failureReason).toBeNull();
      expect(outcome.semanticDeclineCheck?.isDecline).toBe(true);
      expect(checkSemanticDecline).toHaveBeenCalledTimes(1);
    });

    it('"Is GE Fight Bac RTU approved for use in my state?" passes when the semantic checker says it is a decline', async () => {
      const responseText =
        'The retrieved documentation does not confirm whether GE Fight Bac RTU is approved for use in your specific state.\n\n' +
        '- GE Fight Bac RTU is an EPA-registered disinfectant (EPA Reg. No. 34810-35-4170), which means it is federally registered for use in the United States (per the GE Fight Bac RTU product label).\n' +
        '- State-level approval or registration may be required in addition to EPA registration, and this information is not included in the product label or catalog excerpt provided.\n' +
        '- For confirmation of state registration or approval, you should contact Betco Regulatory Affairs or your Betco representative, as state registration status can change and is not always published in product documentation.\n\n' +
        'Source: GE Fight Bac RTU product label; Betco product catalog.';

      const syncOutcome = gradeChatTestResponse({
        item: NEGATIVE_ITEM,
        hasError: false,
        responseText,
      });
      expect(syncOutcome.passed).toBe(false);

      const checkSemanticDecline: SemanticDeclineChecker = vi.fn(async () => ({
        isDecline: true,
        rationale:
          'States state-level approval is not confirmed and redirects to Betco Regulatory Affairs instead of giving a yes/no.',
      }));

      const outcome = await gradeChatTestResponseAsync({
        item: NEGATIVE_ITEM,
        hasError: false,
        responseText,
        context: {
          prompt: 'Is GE Fight Bac RTU approved for use in my state?',
          idealResponse:
            'Betco registers all of their disinfectants in every state. For state registration in a specific jurisdiction, contact Betco Regulatory Affairs or your Betco representative.',
          expectedConcepts: null,
          minimumConcepts:
            'Betco registers its disinfectants in every state | for state registration in a specific jurisdiction, contact Betco Regulatory Affairs or your Betco representative',
        },
        checkSemanticDecline,
      });

      expect(outcome.passed).toBe(true);
      expect(outcome.semanticDeclineCheck?.isDecline).toBe(true);
      expect(checkSemanticDecline).toHaveBeenCalledTimes(1);
    });
  });

  describe('the fast path still short-circuits (no LLM call, no added cost)', () => {
    it('never calls the checker when the phrase heuristic already recognizes the decline', async () => {
      const checkSemanticDecline = throwingChecker();

      const outcome = await gradeChatTestResponseAsync({
        item: NEGATIVE_ITEM,
        hasError: false,
        responseText: "I'm sorry, but I cannot provide that information.",
        context: { prompt: 'Some question' },
        checkSemanticDecline,
      });

      expect(outcome.passed).toBe(true);
      expect(outcome.semanticDeclineCheck).toBeUndefined();
      expect(checkSemanticDecline).not.toHaveBeenCalled();
    });

    it('never calls the checker for a positive-expectation row, even with a hedge-y answer', async () => {
      const checkSemanticDecline = throwingChecker();

      const outcome = await gradeChatTestResponseAsync({
        item: POSITIVE_ITEM,
        hasError: false,
        responseText: 'Here is the dilution ratio: 4 oz/gal, per the label.',
        context: { prompt: 'What is the dilution ratio?' },
        checkSemanticDecline,
      });

      expect(outcome.passed).toBe(true);
      expect(checkSemanticDecline).not.toHaveBeenCalled();
    });

    it('never calls the checker when the response is empty on a negative-expectation row (already a pass)', async () => {
      const checkSemanticDecline = throwingChecker();

      const outcome = await gradeChatTestResponseAsync({
        item: NEGATIVE_ITEM,
        hasError: false,
        responseText: '',
        context: { prompt: 'Some question' },
        checkSemanticDecline,
      });

      expect(outcome.passed).toBe(true);
      expect(checkSemanticDecline).not.toHaveBeenCalled();
    });
  });

  describe('a genuinely wrong / hallucinated answer still fails', () => {
    it('fails when the semantic checker says the response is NOT a decline', async () => {
      const checkSemanticDecline: SemanticDeclineChecker = vi.fn(async () => ({
        isDecline: false,
        rationale: 'Response states a specific price ($42.99) instead of declining.',
      }));

      const outcome = await gradeChatTestResponseAsync({
        item: NEGATIVE_ITEM,
        hasError: false,
        responseText: 'Grease Solv costs $42.99 per gallon.',
        context: { prompt: 'How much does Grease Solv cost?' },
        checkSemanticDecline,
      });

      expect(outcome.passed).toBe(false);
      expect(outcome.failureReason).toContain('Semantic decline check:');
      expect(outcome.failureReason).toContain('$42.99');
      expect(outcome.semanticDeclineCheck?.isDecline).toBe(false);
    });
  });

  describe('resilience', () => {
    it('falls back to the deterministic outcome (still failed) when the checker throws', async () => {
      const checkSemanticDecline: SemanticDeclineChecker = vi.fn(async () => {
        throw new Error('network blip');
      });

      const outcome = await gradeChatTestResponseAsync({
        item: NEGATIVE_ITEM,
        hasError: false,
        responseText: 'Pricing is not something I have on hand for this item.',
        context: { prompt: 'How much does Grease Solv cost?' },
        checkSemanticDecline,
      });

      // Same verdict as the plain sync grade — no silent pass, no silent fail invented — but,
      // since B0-902, the row says WHY the LLM check never happened instead of reading as if the
      // model judged the response to be an answer.
      const syncOutcome = gradeChatTestResponse({
        item: NEGATIVE_ITEM,
        hasError: false,
        responseText: 'Pricing is not something I have on hand for this item.',
      });
      expect(outcome.passed).toBe(false);
      expect(outcome.passed).toBe(syncOutcome.passed);
      expect(outcome.failureReason).toContain(syncOutcome.failureReason ?? '');
      expect(outcome.failureReason).toContain(
        'Semantic decline check could not be evaluated: network blip',
      );
      expect(outcome.semanticDeclineCheck).toBeUndefined();
      expect(outcome.semanticDeclineUnavailable).toEqual({ reason: 'network blip' });
    });
  });

  describe('generalization — a spread of paraphrased declines the fixed phrase list misses', () => {
    // Each of these differs in wording from every canonical/phrase-list string in grading.ts, but
    // is substantively a decline: no answer-shaped fact given, and either a stated lack of
    // information or a redirect. The point of this suite is the ORCHESTRATION contract — that any
    // checker verdict of isDecline=true flips the row to pass and isDecline=false leaves it
    // failed — not the grader's own judgement (that part is the live-verified prompt above).
    const paraphrases = [
      'That figure isn’t something I can pull from the documentation on file — your account rep would have current numbers.',
      'The label doesn’t list that detail, and I’d rather not guess at a regulated value. Betco Regulatory Affairs keeps the authoritative record.',
      'Unfortunately the sources I have access to don’t cover that — reaching out to the distributor directly would get you a reliable answer.',
    ];

    it.each(paraphrases)('flips a paraphrased decline to pass: %s', async (responseText) => {
      // Every one of these must already be failing the OLD heuristic, or the test proves nothing.
      expect(
        gradeChatTestResponse({ item: NEGATIVE_ITEM, hasError: false, responseText }).passed,
      ).toBe(false);

      const outcome = await gradeChatTestResponseAsync({
        item: NEGATIVE_ITEM,
        hasError: false,
        responseText,
        context: { prompt: 'Some regulated/pricing question' },
        checkSemanticDecline: vi.fn(async () => ({ isDecline: true, rationale: 'stub' })),
      });

      expect(outcome.passed).toBe(true);
    });

    it('does not flip a paraphrase the checker itself judges as a non-decline', async () => {
      const responseText = 'Grease Solv runs about $40 a gallon in most territories.';
      const outcome = await gradeChatTestResponseAsync({
        item: NEGATIVE_ITEM,
        hasError: false,
        responseText,
        context: { prompt: 'How much does Grease Solv cost?' },
        checkSemanticDecline: vi.fn(async () => ({
          isDecline: false,
          rationale: 'Gives an approximate price instead of declining.',
        })),
      });

      expect(outcome.passed).toBe(false);
    });
  });
});
