import { describe, expect, it } from 'vitest';

import {
  extractMultiTurnResult,
  summarizeMultiTurnRun,
  SCENARIO_ASSERTION_TYPES,
  type MultiTurnResultPayload,
} from './multi-turn-result';

function payload(overrides: Partial<MultiTurnResultPayload> = {}): MultiTurnResultPayload {
  return {
    version: 1,
    scenarioId: 'carry-1',
    title: 'Follow-up keeps the product',
    passed: true,
    summary: {
      turnCount: 2,
      executedTurnCount: 2,
      passedTurnCount: 2,
      firstFailedTurn: null,
      reachedExpectedAnswerByFinalTurn: true,
      assertionCount: 1,
      passedAssertionCount: 1,
    },
    turns: [],
    assertions: [
      {
        type: 'context_carry',
        turns: [1, 2],
        passed: true,
        reason: 'carried',
      },
    ],
    routingComparisonScope: 'first_turn_only',
    conversationId: 'conv-1',
    historyCapAtRisk: false,
    ...overrides,
  };
}

describe('SCENARIO_ASSERTION_TYPES', () => {
  it('stays derived from the frozen assertion union', () => {
    expect([...SCENARIO_ASSERTION_TYPES].sort()).toEqual([
      'consistent_product_anchor',
      'context_carry',
      'mentions',
      'no_reask',
      'not_mentions',
    ]);
  });
});

describe('extractMultiTurnResult', () => {
  it('returns null for every single-turn payload shape', () => {
    expect(extractMultiTurnResult(null)).toBeNull();
    expect(extractMultiTurnResult({})).toBeNull();
    expect(extractMultiTurnResult({ answerText: 'hi', workflowRunId: 'x' })).toBeNull();
    expect(extractMultiTurnResult('not an object')).toBeNull();
    expect(extractMultiTurnResult([1, 2])).toBeNull();
  });

  it('returns null for a malformed multi-turn block rather than throwing', () => {
    expect(extractMultiTurnResult({ multiTurn: { version: 99 } })).toBeNull();
  });

  it('parses a well-formed block', () => {
    const extracted = extractMultiTurnResult({ multiTurn: payload() });
    expect(extracted?.scenarioId).toBe('carry-1');
    expect(extracted?.summary.turnCount).toBe(2);
  });
});

describe('summarizeMultiTurnRun', () => {
  it('returns null when the run has no multi-turn items', () => {
    expect(summarizeMultiTurnRun([null, {}, { answerText: 'x' }])).toBeNull();
  });

  it('aggregates scenarios, turns, and assertions by type', () => {
    const summary = summarizeMultiTurnRun([
      { answerText: 'single turn row' },
      { multiTurn: payload() },
      {
        multiTurn: payload({
          passed: false,
          summary: {
            turnCount: 3,
            executedTurnCount: 3,
            passedTurnCount: 2,
            firstFailedTurn: 2,
            reachedExpectedAnswerByFinalTurn: true,
            assertionCount: 2,
            passedAssertionCount: 1,
          },
          assertions: [
            { type: 'context_carry', turns: [1, 3], passed: false, reason: 'lost' },
            { type: 'not_mentions', turns: [3], passed: true, reason: 'clean' },
          ],
        }),
      },
    ]);

    expect(summary).toMatchObject({
      scenarioCount: 2,
      scenariosPassed: 1,
      turnCount: 5,
      turnsPassed: 4,
      reachedExpectedAnswerByFinalTurn: 2,
      assertionCount: 3,
      assertionsPassed: 2,
    });
    expect(summary?.assertionsByType).toEqual([
      { type: 'context_carry', total: 2, passed: 1 },
      { type: 'not_mentions', total: 1, passed: 1 },
    ]);
  });
});
