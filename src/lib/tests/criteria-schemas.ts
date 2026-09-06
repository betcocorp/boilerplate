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

/**
 * One grader verdict per criterion, keyed by its index in the item's `expected_criteria` array.
 *
 * `source` is optional and NOT part of the model's structured-output contract (the model never
 * sets it — see `GRADER_JSON_SCHEMA`, which has no such property). It is stamped on by
 * `gradeWithCriteria` (criteria-grader.ts) after the fact, to record whether a verdict came from
 * the deterministic exact-match check or the semantic/LLM grader, so `aggregateCriteriaVerdicts`
 * below can resolve an index collision by provenance rather than by array order (B0-832).
 */
export const criterionVerdictSchema = z.object({
  criterionIndex: z.number().int().min(0),
  met: z.boolean(),
  evidence: z.string(),
  source: z.enum(['exact', 'semantic']).optional(),
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
            description:
              'The number shown before the criterion in the list (e.g. for "3. must mention X", criterionIndex is 3). Copy it exactly as given — do not renumber the criteria you were shown starting from 0.',
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

/**
 * One grader verdict enriched with the criterion it judged — the shape actually persisted onto
 * `test_result_items.response_payload.criteriaGrading.verdicts` (B0-616).
 */
export const criterionOutcomeSchema = criterionVerdictSchema.extend({
  concept: z.string(),
  tier: criteriaTierSchema,
  match: criteriaMatchModeSchema,
});
export type CriterionOutcome = z.infer<typeof criterionOutcomeSchema>;

/**
 * Deterministic outcome of aggregating exact + semantic verdicts for one item.
 *
 * B0-711 — expressed as a schema rather than a bare type because it is also read back *out* of
 * a persisted `response_payload`, where it is untrusted JSON: the report path validates it with
 * `criteriaGradingOutcomeSchema` instead of trusting the shape (see `extractCriteriaGrading` in
 * `~/lib/tests/response-payload`). The inferred type is the one this module already exported, so
 * the writer and the reader can never drift apart.
 */
export const criteriaGradingOutcomeSchema = z.object({
  passed: z.boolean(),
  /** Weighted tier coverage in [0, 1]; null when there are no criteria to score. */
  score: z.number().nullable(),
  verdicts: z.array(criterionOutcomeSchema),
  /** Human-readable explanation when `passed` is false — names the missed tier-1 concept(s). */
  failureReason: z.string().nullable(),
});
export type CriteriaGradingOutcome = z.infer<typeof criteriaGradingOutcomeSchema>;

/** Tier → aggregation weight. Kept as a single source of truth for score math. */
export const TIER_WEIGHT: Record<CriteriaTier, number> = { 1: 3, 2: 2, 3: 1 };

/**
 * Deterministic aggregation: pass = every tier-1 criterion met; score = weighted tier
 * coverage. Pure function so scoring rules can be re-tuned and historical verdicts
 * re-aggregated without re-running a single model call (per the business case's
 * "aggregation is code, not vibes" argument).
 *
 * B0-832 — merging is order-independent-safe: a verdict stamped `source: 'exact'` can never be
 * overwritten by another verdict claiming the same `criterionIndex` (e.g. a semantic/LLM verdict
 * that collided with an exact criterion's index due to an upstream index-numbering ambiguity).
 * `gradeWithCriteria` already filters such collisions out before they get here (and stamps
 * `source` on every verdict it produces), so this is a second, structural guardrail — regulated
 * exact-match verdicts must never be silently replaced by a model's judgment, regardless of array
 * order. Verdicts without a `source` tag (e.g. re-aggregating verdicts persisted before B0-832)
 * fall back to plain last-write-wins, matching the pre-existing behavior.
 */
export function aggregateCriteriaVerdicts(
  criteria: ExpectedCriterion[],
  verdicts: CriterionVerdict[],
): CriteriaGradingOutcome {
  if (criteria.length === 0) {
    return { passed: true, score: null, verdicts: [], failureReason: null };
  }

  const verdictByIndex = new Map<number, CriterionVerdict>();
  for (const v of verdicts) {
    const existing = verdictByIndex.get(v.criterionIndex);
    if (existing?.source === 'exact' && v.source !== 'exact') {
      // An exact verdict already claimed this index — a non-exact verdict can never displace it.
      continue;
    }
    verdictByIndex.set(v.criterionIndex, v);
  }
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
