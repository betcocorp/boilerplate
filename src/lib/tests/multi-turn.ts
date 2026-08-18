import { z } from 'zod';

import { SME_AGENT_IDS } from '~/lib/agents/agent-registry';

/**
 * B0-537 — multi-turn eval item contract.
 *
 * A multi-turn scenario lives on an ordinary `test_items` row: the row's `prompt` column holds the
 * first turn (so every existing list/search/routing surface keeps working unchanged), and the full
 * ordered scenario is stored under `input_payload.multi_turn`, validated by
 * {@link multiTurnScenarioSchema}. Rows without that key are single-turn items and run exactly as
 * before — `parseMultiTurnFromInputPayload` returns `{ kind: 'single_turn' }` for them, which is
 * what keeps every existing JSON/CSV set fully backward compatible with zero migration.
 */

export const MULTI_TURN_PAYLOAD_KEY = 'multi_turn';

/** 1-based reference to a turn within the scenario's `turns` array. */
const turnRefSchema = z.number().int().min(1);

const termSchema = z.string().trim().min(1);

/**
 * Per-turn expectations. Only fields the deterministic grader/evaluator actually enforces are
 * allowed (strict), so authors can't write expectations that silently do nothing.
 *
 * REGULATED-DATA NOTE: expectations here are structural on purpose ("mentions the product",
 * "does not decline"). Never author dilution ratios, contact times, EPA reg numbers, or efficacy
 * values into `must_mention` unless the exact string already exists verbatim in a printed
 * label/SDS source — see AGENTS.md / org rules.
 */
export const multiTurnTurnExpectationsSchema = z
  .object({
    /** Same semantics as `test_items.expected_should_answer` (null/omitted = no expectation). */
    should_answer: z.boolean().nullish(),
    /** Same semantics as `test_items.expected_result_type` (only decline/none change grading). */
    expected_result_type: z.string().trim().nullish(),
    /** Every listed term must appear (case-insensitive) in this turn's response. */
    must_mention: z.array(termSchema).min(1).optional(),
    /** None of the listed terms may appear (case-insensitive) in this turn's response. */
    must_not_mention: z.array(termSchema).min(1).optional(),
    /** Author-facing note; never evaluated. */
    note: z.string().optional(),
  })
  .strict();

export type MultiTurnTurnExpectations = z.infer<typeof multiTurnTurnExpectationsSchema>;

export const multiTurnTurnSchema = z
  .object({
    prompt: z.string().trim().min(1),
    expectations: multiTurnTurnExpectationsSchema.optional(),
  })
  .strict();

export type MultiTurnTurn = z.infer<typeof multiTurnTurnSchema>;

/**
 * Scenario-level assertions (B0-538) — checks that reference EARLIER turns, which per-turn
 * expectations cannot express.
 */
export const contextCarryAssertionSchema = z
  .object({
    type: z.literal('context_carry'),
    /** Turn where the anchor was introduced by the user (documentation + validated < `turn`). */
    from_turn: turnRefSchema,
    /** Turn whose RESPONSE must still carry the anchor without the prompt restating it. */
    turn: turnRefSchema,
    /** The carried term (product, brand, competitor product, …). */
    anchor: termSchema,
    /** Accepted spellings/abbreviations of the anchor. */
    aliases: z.array(termSchema).optional(),
    description: z.string().optional(),
  })
  .strict();

export const noReaskAssertionSchema = z
  .object({
    type: z.literal('no_reask'),
    /** Turn whose response must not ask again for the listed already-given facts. */
    turn: turnRefSchema,
    /** Terms the user already provided in an earlier turn (product names, brands, surfaces…). */
    already_provided: z.array(termSchema).min(1),
    description: z.string().optional(),
  })
  .strict();

export const consistentProductAnchorAssertionSchema = z
  .object({
    type: z.literal('consistent_product_anchor'),
    /** The product the conversation is anchored on. */
    product: termSchema,
    aliases: z.array(termSchema).optional(),
    /** First turn (1-based) the anchor applies from; defaults to 1. */
    from_turn: turnRefSchema.optional(),
    /** Product lines the assistant must NOT switch to in any anchored turn. */
    disallowed_products: z.array(termSchema).optional(),
    /**
     * When true, every non-decline response from `from_turn` onward must mention the anchor
     * (or an alias). Off by default — an answer can legitimately say "it"/"this product".
     */
    require_mention: z.boolean().optional(),
    description: z.string().optional(),
  })
  .strict();

export const mentionsAssertionSchema = z
  .object({
    type: z.literal('mentions'),
    turn: turnRefSchema,
    /** At least one of these terms must appear in the turn's response. */
    any_of: z.array(termSchema).min(1),
    description: z.string().optional(),
  })
  .strict();

export const notMentionsAssertionSchema = z
  .object({
    type: z.literal('not_mentions'),
    turn: turnRefSchema,
    /** None of these terms may appear in the turn's response. */
    none_of: z.array(termSchema).min(1),
    description: z.string().optional(),
  })
  .strict();

export const scenarioAssertionSchema = z.discriminatedUnion('type', [
  contextCarryAssertionSchema,
  noReaskAssertionSchema,
  consistentProductAnchorAssertionSchema,
  mentionsAssertionSchema,
  notMentionsAssertionSchema,
]);

export type ScenarioAssertion = z.infer<typeof scenarioAssertionSchema>;

/** Every turn index an assertion references, for bounds validation. */
function referencedTurns(assertion: ScenarioAssertion): number[] {
  switch (assertion.type) {
    case 'context_carry':
      return [assertion.from_turn, assertion.turn];
    case 'no_reask':
    case 'mentions':
    case 'not_mentions':
      return [assertion.turn];
    case 'consistent_product_anchor':
      return assertion.from_turn !== undefined ? [assertion.from_turn] : [];
  }
}

export const multiTurnScenarioSchema = z
  .object({
    /** Contract version — bump when the shape changes incompatibly. */
    version: z.literal(1),
    scenario_id: termSchema.optional(),
    title: z.string().optional(),
    /** Ordered user turns; a scenario is by definition at least two turns. */
    turns: z.array(multiTurnTurnSchema).min(2),
    assertions: z.array(scenarioAssertionSchema).optional(),
  })
  .strict()
  .superRefine((scenario, ctx) => {
    const turnCount = scenario.turns.length;
    for (const [index, assertion] of (scenario.assertions ?? []).entries()) {
      for (const ref of referencedTurns(assertion)) {
        if (ref > turnCount) {
          ctx.addIssue({
            code: 'custom',
            path: ['assertions', index],
            message: `Assertion references turn ${ref} but the scenario only has ${turnCount} turns.`,
          });
        }
      }
      if (assertion.type === 'context_carry' && assertion.from_turn >= assertion.turn) {
        ctx.addIssue({
          code: 'custom',
          path: ['assertions', index],
          message: `context_carry requires from_turn (${assertion.from_turn}) < turn (${assertion.turn}).`,
        });
      }
    }
  });

export type MultiTurnScenario = z.infer<typeof multiTurnScenarioSchema>;

/**
 * A curated, versionable set of scenarios for one SME agent (B0-539) — the multi-turn analogue of
 * the single-turn question-set JSON files in `src/lib/training/`.
 */
export const multiTurnScenarioSetSchema = z
  .object({
    set_id: termSchema,
    name: termSchema,
    intended_agent: z.enum(SME_AGENT_IDS),
    description: z.string().optional(),
    scenarios: z.array(multiTurnScenarioSchema).min(1),
  })
  .strict();

export type MultiTurnScenarioSet = z.infer<typeof multiTurnScenarioSetSchema>;

export type MultiTurnParseResult =
  | { kind: 'single_turn' }
  | { kind: 'multi_turn'; scenario: MultiTurnScenario }
  | { kind: 'invalid'; message: string };

/**
 * Reads `input_payload.multi_turn` off a test item. Absent key → `single_turn` (the entire
 * pre-B0-537 corpus). Present-but-invalid → `invalid`, so the runner can surface a structured
 * failure instead of silently running the row as single-turn and hiding an authoring mistake.
 */
export function parseMultiTurnFromInputPayload(inputPayload: unknown): MultiTurnParseResult {
  if (!inputPayload || typeof inputPayload !== 'object' || Array.isArray(inputPayload)) {
    return { kind: 'single_turn' };
  }

  const candidate = (inputPayload as Record<string, unknown>)[MULTI_TURN_PAYLOAD_KEY];
  if (candidate === undefined || candidate === null) {
    return { kind: 'single_turn' };
  }

  const parsed = multiTurnScenarioSchema.safeParse(candidate);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 3)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return {
      kind: 'invalid',
      message: `input_payload.${MULTI_TURN_PAYLOAD_KEY} is present but not a valid multi-turn scenario — ${issues}`,
    };
  }

  return { kind: 'multi_turn', scenario: parsed.data };
}
