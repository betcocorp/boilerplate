import { z } from 'zod';

/**
 * B0-615/616/617 — structured per-criterion grading ("Option B" in
 * claude/eval-grading-business-case.md, Tom Bird, 2026-08-11).
 *
 * Tier semantics are pinned here, not left to string convention:
 *   1 = must have  — any tier-1 miss fails the item.
 *   2 = should have — affects score, does not fail the item alone.
 *   3 = bonus       — score only.
 *
 * `match: 'exact'` is opt-in for regulated values (dilution ratios, oz/gal, mL/L, ppm,
 * contact times, CAS/EPA registration numbers) per the org rule: transcribe exactly,
 * never round/convert/infer. Exact criteria are checked as a literal substring match in
 * code (~/lib/tests/criteria-grader.ts), never left to an LLM's judgment. `semantic`
 * (the default) is judged by the grader model.
 */
export const criteriaTierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type CriteriaTier = z.infer<typeof criteriaTierSchema>;

export const criteriaMatchModeSchema = z.enum(['semantic', 'exact']);
export type CriteriaMatchMode = z.infer<typeof criteriaMatchModeSchema>;

export const expectedCriterionSchema = z.object({
  concept: z.string().min(1),
  tier: criteriaTierSchema,
  match: criteriaMatchModeSchema.default('semantic'),
});
export type ExpectedCriterion = z.infer<typeof expectedCriterionSchema>;

/** The full shape of `test_items.expected_criteria`. Empty array = legacy behavior-only grading. */
export const expectedCriteriaSchema = z.array(expectedCriterionSchema);
export type ExpectedCriteria = z.infer<typeof expectedCriteriaSchema>;

/** One grader verdict per criterion, keyed by its index in the item's `expected_criteria` array. */
export const criterionVerdictSchema = z.object({
  criterionIndex: z.number().int().min(0),
  met: z.boolean(),
  evidence: z.string(),
});
export type CriterionVerdict = z.infer<typeof criterionVerdictSchema>;

/** Structured-output contract for the semantic-criteria grader call (json_schema strict). */
export const graderResponseSchema = z.object({
  verdicts: z.array(criterionVerdictSchema),
});
export type GraderResponse = z.infer<typeof graderResponseSchema>;

/** JSON Schema mirror of `graderResponseSchema` for `client.responses.create({ text: { format }})`. */
export const GRADER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          criterionIndex: {
            type: 'integer',
            description: 'Index of the criterion in the input list, 0-based.',
          },
          met: {
            type: 'boolean',
            description: 'Does the response state this concept (semantic equivalence allowed)?',
          },
          evidence: {
            type: 'string',
            description:
              'A short verbatim quote from the response supporting the verdict, or "" when not met.',
          },
        },
        required: ['criterionIndex', 'met', 'evidence'],
      },
    },
  },
  required: ['verdicts'],
} as const;

/** Deterministic outcome of aggregating exact + semantic verdicts for one item. */
export type CriteriaGradingOutcome = {
  passed: boolean;
  /** Weighted tier coverage in [0, 1]; null when there are no criteria to score. */
  score: number | null;
  verdicts: Array<CriterionVerdict & { concept: string; tier: CriteriaTier; match: CriteriaMatchMode }>;
  /** Human-readable explanation when `passed` is false — names the missed tier-1 concept(s). */
  failureReason: string | null;
};

/** Tier → aggregation weight. Kept as a single source of truth for score math. */
export const TIER_WEIGHT: Record<CriteriaTier, number> = { 1: 3, 2: 2, 3: 1 };

/**
 * Deterministic aggregation: pass = every tier-1 criterion met; score = weighted tier
 * coverage. Pure function so scoring rules can be re-tuned and historical verdicts
 * re-aggregated without re-running a single model call (per the business case's
 * "aggregation is code, not vibes" argument).
 */
export function aggregateCriteriaVerdicts(
  criteria: ExpectedCriterion[],
  verdicts: CriterionVerdict[],
): CriteriaGradingOutcome {
  if (criteria.length === 0) {
    return { passed: true, score: null, verdicts: [], failureReason: null };
  }

  const verdictByIndex = new Map(verdicts.map((v) => [v.criterionIndex, v]));
  const enriched = criteria.map((criterion, index) => {
    const verdict = verdictByIndex.get(index) ?? {
      criterionIndex: index,
      met: false,
      evidence: '',
    };
    return { ...verdict, concept: criterion.concept, tier: criterion.tier, match: criterion.match };
  });

  const missedTier1 = enriched.filter((v) => v.tier === 1 && !v.met);
  const totalWeight = enriched.reduce((sum, v) => sum + TIER_WEIGHT[v.tier], 0);
  const metWeight = enriched.reduce((sum, v) => sum + (v.met ? TIER_WEIGHT[v.tier] : 0), 0);
  const score = totalWeight > 0 ? metWeight / totalWeight : null;

  return {
    passed: missedTier1.length === 0,
    score,
    verdicts: enriched,
    failureReason:
      missedTier1.length > 0
        ? `Missed ${missedTier1.length} tier-1 (must-have) criterion${missedTier1.length > 1 ? 'ia' : ''}: ${missedTier1
            .map((v) => `"${v.concept}"`)
            .join(', ')}.`
        : null,
  };
}
