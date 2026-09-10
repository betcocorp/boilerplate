import { describe, expect, it, vi } from 'vitest';

import { XREF_DECLINE_COPY } from '~/lib/recommendations/confidence-scoring';

import type { CriteriaGradingOutcome } from './criteria-schemas';
import {
  gradeChatTestResponse,
  gradeChatTestResponseAsync,
  type GradableExpectations,
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

/**
 * B0-932 — the two item shapes that replace the retired behaviour flags.
 *
 * `DECLINE_CONCEPT_ITEM` is what a former `expected_should_answer = false` row looks like now: the
 * mandatory concepts describe the refusal, so nothing has to declare "a decline is correct here".
 * `NO_MANDATORY_ITEM` is a row that declares nothing required — the run report marks these Unable
 * to Evaluate (B0-826), and the harness passes them on having answered.
 */
const DECLINE_CONCEPT_ITEM: GradableExpectations = {
  minimum_concepts: [
    'no pricing information',
    'Betco representative or distributor can quote it',
  ],
  expected_concepts: [
    'no pricing information',
    'pricing varies by distributor and agreement so any figure would be unreliable',
    'Betco representative or distributor can quote it',
  ],
  expected_criteria: [],
};

const NO_MANDATORY_ITEM: GradableExpectations = {
  minimum_concepts: [],
  expected_concepts: [],
  expected_criteria: [],
};

/** A `gradeWithCriteria` verdict stub — only `passed` feeds the mandatory-coverage decision. */
function conceptVerdict(passed: boolean): CriteriaGradingOutcome {
  return {
    passed,
    score: passed ? 1 : 0.5,
    verdicts: [],
    failureReason: passed
      ? null
      : 'Missed 1 tier-1 (must-have) criterion: "Betco representative or distributor can quote it".',
  };
}

function throwingChecker(): SemanticDeclineChecker {
  return vi.fn(async () => {
    throw new Error('checkSemanticDecline should not have been called for this row');
  });
}

/**
 * B0-932 — the pass rule itself. `expected_should_answer` is gone; an item now passes when it
 * answered without erroring AND every `minimum_concepts` phrase was judged satisfied.
 */
describe('gradeChatTestResponse — mandatory concept coverage is the pass axis (B0-932)', () => {
  const ANSWER = 'Dilute at the labeled ratio and keep the surface wet for the labeled time.';

  it('passes when every mandatory concept was judged satisfied', () => {
    const outcome = gradeChatTestResponse({
      item: DECLINE_CONCEPT_ITEM,
      hasError: false,
      responseText: ANSWER,
      conceptGrading: conceptVerdict(true),
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.failureReason).toBeNull();
  });

  it('fails when a mandatory concept was missed, and says which one', () => {
    const outcome = gradeChatTestResponse({
      item: DECLINE_CONCEPT_ITEM,
      hasError: false,
      responseText: ANSWER,
      conceptGrading: conceptVerdict(false),
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.failureReason).toContain(
      'Betco representative or distributor can quote it',
    );
  });

  it('fails an item that declares mandatory concepts but got no verdict, rather than passing it', () => {
    // The old rule passed this: "the row wanted an answer and the model said something". That is
    // precisely the false pass B0-932 removes.
    const outcome = gradeChatTestResponse({
      item: DECLINE_CONCEPT_ITEM,
      hasError: false,
      responseText: ANSWER,
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.failureReason).toContain('could not be evaluated');
  });

  it('never passes an item the grader could not judge, even with nothing mandatory (B0-902)', () => {
    const outcome = gradeChatTestResponse({
      item: NO_MANDATORY_ITEM,
      hasError: false,
      responseText: ANSWER,
      conceptGrading: {
        passed: false,
        score: null,
        verdicts: [],
        failureReason: 'Unable to evaluate 3 semantic criteria: Grading call failed: timeout.',
        unableToEvaluate: true,
        uteReason: 'Grading call failed: timeout.',
      },
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.failureReason).toContain('Unable to evaluate');
  });

  it('passes an item with no mandatory concepts on having answered (B0-826 marks it UTE, not failed)', () => {
    const outcome = gradeChatTestResponse({
      item: NO_MANDATORY_ITEM,
      hasError: false,
      responseText: ANSWER,
    });

    expect(outcome.passed).toBe(true);
    expect(outcome.failureReason).toBeNull();
  });

  it('fails a hard error before looking at any concept', () => {
    const outcome = gradeChatTestResponse({
      item: DECLINE_CONCEPT_ITEM,
      hasError: true,
      responseText: '',
      conceptGrading: conceptVerdict(true),
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.failureReason).toContain('error');
  });

  it('fails an empty response before looking at any concept', () => {
    const outcome = gradeChatTestResponse({
      item: NO_MANDATORY_ITEM,
      hasError: false,
      responseText: '   ',
      conceptGrading: conceptVerdict(true),
    });

    expect(outcome.passed).toBe(false);
    expect(outcome.failureReason).toContain('empty');
  });

  it('ignores an `exact:` prefix when counting whether an item has mandatory concepts', () => {
    const outcome = gradeChatTestResponse({
      item: {
        minimum_concepts: ['exact: EPA Reg. No. 1839-83'],
        expected_concepts: [],
        expected_criteria: [],
      },
      hasError: false,
      responseText: ANSWER,
    });

    // It has one mandatory concept, so it cannot pass without a verdict.
    expect(outcome.passed).toBe(false);
    expect(outcome.failureReason).toContain('could not be evaluated');
  });

  describe('the "unable to assist" visibility override', () => {
    const DECLINE_TEXT = "I'm sorry, but I cannot provide that information.";

    it('still fails a decline on an item with no mandatory concepts to cover', () => {
      const outcome = gradeChatTestResponse({
        item: NO_MANDATORY_ITEM,
        hasError: false,
        responseText: DECLINE_TEXT,
      });

      expect(outcome.passed).toBe(false);
      expect(outcome.failureReason).toContain('could not answer');
    });

    it('exempts an item whose mandatory concepts were satisfied', () => {
      const outcome = gradeChatTestResponse({
        item: DECLINE_CONCEPT_ITEM,
        hasError: false,
        responseText: DECLINE_TEXT,
        conceptGrading: conceptVerdict(true),
      });

      expect(outcome.passed).toBe(true);
      expect(outcome.failureReason).toBeNull();
    });
  });
});

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

      // B0-932 — with no concept verdict in hand the deterministic grade cannot pass this item;
      // the LLM decline check below is the last-resort path that decides it.
      const syncOutcome = gradeChatTestResponse({
        item: DECLINE_CONCEPT_ITEM,
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
        item: DECLINE_CONCEPT_ITEM,
        hasError: false,
        responseText,
        context: {
          prompt: 'How much does Grease Solv cost?',
          idealResponse:
            "I don't have pricing. Pricing varies by distributor and agreement, so any figure I gave you would be unreliable.\n\nYour Betco representative or distributor can quote it.",
          expectedConcepts: [
            'no pricing information',
            'pricing varies by distributor and agreement so any figure would be unreliable',
            'Betco representative or distributor can quote it',
            'can provide the item numbers and pack sizes to quote against',
          ],
          minimumConcepts: [
            'no pricing information',
            'Betco representative or distributor can quote it',
          ],
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
        item: DECLINE_CONCEPT_ITEM,
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
        item: DECLINE_CONCEPT_ITEM,
        hasError: false,
        responseText,
        context: {
          prompt: 'Is GE Fight Bac RTU approved for use in my state?',
          idealResponse:
            'Betco registers all of their disinfectants in every state. For state registration in a specific jurisdiction, contact Betco Regulatory Affairs or your Betco representative.',
          expectedConcepts: [],
          minimumConcepts: [
            'Betco registers its disinfectants in every state',
            'for state registration in a specific jurisdiction, contact Betco Regulatory Affairs or your Betco representative',
          ],
        },
        checkSemanticDecline,
      });

      expect(outcome.passed).toBe(true);
      expect(outcome.semanticDeclineCheck?.isDecline).toBe(true);
      expect(checkSemanticDecline).toHaveBeenCalledTimes(1);
    });
  });

  describe('the fast path still short-circuits (no LLM call, no added cost)', () => {
    it('never calls the checker when the concept grader already judged the mandatory concepts met', async () => {
      const checkSemanticDecline = throwingChecker();

      const outcome = await gradeChatTestResponseAsync({
        item: DECLINE_CONCEPT_ITEM,
        hasError: false,
        responseText:
          "I don't have pricing — it varies by distributor and agreement. Your Betco representative or distributor can quote it.",
        conceptGrading: conceptVerdict(true),
        context: { prompt: 'How much does Grease Solv cost?' },
        checkSemanticDecline,
      });

      expect(outcome.passed).toBe(true);
      expect(outcome.semanticDeclineCheck).toBeUndefined();
      expect(checkSemanticDecline).not.toHaveBeenCalled();
    });

    it('never calls the checker when the concept grader judged a mandatory concept MISSED', async () => {
      const checkSemanticDecline = throwingChecker();

      const outcome = await gradeChatTestResponseAsync({
        item: DECLINE_CONCEPT_ITEM,
        hasError: false,
        responseText: 'Grease Solv costs $42.99 per gallon.',
        conceptGrading: conceptVerdict(false),
        context: { prompt: 'How much does Grease Solv cost?' },
        checkSemanticDecline,
      });

      // The per-phrase verdict is strictly better evidence than a decline/not-decline judgement,
      // so a judged miss is final — no second opinion, no second model call.
      expect(outcome.passed).toBe(false);
      expect(outcome.failureReason).toContain('Missed 1 tier-1');
      expect(checkSemanticDecline).not.toHaveBeenCalled();
    });

    it('never calls the checker for an item with no mandatory concepts', async () => {
      const checkSemanticDecline = throwingChecker();

      const outcome = await gradeChatTestResponseAsync({
        item: NO_MANDATORY_ITEM,
        hasError: false,
        responseText: 'Here is the dilution ratio: 4 oz/gal, per the label.',
        context: { prompt: 'What is the dilution ratio?' },
        checkSemanticDecline,
      });

      expect(outcome.passed).toBe(true);
      expect(checkSemanticDecline).not.toHaveBeenCalled();
    });

    it('never calls the checker when the response is empty (there is nothing to judge)', async () => {
      const checkSemanticDecline = throwingChecker();

      const outcome = await gradeChatTestResponseAsync({
        item: DECLINE_CONCEPT_ITEM,
        hasError: false,
        responseText: '',
        context: { prompt: 'Some question' },
        checkSemanticDecline,
      });

      // B0-932 — an empty response fails first, whatever the item expected. It used to be a PASS
      // for a negative row; that only made sense while "expected no answer" was a column.
      expect(outcome.passed).toBe(false);
      expect(outcome.failureReason).toContain('empty');
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
        item: DECLINE_CONCEPT_ITEM,
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
        item: DECLINE_CONCEPT_ITEM,
        hasError: false,
        responseText: 'Pricing is not something I have on hand for this item.',
        context: { prompt: 'How much does Grease Solv cost?' },
        checkSemanticDecline,
      });

      // Same verdict as the plain sync grade — no silent pass, no silent fail invented — but,
      // since B0-902, the row says WHY the LLM check never happened instead of reading as if the
      // model judged the response to be an answer.
      const syncOutcome = gradeChatTestResponse({
        item: DECLINE_CONCEPT_ITEM,
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
        gradeChatTestResponse({ item: DECLINE_CONCEPT_ITEM, hasError: false, responseText }).passed,
      ).toBe(false);

      const outcome = await gradeChatTestResponseAsync({
        item: DECLINE_CONCEPT_ITEM,
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
        item: DECLINE_CONCEPT_ITEM,
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

/**
 * B0-928 — two of the seven golden-set failures on the 2026-09-10 gpt-5.6 run (app_version 4.4.0)
 * were the harness failing turns that ANSWERED, both via `withUnableToAssistFailureOverride`:
 *
 * - RC3: the regulated-claim guardrail's own redaction copy ("(unable to verify)", the
 *   "I couldn't verify … so I withheld it" footer) matches `DECLINE_REGEXES`, so the app's
 *   transparency note failed the answer it was attached to.
 * - RC4: `XREF_DECLINE_COPY` appended after a complete answer (the cross-reference sub-task
 *   escalated at 0.542 against the 0.80 gate) failed the whole turn via a plain substring test.
 *
 * Both response strings below are verbatim from `test_result_items` for that run.
 */
describe('answered turns that carry app-authored decline copy (B0-928)', () => {
  const REDACTION_FOOTER_TOKEN_MODE = [
    `I couldn't verify the EPA registration number above against an exact quote from a retrieved label or SDS, so I withheld it (marked "(unable to verify)").`,
    'Please consult the product label or SDS directly for the exact regulated value, or contact Betco Product Support / EHS to confirm.',
  ].join('\n');

  describe('RC3 — a token-redacted answer is not a decline', () => {
    // Product Specialist row 15: gate verdict `redacted` / `token_redaction` — only pH7Q Dual's
    // EPA registration number could not be verified verbatim, so it was blanked in place.
    const responseText = `There is no documented “best” ranking; choose by required contact time and ready-to-use versus concentrate.

- **GE Fight Bac RTU:** ready-to-use; its efficacy record lists **feline calicivirus (surrogate for norovirus)** with a **3-minute contact time**, EPA Reg. **34810-35-4170**. [doc:f2ccc9d5-d443-449e-9d3f-4ddfc8a74fe0]
- **Quat-Stat 5:** concentrate at **1:256 (0.5 oz/gal)**; verified **Norwalk virus/norovirus** claim requires **5 minutes wet**, EPA Reg. **6836-361-4170**. [doc:1f0d1d94-b59b-469b-9436-4e0f19a1d82d]
- **pH7Q Dual:** concentrate at **1:256 (0.5 oz/gal)**; verified **norovirus** claim requires **10 minutes wet**, EPA Reg. **(unable to verify)**. [doc:verified-facts:BB13F08B-607A-4B3E-8B43-D3E98532AC64]

Pre-clean heavy soil, dilute concentrates exactly as labeled, and keep the surface visibly wet for the full organism-specific time. Confirm the current container label before use.

**Sources:** Betco verified efficacy data for GE Fight Bac RTU, Quat-Stat 5, and pH7Q Dual; *Norovirus Outbreaks: Betco Cleaning and Hand Hygiene Solutions*. [doc:5466397a-41a4-430d-8bb0-0116f4de8da6]

I couldn't verify the EPA registration number above against an exact quote from a retrieved label or SDS, so I withheld it (marked "(unable to verify)").
Please consult the product label or SDS directly for the exact regulated value, or contact Betco Product Support / EHS to confirm.`;

    it('passes an item with nothing mandatory to cover', () => {
      const outcome = gradeChatTestResponse({
        item: NO_MANDATORY_ITEM,
        hasError: false,
        responseText,
      });

      expect(outcome.passed).toBe(true);
      expect(outcome.failureReason).toBeNull();
    });

    it('still fails a response that is nothing BUT redaction copy', () => {
      const outcome = gradeChatTestResponse({
        item: NO_MANDATORY_ITEM,
        hasError: false,
        responseText: `(unable to verify)\n\n${REDACTION_FOOTER_TOKEN_MODE}`,
      });

      expect(outcome.passed).toBe(false);
      expect(outcome.failureReason).toContain('could not answer');
    });

    it('still fails a genuine decline that happens to sit next to redaction copy', () => {
      const outcome = gradeChatTestResponse({
        item: NO_MANDATORY_ITEM,
        hasError: false,
        responseText: [
          "I don't have the information needed to answer that. The retrieved label and SDS do not",
          'state a contact time for this organism, and I will not supply one from memory. A Betco',
          'representative can confirm the labeled value for the product in hand before you use it.',
          '',
          REDACTION_FOOTER_TOKEN_MODE,
        ].join('\n'),
      });

      expect(outcome.passed).toBe(false);
    });
  });

  describe('RC4 — a canonical decline appended after an answer is not a decline', () => {
    // Product Specialist row 9: "Betco's version of BNC-15 kills everything BNC-15 does, right?"
    const responseText = `Kill claims do not transfer between products. EPA-registered efficacy claims do NOT automatically carry over from the competitor product to the Betco equivalent (or vice versa) — being a matched equivalent does not mean the two products share the same registered claims. Only the claims printed on the Betco product's own current EPA-registered label are valid. Check every organism you need against that Betco label before substituting.

${XREF_DECLINE_COPY}`;

    it('passes an item with nothing mandatory to cover', () => {
      const outcome = gradeChatTestResponse({
        item: NO_MANDATORY_ITEM,
        hasError: false,
        responseText,
      });

      expect(outcome.passed).toBe(true);
      expect(outcome.failureReason).toBeNull();
    });

    it('still fails a bare canonical decline with no substantive content', () => {
      const outcome = gradeChatTestResponse({
        item: NO_MANDATORY_ITEM,
        hasError: false,
        responseText: XREF_DECLINE_COPY,
      });

      expect(outcome.passed).toBe(false);
      expect(outcome.failureReason).toContain('could not answer');
    });

    it('still fails the canonical decline behind a token preamble', () => {
      const outcome = gradeChatTestResponse({
        item: NO_MANDATORY_ITEM,
        hasError: false,
        responseText: `Here is what I found.\n\n${XREF_DECLINE_COPY}`,
      });

      expect(outcome.passed).toBe(false);
    });

    it('still fails when the content before the decline is itself decline-shaped', () => {
      const outcome = gradeChatTestResponse({
        item: NO_MANDATORY_ITEM,
        hasError: false,
        responseText: [
          'I could not find a verified cross-reference record for that competitor product in the',
          'retrieved documentation, and I will not guess at an equivalent from memory. Your Betco',
          'representative keeps the current cross-reference list for competitor conversions.',
          '',
          XREF_DECLINE_COPY,
        ].join('\n'),
      });

      expect(outcome.passed).toBe(false);
    });

    it('keeps scoring a bare decline as a PASS once its mandatory concepts are covered', () => {
      // B0-932 — the exemption that used to key off `expected_should_answer === false` now keys
      // off the honest thing it was approximating: the row said what a correct answer contains,
      // and the concept grader confirmed the answer contains it.
      const outcome = gradeChatTestResponse({
        item: DECLINE_CONCEPT_ITEM,
        hasError: false,
        responseText: XREF_DECLINE_COPY,
        conceptGrading: conceptVerdict(true),
      });

      expect(outcome.passed).toBe(true);
      expect(outcome.failureReason).toBeNull();
    });
  });
});
