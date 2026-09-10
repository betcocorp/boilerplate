import { gradeExactCriterion } from './criteria-grader';
import type { CriteriaGradingOutcome } from './criteria-schemas';
import { gradeChatTestResponse, responseIndicatesDeclineStyleAnswer } from './grading';
import type { MultiTurnScenario, ScenarioAssertion } from './multi-turn';

/**
 * B0-538 — assertion evaluator for multi-turn expectations.
 *
 * Two layers, both pure and deterministic:
 *
 *  1. **Per-turn grading** — each turn's own `expectations` are graded by the SAME
 *     `gradeChatTestResponse` the single-turn harness uses (`./grading`), so the B0-932 pass rule
 *     (error/emptiness gate, then mandatory concept coverage) can never drift between the two
 *     formats. `must_mention` / `must_not_mention` are graded here, because they are not part of
 *     `GradableExpectations`.
 *  2. **Scenario assertions** — the cross-turn checks per-turn expectations cannot express
 *     (`context_carry`, `no_reask`, `consistent_product_anchor`, `mentions`, `not_mentions`).
 *
 * REGULATED-DATA RULE (org policy, non-negotiable): no LLM judge, no fuzzy matching, and no unit
 * conversion ever touches a regulated value. Any expectation term that *looks* like one (see
 * {@link looksLikeRegulatedValue}) is matched with {@link gradeExactCriterion} — a literal
 * substring check that normalises case and whitespace runs ONLY (B0-803), so digits, units and
 * punctuation must appear exactly as printed: "4 oz/gal" can never be satisfied by "4.0 oz/gal" or
 * "40 oz/gal". Ordinary prose terms (product names, brands, surfaces) are a plain case-insensitive
 * substring check. The term and response are handed to `gradeExactCriterion` untouched — it owns
 * the normalisation, nothing here pre-processes either side.
 */

/** How a term was matched against a response — surfaced on every verdict for auditability. */
export type TermMatchMode = 'exact_literal' | 'case_insensitive';

export type TermMatch = {
  term: string;
  found: boolean;
  mode: TermMatchMode;
};

/**
 * Digits paired with a unit, a ratio, or a regulatory identifier — the value families the org rule
 * names. Deliberately over-inclusive: a false positive only makes a match STRICTER (literal instead
 * of case-insensitive), which is the safe direction to be wrong in.
 */
const REGULATED_VALUE_PATTERNS: RegExp[] = [
  // Dilution / concentration units attached to a number: 4 oz/gal, 100 mL/L, 0.5 %, 500 ppm
  /\d\s*(?:oz|fl\s*oz|ounces?)\s*(?:\/|\s+per\s+)\s*(?:gal|gallon)/i,
  /\d\s*(?:ml|millilit(?:er|re)s?)\s*(?:\/|\s+per\s+)\s*(?:l|lit(?:er|re)s?)/i,
  /\d\s*(?:ppm|ppb)\b/i,
  /\d\s*%/,
  // Ratios: 1:10, 1:64
  /\b\d+\s*:\s*\d+\b/,
  // Contact / dwell times: 60 seconds, 10 minutes, 5 min
  /\d\s*(?:seconds?|secs?|minutes?|mins?|hours?|hrs?)\b/i,
  // Regulatory identifiers
  /\bEPA\s*Reg/i,
  /\bDIN\b/,
  /\bCAS\b/i,
  /\b\d{2,7}-\d{2}-\d\b/,
  // Efficacy: 99.999%, 5-log, log reduction
  /\blog\s*(?:-|\s)?\s*(?:\d|reduction)/i,
];

/** True when a term carries a regulated value that must be matched literally, never fuzzily. */
export function looksLikeRegulatedValue(term: string): boolean {
  return REGULATED_VALUE_PATTERNS.some((pattern) => pattern.test(term));
}

/**
 * Single entry point for "does this response contain this expectation term". Regulated-looking
 * terms go through the literal `gradeExactCriterion` guardrail; everything else is a
 * case-insensitive substring check (product/brand names are typed inconsistently by design).
 */
export function matchTerm(term: string, responseText: string): TermMatch {
  if (looksLikeRegulatedValue(term)) {
    return {
      term,
      found: gradeExactCriterion(term, responseText).met,
      mode: 'exact_literal',
    };
  }

  return {
    term,
    found: responseText.toLowerCase().includes(term.toLowerCase()),
    mode: 'case_insensitive',
  };
}

function matchAnyTerm(terms: readonly string[], responseText: string): TermMatch[] {
  return terms.map((term) => matchTerm(term, responseText));
}

function foundTerms(matches: TermMatch[]): string[] {
  return matches.filter((match) => match.found).map((match) => match.term);
}

function missingTerms(matches: TermMatch[]): string[] {
  return matches.filter((match) => !match.found).map((match) => match.term);
}

/** One executed turn, as handed to the evaluator by the runner. */
export type ExecutedTurn = {
  /** 1-based position in `scenario.turns`. */
  turnIndex: number;
  prompt: string;
  responseText: string;
  /** True when the turn threw / never produced a final answer. */
  hasError: boolean;
  errorMessage?: string | null;
  elapsedMs?: number;
  ttftMs?: number | null;
  conversationId?: string | null;
  workflowRunId?: string | null;
  /**
   * B0-932 — `gradeWithCriteria`'s verdict on this turn's own `minimum_concepts` /
   * `expected_concepts`, computed by the runner (the model call cannot happen inside this pure
   * evaluator). Absent when the turn declares no concepts; absent WITH declared concepts means
   * the coverage was never judged, and the turn fails as unevaluated rather than passing.
   */
  conceptGrading?: CriteriaGradingOutcome | null;
};

/** Verdict for one turn's own expectations. */
export type TurnVerdict = {
  turnIndex: number;
  passed: boolean;
  /** Null when the turn passed. */
  failureReason: string | null;
  /**
   * `gradeChatTestResponse`'s own outcome for this turn — since B0-932 that is the error/emptiness
   * gate plus mandatory concept coverage, not a behaviour flag. The field name is kept because it
   * is persisted on `response_payload.multiTurn.turns[].behaviorPassed` and rendered by the run
   * detail UI; renaming it would orphan every stored payload.
   */
  behaviorPassed: boolean;
  mustMention: TermMatch[];
  mustNotMention: TermMatch[];
  /** True when the response matched the shared decline heuristics (context for reviewers). */
  declined: boolean;
};

export type AssertionVerdict = {
  type: ScenarioAssertion['type'];
  /** Every turn index this assertion inspected, 1-based and ascending. */
  turns: number[];
  passed: boolean;
  /** Structured evidence — what was actually observed, for the run detail UI and exports. */
  observed: Record<string, unknown>;
  /** Human-readable explanation, always populated (pass or fail). */
  reason: string;
  /** The assertion's own author-supplied `description`, when present. */
  description?: string;
  /**
   * Set when the assertion passed but does not actually prove what it intends to (e.g. a
   * `context_carry` whose own turn prompt restates the anchor). Never affects `passed`.
   */
  caveat?: string;
};

export type MultiTurnScenarioEvaluation = {
  passed: boolean;
  turnVerdicts: TurnVerdict[];
  assertionVerdicts: AssertionVerdict[];
  summary: MultiTurnSummary;
  /** Failure headline for `test_result_items.error_message`; null when the scenario passed. */
  failureReason: string | null;
};

export type MultiTurnSummary = {
  /** Turns the scenario declares. */
  turnCount: number;
  /** Turns that actually executed (fewer when a turn errored and the replay stopped). */
  executedTurnCount: number;
  passedTurnCount: number;
  /** 1-based index of the earliest failing turn, or null when every executed turn passed. */
  firstFailedTurn: number | null;
  /**
   * "Did it reach the right answer by turn N" — whether the LAST declared turn executed and
   * satisfied its own expectations. This is the headline multi-turn metric: a scenario can stumble
   * mid-conversation and still land the answer, and that is a materially different outcome from
   * never getting there.
   */
  reachedExpectedAnswerByFinalTurn: boolean;
  assertionCount: number;
  passedAssertionCount: number;
};

function expectationsFor(scenario: MultiTurnScenario, turnIndex: number) {
  return scenario.turns[turnIndex - 1]?.expectations;
}

/**
 * Grades one turn. The turn's concept expectations are delegated verbatim to
 * `gradeChatTestResponse`, so a turn is judged by the same B0-932 rule as a single-turn item: a
 * turn with no mandatory concepts passes as long as it answered without erroring.
 */
function evaluateTurn(scenario: MultiTurnScenario, turn: ExecutedTurn): TurnVerdict {
  const expectations = expectationsFor(scenario, turn.turnIndex);

  const behavior = gradeChatTestResponse({
    item: {
      minimum_concepts: expectations?.minimum_concepts ?? [],
      expected_concepts: expectations?.expected_concepts ?? [],
      expected_criteria: [],
    },
    hasError: turn.hasError,
    responseText: turn.responseText,
    conceptGrading: turn.conceptGrading ?? null,
  });

  const mustMention = matchAnyTerm(expectations?.must_mention ?? [], turn.responseText);
  const mustNotMention = matchAnyTerm(expectations?.must_not_mention ?? [], turn.responseText);

  const missing = missingTerms(mustMention);
  const forbidden = foundTerms(mustNotMention);

  const reasons: string[] = [];
  if (!behavior.passed && behavior.failureReason) {
    reasons.push(behavior.failureReason);
  }
  if (turn.hasError && turn.errorMessage) {
    reasons.push(`Turn ${turn.turnIndex} errored: ${turn.errorMessage}`);
  }
  if (missing.length > 0) {
    reasons.push(
      `Turn ${turn.turnIndex} response is missing required term(s): ${missing.join(', ')}.`,
    );
  }
  if (forbidden.length > 0) {
    reasons.push(
      `Turn ${turn.turnIndex} response contains forbidden term(s): ${forbidden.join(', ')}.`,
    );
  }

  const passed = behavior.passed && missing.length === 0 && forbidden.length === 0;

  return {
    turnIndex: turn.turnIndex,
    passed,
    failureReason: passed ? null : reasons.join(' '),
    behaviorPassed: behavior.passed,
    mustMention,
    mustNotMention,
    declined: responseIndicatesDeclineStyleAnswer(turn.responseText),
  };
}

/** Terms that count as "the anchor" — the anchor itself plus any declared aliases. */
function anchorTerms(anchor: string, aliases?: readonly string[]): string[] {
  return [anchor, ...(aliases ?? [])];
}

function missingTurnVerdict(
  assertion: ScenarioAssertion,
  turns: number[],
  missingTurn: number,
): AssertionVerdict {
  return {
    type: assertion.type,
    turns,
    passed: false,
    observed: { missingTurn },
    reason: `Turn ${missingTurn} never produced a response, so this ${assertion.type} assertion could not be satisfied.`,
    description: assertion.description,
  };
}

/**
 * Sentences in which the assistant is asking the user for information. Used by `no_reask`: a
 * response may legitimately mention an already-provided fact (restating it is good behaviour); what
 * fails is asking for it *again*.
 */
const REASK_PATTERNS: RegExp[] = [
  /\b(?:could|can|would)\s+you\s+(?:please\s+)?(?:tell|share|confirm|specify|provide|clarify|let me know)\b/i,
  /\bplease\s+(?:tell|share|confirm|specify|provide|clarify|let me know)\b/i,
  /\bwhat\s+(?:is|are|kind of|type of|sort of)\b/i,
  /\bwhich\s+\w+\s+(?:are|is|do|did|would)\b/i,
  /\bneed\s+to\s+know\b/i,
  /\b(?:need|require)s?\s+more\s+(?:detail|information|specifics)/i,
  /\bcould you clarify\b/i,
];

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function isReaskSentence(sentence: string): boolean {
  if (REASK_PATTERNS.some((pattern) => pattern.test(sentence))) {
    return true;
  }
  return sentence.trimEnd().endsWith('?');
}

function evaluateContextCarry(
  assertion: Extract<ScenarioAssertion, { type: 'context_carry' }>,
  turnsByIndex: Map<number, ExecutedTurn>,
): AssertionVerdict {
  const turns = [assertion.from_turn, assertion.turn];
  const target = turnsByIndex.get(assertion.turn);
  if (!target) {
    return missingTurnVerdict(assertion, turns, assertion.turn);
  }

  const terms = anchorTerms(assertion.anchor, assertion.aliases);
  const inResponse = matchAnyTerm(terms, target.responseText);
  const inPrompt = matchAnyTerm(terms, target.prompt);
  const carried = inResponse.some((match) => match.found);
  const promptRestatedAnchor = inPrompt.some((match) => match.found);

  return {
    type: 'context_carry',
    turns,
    passed: carried,
    observed: {
      anchor: assertion.anchor,
      aliases: assertion.aliases ?? [],
      matchedInResponse: foundTerms(inResponse),
      matchMode: inResponse[0]?.mode ?? 'case_insensitive',
      promptRestatedAnchor,
    },
    reason: carried
      ? `Turn ${assertion.turn} carried "${assertion.anchor}" (matched ${foundTerms(inResponse).join(', ')}) from turn ${assertion.from_turn}.`
      : `Turn ${assertion.turn} lost the turn-${assertion.from_turn} anchor "${assertion.anchor}" — neither it nor any alias (${terms.join(', ')}) appears in the response.`,
    description: assertion.description,
    caveat:
      carried && promptRestatedAnchor
        ? `Turn ${assertion.turn}'s own prompt restates the anchor, so this pass does not prove the model carried context on its own.`
        : undefined,
  };
}

function evaluateNoReask(
  assertion: Extract<ScenarioAssertion, { type: 'no_reask' }>,
  turnsByIndex: Map<number, ExecutedTurn>,
): AssertionVerdict {
  const turns = [assertion.turn];
  const target = turnsByIndex.get(assertion.turn);
  if (!target) {
    return missingTurnVerdict(assertion, turns, assertion.turn);
  }

  const reaskSentences = splitSentences(target.responseText).filter(isReaskSentence);
  const offenders: Array<{ term: string; sentence: string }> = [];

  for (const sentence of reaskSentences) {
    for (const term of assertion.already_provided) {
      if (matchTerm(term, sentence).found) {
        offenders.push({ term, sentence });
      }
    }
  }

  const passed = offenders.length === 0;

  return {
    type: 'no_reask',
    turns,
    passed,
    observed: {
      alreadyProvided: assertion.already_provided,
      reaskSentenceCount: reaskSentences.length,
      offenders,
    },
    reason: passed
      ? `Turn ${assertion.turn} did not ask again for any already-provided fact (${assertion.already_provided.join(', ')}).`
      : `Turn ${assertion.turn} asked again for already-provided ${offenders
          .map((offender) => `"${offender.term}"`)
          .join(', ')} — e.g. “${offenders[0]?.sentence}”.`,
    description: assertion.description,
  };
}

function evaluateConsistentProductAnchor(
  assertion: Extract<ScenarioAssertion, { type: 'consistent_product_anchor' }>,
  scenario: MultiTurnScenario,
  turnsByIndex: Map<number, ExecutedTurn>,
): AssertionVerdict {
  const fromTurn = assertion.from_turn ?? 1;
  const turns: number[] = [];
  for (let index = fromTurn; index <= scenario.turns.length; index += 1) {
    turns.push(index);
  }

  const terms = anchorTerms(assertion.product, assertion.aliases);
  const failures: Array<{ turnIndex: number; problem: string; detail: string[] }> = [];
  const inspected: Array<{
    turnIndex: number;
    declined: boolean;
    mentionedAnchor: boolean;
    disallowedFound: string[];
  }> = [];

  for (const turnIndex of turns) {
    const turn = turnsByIndex.get(turnIndex);
    if (!turn) {
      // A scenario cut short by an error is reported on the turn verdicts, not doubled up here.
      continue;
    }

    // Per the contract: an anchored turn that legitimately declines is exempt from `require_mention`
    // (a decline has no product to anchor on) but is NOT exempt from `disallowed_products`.
    const declined = responseIndicatesDeclineStyleAnswer(turn.responseText);
    const anchorMatches = matchAnyTerm(terms, turn.responseText);
    const mentionedAnchor = anchorMatches.some((match) => match.found);
    const disallowedFound = foundTerms(
      matchAnyTerm(assertion.disallowed_products ?? [], turn.responseText),
    );

    inspected.push({ turnIndex, declined, mentionedAnchor, disallowedFound });

    if (disallowedFound.length > 0) {
      failures.push({
        turnIndex,
        problem: 'switched_product',
        detail: disallowedFound,
      });
    }

    if (assertion.require_mention && !declined && !mentionedAnchor) {
      failures.push({ turnIndex, problem: 'anchor_not_mentioned', detail: terms });
    }
  }

  const passed = failures.length === 0;

  return {
    type: 'consistent_product_anchor',
    turns,
    passed,
    observed: {
      product: assertion.product,
      aliases: assertion.aliases ?? [],
      fromTurn,
      requireMention: assertion.require_mention ?? false,
      disallowedProducts: assertion.disallowed_products ?? [],
      inspected,
    },
    reason: passed
      ? `Every executed turn from ${fromTurn} onward stayed anchored on "${assertion.product}".`
      : failures
          .map((failure) =>
            failure.problem === 'switched_product'
              ? `Turn ${failure.turnIndex} switched to a disallowed product (${failure.detail.join(', ')}) instead of staying on "${assertion.product}".`
              : `Turn ${failure.turnIndex} never named the anchor "${assertion.product}" (or an alias) even though require_mention is on.`,
          )
          .join(' '),
    description: assertion.description,
  };
}

function evaluateMentions(
  assertion: Extract<ScenarioAssertion, { type: 'mentions' }>,
  turnsByIndex: Map<number, ExecutedTurn>,
): AssertionVerdict {
  const turns = [assertion.turn];
  const target = turnsByIndex.get(assertion.turn);
  if (!target) {
    return missingTurnVerdict(assertion, turns, assertion.turn);
  }

  const matches = matchAnyTerm(assertion.any_of, target.responseText);
  const matched = foundTerms(matches);
  const passed = matched.length > 0;

  return {
    type: 'mentions',
    turns,
    passed,
    observed: {
      anyOf: assertion.any_of,
      matched,
      modes: matches.map((match) => ({ term: match.term, mode: match.mode })),
    },
    reason: passed
      ? `Turn ${assertion.turn} mentioned ${matched.join(', ')}.`
      : `Turn ${assertion.turn} mentioned none of: ${assertion.any_of.join(', ')}.`,
    description: assertion.description,
  };
}

function evaluateNotMentions(
  assertion: Extract<ScenarioAssertion, { type: 'not_mentions' }>,
  turnsByIndex: Map<number, ExecutedTurn>,
): AssertionVerdict {
  const turns = [assertion.turn];
  const target = turnsByIndex.get(assertion.turn);
  if (!target) {
    return missingTurnVerdict(assertion, turns, assertion.turn);
  }

  const matches = matchAnyTerm(assertion.none_of, target.responseText);
  const found = foundTerms(matches);
  const passed = found.length === 0;

  return {
    type: 'not_mentions',
    turns,
    passed,
    observed: {
      noneOf: assertion.none_of,
      found,
      modes: matches.map((match) => ({ term: match.term, mode: match.mode })),
    },
    reason: passed
      ? `Turn ${assertion.turn} mentioned none of the forbidden terms.`
      : `Turn ${assertion.turn} mentioned forbidden term(s): ${found.join(', ')}.`,
    description: assertion.description,
  };
}

export function evaluateScenarioAssertion(params: {
  assertion: ScenarioAssertion;
  scenario: MultiTurnScenario;
  turnsByIndex: Map<number, ExecutedTurn>;
}): AssertionVerdict {
  const { assertion, scenario, turnsByIndex } = params;
  switch (assertion.type) {
    case 'context_carry':
      return evaluateContextCarry(assertion, turnsByIndex);
    case 'no_reask':
      return evaluateNoReask(assertion, turnsByIndex);
    case 'consistent_product_anchor':
      return evaluateConsistentProductAnchor(assertion, scenario, turnsByIndex);
    case 'mentions':
      return evaluateMentions(assertion, turnsByIndex);
    case 'not_mentions':
      return evaluateNotMentions(assertion, turnsByIndex);
  }
}

/**
 * Full pass/fail decision for one multi-turn scenario. Pure: takes the already-executed turns and
 * returns verdicts — no I/O, no model calls, so it is unit-testable and cheap to re-run over a
 * stored payload.
 *
 * A scenario passes only when EVERY declared turn executed, every executed turn satisfied its own
 * expectations, and every scenario assertion held. Partial execution (a turn threw) is a failure by
 * construction, since the later turns' context could not be established.
 */
export function evaluateMultiTurnScenario(params: {
  scenario: MultiTurnScenario;
  turns: ExecutedTurn[];
}): MultiTurnScenarioEvaluation {
  const { scenario } = params;
  const executed = [...params.turns].sort((a, b) => a.turnIndex - b.turnIndex);
  const turnsByIndex = new Map(executed.map((turn) => [turn.turnIndex, turn]));

  const turnVerdicts = executed.map((turn) => evaluateTurn(scenario, turn));
  const assertionVerdicts = (scenario.assertions ?? []).map((assertion) =>
    evaluateScenarioAssertion({ assertion, scenario, turnsByIndex }),
  );

  const passedTurnCount = turnVerdicts.filter((verdict) => verdict.passed).length;
  const firstFailedTurn =
    turnVerdicts.find((verdict) => !verdict.passed)?.turnIndex ?? null;
  const finalTurnVerdict = turnVerdicts.find(
    (verdict) => verdict.turnIndex === scenario.turns.length,
  );

  const summary: MultiTurnSummary = {
    turnCount: scenario.turns.length,
    executedTurnCount: executed.length,
    passedTurnCount,
    firstFailedTurn,
    reachedExpectedAnswerByFinalTurn: finalTurnVerdict?.passed ?? false,
    assertionCount: assertionVerdicts.length,
    passedAssertionCount: assertionVerdicts.filter((verdict) => verdict.passed).length,
  };

  const incomplete = executed.length < scenario.turns.length;
  const passed =
    !incomplete &&
    passedTurnCount === turnVerdicts.length &&
    summary.passedAssertionCount === summary.assertionCount;

  const failureParts: string[] = [];
  if (incomplete) {
    failureParts.push(
      `Only ${executed.length} of ${scenario.turns.length} turns executed.`,
    );
  }
  for (const verdict of turnVerdicts) {
    if (!verdict.passed && verdict.failureReason) {
      failureParts.push(verdict.failureReason);
    }
  }
  for (const verdict of assertionVerdicts) {
    if (!verdict.passed) {
      failureParts.push(`[${verdict.type}] ${verdict.reason}`);
    }
  }

  return {
    passed,
    turnVerdicts,
    assertionVerdicts,
    summary,
    failureReason: passed ? null : failureParts.join(' '),
  };
}
