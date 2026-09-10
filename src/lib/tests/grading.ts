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

import { conceptPhrases, type CriteriaGradingOutcome } from './criteria-schemas';
import type { TestItemRecord } from './types';

/**
 * B0-537 — pure response-grading logic, extracted verbatim from `runner.ts` so the multi-turn
 * evaluator (`multi-turn-evaluator.ts`) can reuse per-turn grading without importing the runner
 * (which pulls in the live workflow/conversation stack). `runner.ts` re-exports
 * `gradeChatTestResponse`, so existing imports are unaffected.
 *
 * B0-932 — the behaviour axis is gone. `expected_should_answer` / `expected_result_type` were
 * dropped from `test_items`, and with them the rule that made "the row wanted an answer and the
 * model said something" a PASS regardless of whether the something was correct. **Mandatory
 * concept coverage is now the pass/fail axis** (mirroring the reference agent-evaluation skill's
 * `minimal_gate`):
 *
 *   an item passes when the run produced a non-empty answer without erroring AND every
 *   `minimum_concepts` phrase was judged satisfied — an item with no mandatory concepts has
 *   nothing to gate on and passes on having answered.
 *
 * The phrases themselves are judged by `gradeWithCriteria` (`./criteria-grader.ts`), which is
 * async and calls a model; this module stays pure and takes that verdict as an input
 * (`conceptGrading`). Items with no mandatory concepts are marked Unable to Evaluate by the
 * report pipeline (B0-826) — that is the report's call, not a fail here.
 */

/**
 * The grader only reads the concept columns off a test item, so per-turn expectations in
 * multi-turn scenarios can be graded with the exact same rules without fabricating a full DB row.
 */
export type GradableExpectations = Pick<
  TestItemRecord,
  'expected_concepts' | 'minimum_concepts' | 'expected_criteria'
>;

/** The item's mandatory phrases, `exact:` prefixes stripped. Empty = nothing to gate on. */
export function mandatoryConceptPhrases(item: GradableExpectations): string[] {
  return conceptPhrases(item.minimum_concepts).map((parsed) => parsed.concept);
}

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
 * the phrase/regex heuristics below don't cover, which previously meant a row that got one of those
 * two exact declines back was scored a false PASS instead of being flagged for review.
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
    // These are failures, not passes, unless the item's mandatory concepts were covered anyway.
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
 * B0-932 — how the mandatory concepts of one item were judged, as far as this pure module knows.
 *
 *  - `'satisfied'`    — every `minimum_concepts` phrase was met (`gradeWithCriteria` passed).
 *  - `'missed'`       — at least one mandatory phrase was not met, or the grader could not judge.
 *  - `'none'`         — the item declares no mandatory concepts: nothing to gate on.
 *  - `'unevaluated'`  — the item declares mandatory concepts but no verdict reached us.
 */
export type MandatoryConceptState = 'satisfied' | 'missed' | 'none' | 'unevaluated';

export function resolveMandatoryConceptState(
  item: GradableExpectations,
  conceptGrading: CriteriaGradingOutcome | null | undefined,
): MandatoryConceptState {
  if (mandatoryConceptPhrases(item).length === 0) {
    return 'none';
  }
  if (!conceptGrading) {
    return 'unevaluated';
  }
  return conceptGrading.passed ? 'satisfied' : 'missed';
}

/**
 * B0-932 — the pass rule, in code.
 *
 * A hard error or an empty response fails first (same two human-readable reasons as before,
 * reworded now that no column is named). Everything after that is mandatory concept coverage: an
 * item with mandatory concepts passes only when every one of them was judged satisfied, and an
 * item with none passes on having answered.
 */
function evaluateTestOutcome(params: {
  item: GradableExpectations;
  hasError: boolean;
  responseText: string;
  conceptGrading?: CriteriaGradingOutcome | null;
}): EvaluationOutcome {
  if (params.hasError) {
    return {
      passed: false,
      failureReason: 'The run reported an error before producing a final answer.',
    };
  }

  if (params.responseText.trim().length === 0) {
    return {
      passed: false,
      failureReason: 'The response text was empty, so no expected concept could be covered.',
    };
  }

  /**
   * B0-902 — the grader model could not judge this item (refusal, truncation at the output cap,
   * transport failure after retries). It is never a pass, even when the item declares nothing
   * mandatory: an item with only tier-2 concepts would otherwise fall through to "it answered".
   */
  if (params.conceptGrading?.unableToEvaluate) {
    return {
      passed: false,
      failureReason:
        params.conceptGrading.failureReason ??
        `Concept grading was unable to evaluate this item: ${
          params.conceptGrading.uteReason ?? 'the grader model returned no usable judgement.'
        }`,
    };
  }

  const state = resolveMandatoryConceptState(params.item, params.conceptGrading);

  switch (state) {
    case 'none':
      // Nothing to gate on. The run report marks these Unable to Evaluate (B0-826); the harness
      // does not invent a failure for an item that never said what a correct answer contains.
      return { passed: true, failureReason: null };

    case 'satisfied':
      return { passed: true, failureReason: null };

    case 'missed':
      return {
        passed: false,
        failureReason:
          params.conceptGrading?.failureReason ??
          'At least one mandatory concept (minimum_concepts) was not covered by the answer.',
      };

    case 'unevaluated':
      return {
        passed: false,
        failureReason:
          'Mandatory concept coverage could not be evaluated for this item, so it cannot be scored as a pass.',
      };
  }
}

function withUnableToAssistFailureOverride(
  responseText: string,
  outcome: EvaluationOutcome,
  mandatoryConceptState: MandatoryConceptState,
): EvaluationOutcome {
  const hasText = responseText.trim().length > 0;
  if (!hasText || !outcome.passed) {
    return outcome;
  }

  /**
   * B0-932 — an item whose mandatory concepts were all satisfied is exempt from the visibility
   * override. This is the honest version of what `expected_should_answer === false` was
   * approximating: the row said what a correct answer must contain, the answer contained it, and
   * a phrase list has no business re-failing a verdict the concept grader already approved —
   * least of all for a refusal the mandatory concepts themselves describe ("a cross-reference
   * match does not transfer claims between products").
   *
   * The override otherwise stays exactly as it was: a decline on an item whose mandatory concepts
   * were NOT covered — or which has none to cover — is still surfaced as a failure for review.
   */
  if (mandatoryConceptState === 'satisfied') {
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
 * Full pass/fail decision for a single chat test item: the error/emptiness gate, mandatory
 * concept coverage, and the "unable to assist" decline override. Exported so the grading behavior
 * can be unit-tested independently of the live workflow.
 *
 * `conceptGrading` is the `gradeWithCriteria` verdict for this item's criteria (built from the
 * three concept columns by `buildExpectedCriteria`). Omit it only when the item declares no
 * mandatory concepts — otherwise the item cannot be scored a pass and is failed as unevaluated,
 * rather than silently passing on "it said something", which is the exact bug B0-932 fixes.
 */
export function gradeChatTestResponse(params: {
  item: GradableExpectations;
  hasError: boolean;
  responseText: string;
  conceptGrading?: CriteriaGradingOutcome | null;
}): EvaluationOutcome {
  const base = evaluateTestOutcome(params);
  return withUnableToAssistFailureOverride(
    params.responseText,
    base,
    resolveMandatoryConceptState(params.item, params.conceptGrading),
  );
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
  /** B0-931/932 — the concept columns are `text[]`; one element per phrase, verbatim. */
  expectedConcepts: string[];
  minimumConcepts: string[];
}) => Promise<SemanticDeclineVerdict>;

/** Extra context `gradeChatTestResponseAsync` can hand the semantic-decline checker. */
export type DeclineGradingContext = {
  prompt: string;
  idealResponse?: string | null;
  expectedConcepts?: readonly string[] | null;
  minimumConcepts?: readonly string[] | null;
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
 * B0-755 — async superset of `gradeChatTestResponse`, and the last-resort path for an item whose
 * mandatory concepts could not be judged by `gradeWithCriteria`.
 *
 * B0-932 rewired the escalation. It used to be gated on `expected_should_answer === false` (a row
 * that wanted a decline); that column is gone, and the mandatory concepts now describe the correct
 * answer — a refusal included ("a cross-reference match does not transfer claims between
 * products"). So this escalates when, and only when, ALL of:
 *
 *   - the item declares mandatory concepts but no concept verdict reached the grader
 *     (`resolveMandatoryConceptState` → `'unevaluated'`; normally the criteria grader threw)
 *   - the model produced a non-empty response
 *   - the deterministic grade above failed the item (`base.passed === false`)
 *
 * An item whose concepts WERE judged is never escalated: `gradeWithCriteria` already made a
 * per-phrase semantic judgement, which is strictly better evidence than a decline/not-decline
 * verdict, and an item with no mandatory concepts has no ground truth for the checker to use.
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
  conceptGrading?: CriteriaGradingOutcome | null;
}): Promise<AsyncEvaluationOutcome> {
  const base = gradeChatTestResponse(params);

  if (base.passed) {
    return base;
  }

  if (resolveMandatoryConceptState(params.item, params.conceptGrading) !== 'unevaluated') {
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
      expectedConcepts: [...(params.context.expectedConcepts ?? [])],
      minimumConcepts: [...(params.context.minimumConcepts ?? [])],
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
