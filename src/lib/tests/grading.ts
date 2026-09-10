import { RECOMMENDATIONS_DECLINE_COPY } from '~/lib/agents/recommendations-specialist/recommendations-specialist-system-prompt';
import { XREF_DECLINE_COPY } from '~/lib/recommendations/confidence-scoring';
import {
  EARLY_DECLINE_BROAD_RECOMMENDATION_COPY,
  EARLY_DECLINE_CHEMICAL_MIXING_COPY,
  EARLY_DECLINE_LEGAL_COMPLIANCE_COPY,
  EARLY_DECLINE_STORAGE_EXPIRATION_COPY,
} from '~/lib/workflows/product-support/run-product-support-workflow';
import {
  countSubstantiveContentChars,
  REGULATED_CLAIM_REDACTION_MIN_REMAINING_CHARS,
  stripRegulatedClaimRedactionArtifacts,
} from '~/lib/workflows/product-support/regulated-claim-redaction-copy';

import type { TestItemRecord } from './types';

/**
 * B0-537 — pure response-grading logic, extracted verbatim from `runner.ts` so the multi-turn
 * evaluator (`multi-turn-evaluator.ts`) can reuse per-turn grading without importing the runner
 * (which pulls in the live workflow/conversation stack). `runner.ts` re-exports
 * `gradeChatTestResponse`, so existing imports are unaffected.
 */

/**
 * The grader only reads these two expectation fields off a test item, so per-turn expectations in
 * multi-turn scenarios can be graded with the exact same rules without fabricating a full DB row.
 */
export type GradableExpectations = Pick<
  TestItemRecord,
  'expected_should_answer' | 'expected_result_type'
>;

/**
 * The app's own canonical "no confident equivalent" decline strings (B0-300 follow-up). Checked
 * verbatim before falling back to the keyword/regex heuristics below, since those are guesses at
 * paraphrasing this exact, deterministic copy and can miss it (e.g. XREF_DECLINE_COPY matched none
 * of the existing patterns).
 *
 * B0-518 — added the four `classifyEarlyDecline` canned copies for the same reason: the
 * `broad_recommendation_without_context` text carries no decline vocabulary at all (no "can't",
 * "unable", "no information", …) and the `chemical_mixing_or_safety` text uses "not able to
 * **advise**", a verb the regex/phrase heuristics below don't cover. Both were confirmed (via the
 * "Product Golden Test Set" run `6203d34f-…`) to correctly early-decline and then get graded as an
 * unrecognized failed answer.
 */
const CANONICAL_DECLINE_COPY = [
  RECOMMENDATIONS_DECLINE_COPY,
  XREF_DECLINE_COPY,
  EARLY_DECLINE_CHEMICAL_MIXING_COPY,
  EARLY_DECLINE_LEGAL_COMPLIANCE_COPY,
  EARLY_DECLINE_STORAGE_EXPIRATION_COPY,
  EARLY_DECLINE_BROAD_RECOMMENDATION_COPY,
];

function matchesCanonicalDeclineCopy(responseText: string): boolean {
  return CANONICAL_DECLINE_COPY.some((copy) => responseText.includes(copy));
}

/** Shared "is there enough here to be an answer" bar — letters and digits only, the guardrail's own notion. */
function hasSubstantiveContent(text: string): boolean {
  return countSubstantiveContentChars(text) >= REGULATED_CLAIM_REDACTION_MIN_REMAINING_CHARS;
}

/**
 * B0-928 (RC4) — true when one of the app's canonical decline strings is a TRAILING addendum to a
 * turn that already answered, so the turn should not be failed for containing it.
 *
 * The cross-reference engine appends `XREF_DECLINE_COPY` whenever its own sub-task (finding a Betco
 * equivalent) lands under threshold, even when the model answered the question that was actually
 * asked first — "Betco's version of BNC-15 kills everything BNC-15 does, right?" got a correct,
 * complete "kill claims do not transfer" answer followed by that copy, and the plain substring test
 * failed the whole row.
 *
 * Deliberately conservative: the copy has to be at the very END, what precedes it has to clear the
 * substantive-content bar, and that remainder must not itself be decline-shaped by any of the
 * existing heuristics.
 *
 * Accepted tradeoff, stated honestly: this can now pass a turn whose substantive content did NOT
 * address the specific question asked while its decline covered only a sub-task. That is the price
 * of not failing turns that answered; judging whether the substance is right is the concept
 * grader's job, not this phrase detector's.
 */
function answeredBeforeTrailingCanonicalDecline(responseText: string): boolean {
  const trimmed = responseText.trimEnd();
  const trailingCopy = CANONICAL_DECLINE_COPY.find((copy) => trimmed.endsWith(copy));
  if (!trailingCopy) {
    return false;
  }

  const remainder = trimmed.slice(0, trimmed.length - trailingCopy.length);
  if (!hasSubstantiveContent(remainder)) {
    return false;
  }

  return (
    !matchesCanonicalDeclineCopy(remainder) &&
    !matchesUnableToAssistPhrase(remainder.trim().toLowerCase()) &&
    !responseIndicatesDeclineStyleAnswer(remainder)
  );
}

function shouldExpectAnswer(item: GradableExpectations) {
  return item.expected_should_answer;
}

export type EvaluationOutcome = {
  passed: boolean;
  /** Human-readable explanation when `passed` is false (stored on `error_message`). */
  failureReason: string | null;
};

export const UNABLE_TO_ASSIST_FAILURE_REASON =
  'The assistant indicated it could not answer (e.g. no verified information, could not find a hazard, or cannot provide). Marked failed so you can review and investigate.';

/**
 * Decline patterns that are robust to intervening words the fixed phrase list misses.
 * Kept deliberately tight (the "lack of information/data" family) so genuine answers that merely
 * cite a label are not flagged. These catch e.g. "I don't have **the** verified information on the
 * required wet contact time" — which the substring list slips because of the inserted "the".
 */
const DECLINE_REGEXES: RegExp[] = [
  // "(do not|don't|does not|doesn't|no longer) have [the/any/enough/sufficient/access to …]
  //  [verified/specific/reliable/confirmed/detailed/that/this …] information|data|details|answer|documentation"
  /\b(?:do not|don't|does not|doesn't|did not|didn't|no longer)\s+have\s+(?:the\s+|any\s+|enough\s+|sufficient\s+|access to\s+|specific\s+|verified\s+|reliable\s+|confirmed\s+|detailed\s+|that\s+|this\s+|required\s+|necessary\s+)*(?:information|data|details|answer|documentation)\b/,
  // "no (verified|reliable|confirmed|specific) information|data" (lack statement, not a citation)
  /\bno\s+(?:verified|reliable|confirmed|specific)\s+(?:information|data)\b/,
  // Canonical normalized decline: "I('m| am)? (unable|not able) to (provide|verify|confirm|locate|answer) …"
  /\b(?:unable|not able)\s+to\s+(?:provide|verify|confirm|locate|find|answer|retrieve)\b/,
];

/**
 * Declines, hedges, and “no answer” phrasing — treated as **failed** outcomes for visibility,
 * even when row expectations would otherwise accept a short decline.
 *
 * B0-518 — checks the same canonical decline copy as `responseIndicatesDeclineStyleAnswer` first,
 * so the two "is this actually a decline" detectors agree: the chemical-mixing and
 * broad-recommendation early-decline copies use vocabulary ("advise", no decline words at all) that
 * the phrase/regex heuristics below don't cover, which previously meant a POSITIVE row
 * (`expected_should_answer = true`) that got one of those two exact declines back was scored a false
 * PASS instead of being flagged for review.
 */
export function responseIndicatesUnableToAssistOrRefusal(responseText: string): boolean {
  const t = responseText.trim().toLowerCase();
  if (!t) {
    return false;
  }

  // B0-928 (RC4) — an answered turn with the canonical decline copy appended is not a decline.
  if (answeredBeforeTrailingCanonicalDecline(responseText)) {
    return false;
  }

  if (matchesCanonicalDeclineCopy(responseText)) {
    return true;
  }

  return matchesUnableToAssistPhrase(t);
}

/** The phrase/regex half of `responseIndicatesUnableToAssistOrRefusal`, on already-lowercased text. */
function matchesUnableToAssistPhrase(t: string): boolean {
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

  return phrases.some((p) => t.includes(p)) || DECLINE_REGEXES.some((r) => r.test(t));
}

/**
 * True when the assistant is clearly declining, hedging, or refusing to confirm — beyond only
 * "can't"/"cannot" (e.g. "don't have verified information", "unable to verify").
 */
export function responseIndicatesDeclineStyleAnswer(responseText: string): boolean {
  const t = responseText.trim().toLowerCase();
  if (!t) {
    return false;
  }

  if (matchesCanonicalDeclineCopy(responseText)) {
    return true;
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

  return indicators.some((p) => t.includes(p)) || DECLINE_REGEXES.some((r) => r.test(t));
}

/**
 * Rows expecting a decline-style outcome should not be failed by the "unable to assist" visibility
 * override below — `evaluateTestOutcome` already scored a decline response as a legitimate PASS for
 * these, and the override exists to catch a decline where an ANSWER was expected, not to re-litigate
 * one the base evaluator already approved.
 *
 * B0-518 — this used to ALSO require `expected_result_type` to literally be `'decline'`/`'none'`
 * before exempting the row, on top of `expected_should_answer === false`. Confirmed against the live
 * "Product Golden Test Set" run (`6203d34f-…`) and every other negative-expectation row in the
 * database: `expected_result_type` is null on every single one, so that second condition never once
 * matched in production — the exemption was effectively dead, and every correctly-triggered decline
 * on a negative row was being re-failed by the override with "The assistant indicated it could not
 * answer…", even though `evaluateTestOutcome` had already scored it a pass one line earlier.
 * `expected_should_answer === false` is already the row's own "a decline is the correct outcome here"
 * signal (it is the exact condition `evaluateTestOutcome` tests), so requiring a second field to
 * separately agree was redundant, not an extra safety check.
 */
function expectsDeclineStyleOutcome(item: GradableExpectations): boolean {
  return shouldExpectAnswer(item) === false;
}

/**
 * Same pass/fail rules as the historical boolean helper; adds `failureReason` for failed assertions.
 */
function evaluateTestOutcome(params: {
  item: GradableExpectations;
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
  item: GradableExpectations,
): EvaluationOutcome {
  const hasText = responseText.trim().length > 0;
  if (!hasText || !outcome.passed) {
    return outcome;
  }

  if (expectsDeclineStyleOutcome(item)) {
    return outcome;
  }

  /**
   * B0-928 (RC3) — judge decline-ness on the answer text with the guardrail's OWN redaction
   * artifacts removed. `(unable to verify)`, the `[one … withheld — …]` markers and both redaction
   * footers are copy the app writes, not the model refusing: two golden rows (Product Specialist
   * #6/#15) returned substantively complete answers where a single unverifiable EPA number was
   * blanked in place, and failed only because that copy matches `DECLINE_REGEXES`.
   *
   * When stripping leaves nothing substantive the row keeps failing — an answer that was ENTIRELY
   * redaction copy is a genuine non-answer — so in that case the raw text is judged, exactly as
   * before. `evaluateTestOutcome`'s emptiness check still reads the raw response text.
   */
  const strippedText = stripRegulatedClaimRedactionArtifacts(responseText);
  const declineSourceText =
    strippedText !== responseText && hasSubstantiveContent(strippedText)
      ? strippedText
      : responseText;

  if (!responseIndicatesUnableToAssistOrRefusal(declineSourceText)) {
    return outcome;
  }

  return {
    passed: false,
    failureReason: UNABLE_TO_ASSIST_FAILURE_REASON,
  };
}

/**
 * Full pass/fail decision for a single chat test item: applies the expectation rules and the
 * "unable to assist" decline override. Exported so the grading behavior can be unit-tested
 * independently of the live workflow.
 */
export function gradeChatTestResponse(params: {
  item: GradableExpectations;
  hasError: boolean;
  responseText: string;
}): EvaluationOutcome {
  const base = evaluateTestOutcome(params);
  return withUnableToAssistFailureOverride(params.responseText, base, params.item);
}

/**
 * B0-755 — a decline-ness verdict from an LLM judge, independent of any fixed phrase list.
 * `rationale` is always populated (pass or fail) so a reviewer can see why the row was overridden.
 */
export type SemanticDeclineVerdict = {
  isDecline: boolean;
  rationale: string;
  /** B0-902 — the resolved model id / provider that produced the verdict, stamped by `gradeSemanticDecline`. */
  gradingModel?: string | null;
  gradingProvider?: 'openai' | 'anthropic' | null;
};

/**
 * Injected so `gradeChatTestResponseAsync` stays free of any OpenAI/network dependency and fully
 * unit-testable with a stub — the real implementation is `gradeSemanticDecline`
 * (`~/lib/tests/decline-grader.ts`), wired in by the one caller that needs it (`./runner.ts`).
 */
export type SemanticDeclineChecker = (input: {
  prompt: string;
  responseText: string;
  idealResponse: string | null;
  expectedConcepts: string | null;
  minimumConcepts: string | null;
}) => Promise<SemanticDeclineVerdict>;

/** Extra context `gradeChatTestResponseAsync` can hand the semantic-decline checker. */
export type DeclineGradingContext = {
  prompt: string;
  idealResponse?: string | null;
  expectedConcepts?: string | null;
  minimumConcepts?: string | null;
};

export type AsyncEvaluationOutcome = EvaluationOutcome & {
  /** Present only when the semantic-decline fallback below actually ran. */
  semanticDeclineCheck?: SemanticDeclineVerdict;
  /**
   * B0-902 — present only when the semantic-decline fallback was NEEDED but the grader model could
   * not judge it (refusal, truncation at the output cap, transport failure after retries). The row
   * stays failed on the deterministic verdict, and this carries why the LLM check never happened so
   * the failure is not misread as "the model confirmed this was not a decline".
   */
  semanticDeclineUnavailable?: { reason: string };
};

/**
 * B0-755 — async superset of `gradeChatTestResponse`.
 *
 * The exact-string fast path (`matchesCanonicalDeclineCopy`) and the phrase/regex heuristics in
 * `responseIndicatesDeclineStyleAnswer` stay first and are unchanged: a response that already
 * matches the app's own canonical decline copy, or one of the known phrasings, is unambiguously a
 * pass and costs nothing extra. This only escalates to an LLM semantic-decline judgement when ALL
 * of the following hold — i.e. exactly the class of bug B0-755 reports (a real decline in
 * different words), never a positive-expectation row or a row the heuristics already decided:
 *
 *   - the row expects no answer (`expected_should_answer === false`)
 *   - the model produced a non-empty response
 *   - the heuristic above did NOT recognize it as a decline (`base.passed === false`)
 *
 * A checker failure (refusal, truncation, network/parse error) falls back to the deterministic
 * verdict rather than silently passing the row — and, since B0-902, says so: the reason rides on
 * `semanticDeclineUnavailable` and is appended to `failureReason`, so an "unable to evaluate" is
 * never mistaken for a model verdict that the response answered the question.
 */
export async function gradeChatTestResponseAsync(params: {
  item: GradableExpectations;
  hasError: boolean;
  responseText: string;
  context: DeclineGradingContext;
  checkSemanticDecline: SemanticDeclineChecker;
}): Promise<AsyncEvaluationOutcome> {
  const base = gradeChatTestResponse(params);

  if (base.passed) {
    return base;
  }

  if (shouldExpectAnswer(params.item) !== false) {
    return base;
  }

  if (!params.responseText.trim()) {
    return base;
  }

  let verdict: SemanticDeclineVerdict;
  try {
    verdict = await params.checkSemanticDecline({
      prompt: params.context.prompt,
      responseText: params.responseText,
      idealResponse: params.context.idealResponse ?? null,
      expectedConcepts: params.context.expectedConcepts ?? null,
      minimumConcepts: params.context.minimumConcepts ?? null,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      passed: false,
      failureReason:
        `${base.failureReason ?? ''} Semantic decline check could not be evaluated: ${reason}`.trim(),
      semanticDeclineUnavailable: { reason },
    };
  }

  if (verdict.isDecline) {
    return { passed: true, failureReason: null, semanticDeclineCheck: verdict };
  }

  return {
    passed: false,
    failureReason: `${base.failureReason ?? ''} Semantic decline check: ${verdict.rationale}`.trim(),
    semanticDeclineCheck: verdict,
  };
}
