import { z } from 'zod';

import { scenarioAssertionSchema, type ScenarioAssertion } from './multi-turn';

/**
 * B0-537 — the shape written onto `test_result_items.response_payload.multiTurn`.
 *
 * **Persistence decision (one row per item, turns in the payload).** `test_result_items` is
 * strictly one row per `test_items` row — there is no `turn_index` column anywhere, and the run
 * detail table, `./report/metrics.ts`, `./run-comparison-diff.ts` and the
 * `latest_failed_test_result_items` view all assume that. So a scenario stays ONE row: `passed` and
 * `elapsed_ms` are scenario-level rollups, and the per-turn detail lives here on the payload. This
 * is exactly how `expected_criteria` / `criteriaGrading` was landed (B0-616) and it needs no
 * migration.
 *
 * The row's other payload fields are the **final** turn's workflow result, so every existing
 * extractor in `./response-payload.ts` (routing decision, similarity, prompt version, retrieval
 * strategy, timing) keeps working on a multi-turn row; per-turn `workflowRunId`s are recorded below
 * so every turn's trace stays reachable.
 */
export const MULTI_TURN_RESULT_PAYLOAD_KEY = 'multiTurn';

const termMatchSchema = z.object({
  term: z.string(),
  found: z.boolean(),
  mode: z.enum(['exact_literal', 'case_insensitive']),
});

export const multiTurnTurnResultSchema = z.object({
  turnIndex: z.number().int().min(1),
  prompt: z.string(),
  responseText: z.string(),
  passed: z.boolean(),
  failureReason: z.string().nullable(),
  behaviorPassed: z.boolean(),
  declined: z.boolean(),
  mustMention: z.array(termMatchSchema),
  mustNotMention: z.array(termMatchSchema),
  hasError: z.boolean(),
  errorMessage: z.string().nullable(),
  elapsedMs: z.number().nullable(),
  ttftMs: z.number().nullable(),
  conversationId: z.string().nullable(),
  workflowRunId: z.string().nullable(),
});

export type MultiTurnTurnResult = z.infer<typeof multiTurnTurnResultSchema>;

/**
 * Derived from the frozen `scenarioAssertionSchema` union rather than re-listed, so adding a
 * variant there automatically widens what can be persisted and rendered.
 */
export const SCENARIO_ASSERTION_TYPES = scenarioAssertionSchema.options.map(
  (option) => option.shape.type.value,
) as [ScenarioAssertion['type'], ...ScenarioAssertion['type'][]];

export const multiTurnAssertionResultSchema = z.object({
  type: z.enum(SCENARIO_ASSERTION_TYPES),
  turns: z.array(z.number().int().min(1)),
  passed: z.boolean(),
  reason: z.string(),
  description: z.string().optional(),
  caveat: z.string().optional(),
  observed: z.record(z.string(), z.unknown()).optional(),
});

export type MultiTurnAssertionResult = z.infer<typeof multiTurnAssertionResultSchema>;

export const multiTurnSummarySchema = z.object({
  turnCount: z.number().int().min(0),
  executedTurnCount: z.number().int().min(0),
  passedTurnCount: z.number().int().min(0),
  firstFailedTurn: z.number().int().min(1).nullable(),
  reachedExpectedAnswerByFinalTurn: z.boolean(),
  assertionCount: z.number().int().min(0),
  passedAssertionCount: z.number().int().min(0),
});

export const multiTurnResultPayloadSchema = z.object({
  /** Payload version — bump alongside `multiTurnScenarioSchema.version`. */
  version: z.literal(1),
  scenarioId: z.string().nullable(),
  title: z.string().nullable(),
  passed: z.boolean(),
  summary: multiTurnSummarySchema,
  turns: z.array(multiTurnTurnResultSchema),
  assertions: z.array(multiTurnAssertionResultSchema),
  /**
   * Which turn's routing the B0-500/B0-501 comparison columns describe. Recorded explicitly
   * because those columns are one-per-result-item, so a scenario can only be represented by one
   * turn — see `computeRoutingComparisonForItem` in `./run-executor.ts`.
   */
  routingComparisonScope: z.literal('first_turn_only'),
  /** The conversation every turn shared, i.e. the thread the replay actually built. */
  conversationId: z.string().nullable(),
  /** True when `capConversationHistory` would drop the earliest turns from the model's view. */
  historyCapAtRisk: z.boolean(),
});

export type MultiTurnResultPayload = z.infer<typeof multiTurnResultPayloadSchema>;

/**
 * Reads the multi-turn block off a stored `response_payload`. Returns null for every single-turn
 * row (the entire pre-B0-537 corpus) and for a malformed block, so callers degrade to the existing
 * single-turn rendering instead of throwing on a page render.
 */
export function extractMultiTurnResult(responsePayload: unknown): MultiTurnResultPayload | null {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const candidate = (responsePayload as Record<string, unknown>)[
    MULTI_TURN_RESULT_PAYLOAD_KEY
  ];
  if (candidate === undefined || candidate === null) {
    return null;
  }

  const parsed = multiTurnResultPayloadSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** Per-assertion-type roll-up for the run detail panel. */
export type MultiTurnAssertionTypeStats = {
  type: MultiTurnAssertionResult['type'];
  total: number;
  passed: number;
};

export type MultiTurnRunSummary = {
  scenarioCount: number;
  scenariosPassed: number;
  turnCount: number;
  turnsPassed: number;
  /** How many scenarios satisfied their FINAL turn's expectations — "right answer by turn N". */
  reachedExpectedAnswerByFinalTurn: number;
  assertionCount: number;
  assertionsPassed: number;
  assertionsByType: MultiTurnAssertionTypeStats[];
};

/**
 * B0-537 metric — aggregates every multi-turn result item in a run. Returns null when the run has
 * no multi-turn items, so the caller can skip the panel entirely rather than render an empty one.
 */
export function summarizeMultiTurnRun(
  responsePayloads: readonly unknown[],
): MultiTurnRunSummary | null {
  const results = responsePayloads
    .map(extractMultiTurnResult)
    .filter((result): result is MultiTurnResultPayload => result !== null);

  if (results.length === 0) {
    return null;
  }

  const byType = new Map<MultiTurnAssertionResult['type'], MultiTurnAssertionTypeStats>();
  let turnCount = 0;
  let turnsPassed = 0;
  let assertionCount = 0;
  let assertionsPassed = 0;

  for (const result of results) {
    turnCount += result.summary.turnCount;
    turnsPassed += result.summary.passedTurnCount;
    for (const assertion of result.assertions) {
      assertionCount += 1;
      if (assertion.passed) {
        assertionsPassed += 1;
      }
      const existing = byType.get(assertion.type) ?? {
        type: assertion.type,
        total: 0,
        passed: 0,
      };
      existing.total += 1;
      existing.passed += assertion.passed ? 1 : 0;
      byType.set(assertion.type, existing);
    }
  }

  return {
    scenarioCount: results.length,
    scenariosPassed: results.filter((result) => result.passed).length,
    turnCount,
    turnsPassed,
    reachedExpectedAnswerByFinalTurn: results.filter(
      (result) => result.summary.reachedExpectedAnswerByFinalTurn,
    ).length,
    assertionCount,
    assertionsPassed,
    assertionsByType: [...byType.values()].sort((a, b) => a.type.localeCompare(b.type)),
  };
}
