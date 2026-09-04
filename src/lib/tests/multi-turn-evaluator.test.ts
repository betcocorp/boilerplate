import { describe, expect, it } from 'vitest';

import { multiTurnScenarioSchema, type MultiTurnScenario } from './multi-turn';
import {
  evaluateMultiTurnScenario,
  evaluateScenarioAssertion,
  looksLikeRegulatedValue,
  matchTerm,
  type ExecutedTurn,
} from './multi-turn-evaluator';

/**
 * B0-538 — every assertion variant is tested both passing and failing, plus the regulated-value
 * guardrail. All assertions use structural expectations (product names, surfaces) except the two
 * regulated-matching tests, which use figures purely to prove the LITERAL matcher is engaged —
 * never as an authored expectation about a real product.
 */

function scenario(overrides: Partial<MultiTurnScenario> = {}): MultiTurnScenario {
  return multiTurnScenarioSchema.parse({
    version: 1,
    turns: [{ prompt: 'What is pH7Q used for?' }, { prompt: 'Is it safe on that surface?' }],
    ...overrides,
  });
}

function turn(overrides: Partial<ExecutedTurn> & { turnIndex: number }): ExecutedTurn {
  return {
    prompt: 'prompt',
    responseText: '',
    hasError: false,
    ...overrides,
  };
}

function turnsByIndex(turns: ExecutedTurn[]) {
  return new Map(turns.map((t) => [t.turnIndex, t]));
}

describe('matchTerm / looksLikeRegulatedValue', () => {
  it('treats prose terms as case-insensitive', () => {
    expect(matchTerm('pH7Q', 'We recommend PH7Q for that.')).toEqual({
      term: 'pH7Q',
      found: true,
      mode: 'case_insensitive',
    });
  });

  it.each([
    '4 oz/gal',
    '100 mL/L',
    '500 ppm',
    '0.5%',
    '1:64',
    '60 seconds',
    '10 minutes',
    'EPA Reg. No. 1839-83',
    '5-log reduction',
    '7681-52-9',
  ])('flags %s as a regulated value', (term) => {
    expect(looksLikeRegulatedValue(term)).toBe(true);
  });

  it('does not flag ordinary product/surface terms', () => {
    expect(looksLikeRegulatedValue('pH7Q')).toBe(false);
    expect(looksLikeRegulatedValue('sealed concrete')).toBe(false);
  });

  it('matches a regulated value literally, so a rounded or padded figure does NOT satisfy it', () => {
    // The whole point of routing these through gradeExactCriterion: no rounding, no conversion.
    expect(matchTerm('4 oz/gal', 'Use 4 oz/gal.')).toMatchObject({
      found: true,
      mode: 'exact_literal',
    });
    expect(matchTerm('4 oz/gal', 'Use 4.0 oz/gal.')).toMatchObject({ found: false });
    expect(matchTerm('4 oz/gal', 'Use 40 oz/gal.')).toMatchObject({ found: false });
  });

  it('inherits the shared exact rule (B0-803): case and whitespace runs normalise, punctuation does not', () => {
    // Same rule as criteria-grader.ts — the multi-turn path must never diverge from it.
    expect(matchTerm('EPA Reg. No. 1839-83', 'epa reg. no. 1839-83')).toMatchObject({
      found: true,
      mode: 'exact_literal',
    });
    expect(matchTerm('10 minutes', 'Keep wet for 10\nminutes.')).toMatchObject({
      found: true,
      mode: 'exact_literal',
    });
    // Dropping the periods is a different identifier, not a formatting variant.
    expect(matchTerm('EPA Reg. No. 1839-83', 'EPA Reg No 1839-83')).toMatchObject({
      found: false,
      mode: 'exact_literal',
    });
  });
});

describe('per-turn expectations', () => {
  it('delegates should_answer to the shared grader (a decline fails a positive turn)', () => {
    const result = evaluateMultiTurnScenario({
      scenario: scenario({
        turns: [
          { prompt: 'a' },
          { prompt: 'b', expectations: { should_answer: true } },
        ],
      }),
      turns: [
        turn({ turnIndex: 1, responseText: 'pH7Q is a neutral disinfectant cleaner.' }),
        turn({
          turnIndex: 2,
          responseText: "I don't have the verified information needed to answer that.",
        }),
      ],
    });

    expect(result.turnVerdicts[1].passed).toBe(false);
    expect(result.turnVerdicts[1].behaviorPassed).toBe(false);
    expect(result.passed).toBe(false);
  });

  it('passes must_mention / must_not_mention when satisfied', () => {
    const result = evaluateMultiTurnScenario({
      scenario: scenario({
        turns: [
          { prompt: 'a' },
          {
            prompt: 'b',
            expectations: {
              should_answer: true,
              must_mention: ['pH7Q'],
              must_not_mention: ['Bleach'],
            },
          },
        ],
      }),
      turns: [
        turn({ turnIndex: 1, responseText: 'pH7Q is a neutral disinfectant cleaner.' }),
        turn({ turnIndex: 2, responseText: 'Yes — pH7Q is labeled for that surface.' }),
      ],
    });

    expect(result.turnVerdicts[1].passed).toBe(true);
    expect(result.passed).toBe(true);
  });

  it('fails a turn missing a must_mention term and names it', () => {
    const result = evaluateMultiTurnScenario({
      scenario: scenario({
        turns: [
          { prompt: 'a' },
          { prompt: 'b', expectations: { must_mention: ['pH7Q'] } },
        ],
      }),
      turns: [
        turn({ turnIndex: 1, responseText: 'ok' }),
        turn({ turnIndex: 2, responseText: 'Yes, that works on the surface.' }),
      ],
    });

    expect(result.turnVerdicts[1].passed).toBe(false);
    expect(result.turnVerdicts[1].failureReason).toContain('pH7Q');
  });

  it('fails a turn containing a must_not_mention term', () => {
    const result = evaluateMultiTurnScenario({
      scenario: scenario({
        turns: [
          { prompt: 'a' },
          { prompt: 'b', expectations: { must_not_mention: ['Bleach'] } },
        ],
      }),
      turns: [
        turn({ turnIndex: 1, responseText: 'ok' }),
        turn({ turnIndex: 2, responseText: 'Try bleach instead.' }),
      ],
    });

    expect(result.turnVerdicts[1].passed).toBe(false);
    expect(result.turnVerdicts[1].failureReason).toContain('forbidden');
  });

  it('passes a turn with no expectations at all (mirrors expected_should_answer = null)', () => {
    const result = evaluateMultiTurnScenario({
      scenario: scenario(),
      turns: [
        turn({ turnIndex: 1, responseText: 'anything' }),
        turn({ turnIndex: 2, responseText: 'anything' }),
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.turnVerdicts.every((v) => v.passed)).toBe(true);
  });
});

describe('context_carry', () => {
  const assertion = {
    type: 'context_carry' as const,
    from_turn: 1,
    turn: 2,
    anchor: 'pH7Q',
    aliases: ['pH 7Q'],
  };

  it('passes when the later turn still names the anchor', () => {
    const verdict = evaluateScenarioAssertion({
      assertion,
      scenario: scenario(),
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, prompt: 'What is pH7Q for?', responseText: 'A disinfectant.' }),
        turn({
          turnIndex: 2,
          prompt: 'Is it safe on that surface?',
          responseText: 'Yes, pH 7Q is labeled for sealed concrete.',
        }),
      ]),
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.observed.matchedInResponse).toEqual(['pH 7Q']);
    expect(verdict.caveat).toBeUndefined();
  });

  it('fails when the later turn drops the anchor entirely', () => {
    const verdict = evaluateScenarioAssertion({
      assertion,
      scenario: scenario(),
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, prompt: 'What is pH7Q for?', responseText: 'A disinfectant.' }),
        turn({ turnIndex: 2, prompt: 'Is it safe?', responseText: 'Which product do you mean?' }),
      ]),
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('lost the turn-1 anchor');
  });

  it('flags a caveat when the later turn PROMPT restates the anchor (the pass proves nothing)', () => {
    const verdict = evaluateScenarioAssertion({
      assertion,
      scenario: scenario(),
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, prompt: 'What is pH7Q for?', responseText: 'A disinfectant.' }),
        turn({
          turnIndex: 2,
          prompt: 'Is pH7Q safe on sealed concrete?',
          responseText: 'Yes, pH7Q is labeled for it.',
        }),
      ]),
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.caveat).toContain('does not prove');
  });

  it('fails when the referenced turn never executed', () => {
    const verdict = evaluateScenarioAssertion({
      assertion,
      scenario: scenario(),
      turnsByIndex: turnsByIndex([turn({ turnIndex: 1, responseText: 'A disinfectant.' })]),
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.observed.missingTurn).toBe(2);
  });
});

describe('no_reask', () => {
  const assertion = {
    type: 'no_reask' as const,
    turn: 2,
    already_provided: ['sealed concrete'],
  };

  it('passes when the response merely restates the provided fact', () => {
    const verdict = evaluateScenarioAssertion({
      assertion,
      scenario: scenario(),
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, responseText: 'ok' }),
        turn({
          turnIndex: 2,
          responseText: 'For sealed concrete, pH7Q is the right choice.',
        }),
      ]),
    });

    expect(verdict.passed).toBe(true);
  });

  it('fails when the response asks again for the already-provided fact', () => {
    const verdict = evaluateScenarioAssertion({
      assertion,
      scenario: scenario(),
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, responseText: 'ok' }),
        turn({
          turnIndex: 2,
          responseText: 'Happy to help. What kind of surface is it — sealed concrete or tile?',
        }),
      ]),
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('asked again');
  });

  it('does not fail on a question that is about something else', () => {
    const verdict = evaluateScenarioAssertion({
      assertion,
      scenario: scenario(),
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, responseText: 'ok' }),
        turn({
          turnIndex: 2,
          responseText:
            'pH7Q works on sealed concrete. Would you like the application instructions?',
        }),
      ]),
    });

    expect(verdict.passed).toBe(true);
  });
});

describe('consistent_product_anchor', () => {
  const threeTurnScenario = scenario({
    turns: [{ prompt: 'a' }, { prompt: 'b' }, { prompt: 'c' }],
  });

  it('passes when no disallowed product appears', () => {
    const verdict = evaluateScenarioAssertion({
      assertion: {
        type: 'consistent_product_anchor',
        product: 'pH7Q',
        disallowed_products: ['Fight Bac'],
      },
      scenario: threeTurnScenario,
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, responseText: 'pH7Q is a disinfectant.' }),
        turn({ turnIndex: 2, responseText: 'It is labeled for that surface.' }),
        turn({ turnIndex: 3, responseText: 'Follow the label directions.' }),
      ]),
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.turns).toEqual([1, 2, 3]);
  });

  it('fails the turn that switched to a disallowed product', () => {
    const verdict = evaluateScenarioAssertion({
      assertion: {
        type: 'consistent_product_anchor',
        product: 'pH7Q',
        disallowed_products: ['Fight Bac'],
      },
      scenario: threeTurnScenario,
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, responseText: 'pH7Q is a disinfectant.' }),
        turn({ turnIndex: 2, responseText: 'Use Fight Bac RTU instead.' }),
        turn({ turnIndex: 3, responseText: 'pH7Q also works.' }),
      ]),
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.reason).toContain('Turn 2 switched');
  });

  it('require_mention fails a non-decline turn that never names the anchor', () => {
    const verdict = evaluateScenarioAssertion({
      assertion: {
        type: 'consistent_product_anchor',
        product: 'pH7Q',
        from_turn: 2,
        require_mention: true,
      },
      scenario: threeTurnScenario,
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, responseText: 'pH7Q is a disinfectant.' }),
        turn({ turnIndex: 2, responseText: 'Yes, that will work fine.' }),
        turn({ turnIndex: 3, responseText: 'pH7Q, per the label.' }),
      ]),
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.turns).toEqual([2, 3]);
    expect(verdict.reason).toContain('Turn 2 never named the anchor');
  });

  it('require_mention exempts a legitimate decline', () => {
    const verdict = evaluateScenarioAssertion({
      assertion: {
        type: 'consistent_product_anchor',
        product: 'pH7Q',
        from_turn: 2,
        require_mention: true,
      },
      scenario: threeTurnScenario,
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, responseText: 'pH7Q is a disinfectant.' }),
        turn({
          turnIndex: 2,
          responseText: "I don't have the verified information needed to answer that.",
        }),
        turn({ turnIndex: 3, responseText: 'pH7Q, per the label.' }),
      ]),
    });

    expect(verdict.passed).toBe(true);
  });
});

describe('mentions / not_mentions', () => {
  it('mentions passes on any one of the terms', () => {
    const verdict = evaluateScenarioAssertion({
      assertion: { type: 'mentions', turn: 2, any_of: ['SDS', 'safety data sheet'] },
      scenario: scenario(),
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, responseText: 'ok' }),
        turn({ turnIndex: 2, responseText: 'Check the Safety Data Sheet before use.' }),
      ]),
    });

    expect(verdict.passed).toBe(true);
    expect(verdict.observed.matched).toEqual(['safety data sheet']);
  });

  it('mentions fails when none appear', () => {
    const verdict = evaluateScenarioAssertion({
      assertion: { type: 'mentions', turn: 2, any_of: ['SDS', 'safety data sheet'] },
      scenario: scenario(),
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, responseText: 'ok' }),
        turn({ turnIndex: 2, responseText: 'It is fine to use.' }),
      ]),
    });

    expect(verdict.passed).toBe(false);
  });

  it('not_mentions passes when the forbidden terms are absent', () => {
    const verdict = evaluateScenarioAssertion({
      assertion: { type: 'not_mentions', turn: 1, none_of: ['Clorox'] },
      scenario: scenario(),
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, responseText: 'pH7Q is a Betco product.' }),
      ]),
    });

    expect(verdict.passed).toBe(true);
  });

  it('not_mentions fails and names the offending term', () => {
    const verdict = evaluateScenarioAssertion({
      assertion: { type: 'not_mentions', turn: 1, none_of: ['Clorox'] },
      scenario: scenario(),
      turnsByIndex: turnsByIndex([
        turn({ turnIndex: 1, responseText: 'You could also use Clorox.' }),
      ]),
    });

    expect(verdict.passed).toBe(false);
    expect(verdict.observed.found).toEqual(['Clorox']);
  });
});

describe('scenario aggregation', () => {
  const carryScenario = scenario({
    scenario_id: 'ph7q-carry',
    title: 'Follow-up keeps the product',
    turns: [
      { prompt: 'What is pH7Q used for?', expectations: { should_answer: true } },
      { prompt: 'Is it safe on that surface?', expectations: { should_answer: true } },
    ],
    assertions: [
      { type: 'context_carry', from_turn: 1, turn: 2, anchor: 'pH7Q' },
      { type: 'not_mentions', turn: 2, none_of: ['Clorox'] },
    ],
  });

  it('passes only when every turn and every assertion passes', () => {
    const result = evaluateMultiTurnScenario({
      scenario: carryScenario,
      turns: [
        turn({
          turnIndex: 1,
          prompt: 'What is pH7Q used for?',
          responseText: 'pH7Q is a neutral disinfectant cleaner.',
        }),
        turn({
          turnIndex: 2,
          prompt: 'Is it safe on that surface?',
          responseText: 'Yes, pH7Q is labeled for sealed concrete.',
        }),
      ],
    });

    expect(result.passed).toBe(true);
    expect(result.summary).toMatchObject({
      turnCount: 2,
      executedTurnCount: 2,
      passedTurnCount: 2,
      firstFailedTurn: null,
      reachedExpectedAnswerByFinalTurn: true,
      assertionCount: 2,
      passedAssertionCount: 2,
    });
    expect(result.failureReason).toBeNull();
  });

  it('fails the scenario when one assertion fails, and reports it', () => {
    const result = evaluateMultiTurnScenario({
      scenario: carryScenario,
      turns: [
        turn({ turnIndex: 1, responseText: 'pH7Q is a neutral disinfectant cleaner.' }),
        turn({ turnIndex: 2, responseText: 'You could also use Clorox on it.' }),
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.summary.passedAssertionCount).toBe(0);
    expect(result.failureReason).toContain('[context_carry]');
    expect(result.failureReason).toContain('[not_mentions]');
  });

  it('a truncated replay is a failure and records how far it got', () => {
    const result = evaluateMultiTurnScenario({
      scenario: carryScenario,
      turns: [
        turn({
          turnIndex: 1,
          responseText: '',
          hasError: true,
          errorMessage: 'connection reset',
        }),
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.summary.executedTurnCount).toBe(1);
    expect(result.summary.reachedExpectedAnswerByFinalTurn).toBe(false);
    expect(result.failureReason).toContain('Only 1 of 2 turns executed');
  });

  it('reachedExpectedAnswerByFinalTurn is true even when an earlier turn failed', () => {
    const result = evaluateMultiTurnScenario({
      scenario: scenario({
        turns: [
          { prompt: 'a', expectations: { must_mention: ['pH7Q'] } },
          { prompt: 'b', expectations: { should_answer: true } },
        ],
      }),
      turns: [
        turn({ turnIndex: 1, responseText: 'Which product do you mean?' }),
        turn({ turnIndex: 2, responseText: 'pH7Q is labeled for that surface.' }),
      ],
    });

    expect(result.passed).toBe(false);
    expect(result.summary.firstFailedTurn).toBe(1);
    expect(result.summary.reachedExpectedAnswerByFinalTurn).toBe(true);
  });
});
