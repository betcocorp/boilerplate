import { z } from 'zod';

/**
 * B0-486 — contracts for the formulation-variant aliasing guard.
 *
 * Encodes the decision table in `src/docs/formulation-variant-aliasing-rules.md`: whether two or
 * more `product_line_key`s may legitimately share one `rag.product_alias` row, decided *only* from
 * the regulated fields on `rag.product_line_fact`.
 *
 * Regulated-data rule: every value below is carried as the **string exactly as stored** — never
 * rounded, converted, re-formatted or inferred. That is why `dilution_oz_per_gal` and
 * `contact_time_seconds` are `string`, not `number`: `0.500` and `0.5` are distinct stored values
 * and must stay distinguishable to a reviewer. A missing value is absent from the array, never
 * substituted with a default or a guess.
 */

/**
 * The `rag.product_line_fact` columns this guard compares, named as the real DB columns so an
 * audit-log payload points a reviewer straight at the field to check on the label.
 *
 * The doc's decision table names EPA registration and dilution as the pair that decides a merge;
 * `contact_time_seconds` is included here because the doc's own pH7Q analysis treats the `60` vs.
 * `120` second difference as part of the disqualifying evidence. Including it can only make this
 * guard *block more* than the doc's table requires — it never permits a merge the doc forbids.
 */
export const FORMULATION_DECISION_FIELDS = [
  'epa_registration',
  'dilution_display',
  'dilution_oz_per_gal',
  'contact_time_seconds',
] as const;

export const formulationDecisionFieldSchema = z.enum(FORMULATION_DECISION_FIELDS);
export type FormulationDecisionField = z.infer<typeof formulationDecisionFieldSchema>;

/** Distinct stored values for one decision field on one product line, exactly as stored. */
export const formulationFieldValuesSchema = z.object({
  field: formulationDecisionFieldSchema,
  values: z.array(z.string()),
});
export type FormulationFieldValues = z.infer<typeof formulationFieldValuesSchema>;

/**
 * Every `rag.product_line_fact` value reachable from one `product_line_key`, aggregated across all
 * of that line's `rag.entity` rows (both the `product_line` tier and the `product`/SKU tier — the
 * join is `entity.product_line_key` → `entity.id` = `product_line_fact.entity_id`, NOT
 * `product_key`).
 */
export const productLineFormulationFactsSchema = z.object({
  productLineKey: z.string(),
  /** `rag.entity.title` of the `product_line`-tier row, when one exists. */
  productLineTitle: z.string().nullable(),
  /** How many `rag.entity` rows carry this `product_line_key` (all tiers). */
  entityCount: z.number().int().min(0),
  /** How many `rag.product_line_fact` rows were found across those entities. */
  factRowCount: z.number().int().min(0),
  /** One entry per decision field, in `FORMULATION_DECISION_FIELDS` order. */
  factsByField: z.array(formulationFieldValuesSchema),
});
export type ProductLineFormulationFacts = z.infer<typeof productLineFormulationFactsSchema>;

/** One decision field on which the candidate lines hold different stored values. */
export const formulationDisagreementSchema = z.object({
  field: formulationDecisionFieldSchema,
  /** The exact stored values per line, so a reviewer can see *why* without re-querying. */
  byProductLine: z.array(
    z.object({
      productLineKey: z.string(),
      productLineTitle: z.string().nullable(),
      values: z.array(z.string()),
    }),
  ),
});
export type FormulationDisagreement = z.infer<typeof formulationDisagreementSchema>;

/**
 * A candidate line whose regulated facts are too incomplete to decide the merge — the doc's
 * "no fact data exists → default to NOT merging, flag as an open data gap" branch. Never resolved
 * by inferring the absent value.
 */
export const formulationDataGapSchema = z.object({
  productLineKey: z.string(),
  productLineTitle: z.string().nullable(),
  /** false when the line has no `rag.product_line_fact` row at all. */
  hasAnyFactRow: z.boolean(),
  /** Decision fields with no stored value anywhere on this line. */
  missingFields: z.array(formulationDecisionFieldSchema),
});
export type FormulationDataGap = z.infer<typeof formulationDataGapSchema>;

export const FORMULATION_MERGE_VERDICTS = [
  /** Both/all candidates have facts and they agree — the doc permits one shared alias row. */
  'may_merge',
  /** A decision field disagrees. The doc's "never merge" branch. */
  'must_not_merge',
  /** Facts absent for at least one candidate. The doc's "default don't merge + flag a gap" branch. */
  'insufficient_data',
] as const;

export const formulationMergeVerdictSchema = z.enum(FORMULATION_MERGE_VERDICTS);
export type FormulationMergeVerdict = z.infer<typeof formulationMergeVerdictSchema>;

/**
 * The guard's full, reviewer-facing answer. `may_merge` is *permission for a human to proceed*,
 * never an automatic approval — nothing in this module writes to `rag.product_alias`.
 */
export const formulationVariantDecisionSchema = z.object({
  verdict: formulationMergeVerdictSchema,
  /** The `alias_norm` under review, when the decision was driven by a specific alias row. */
  aliasNorm: z.string().nullable(),
  /** Candidate `product_line_key`s, de-duplicated, in the order supplied. */
  productLineKeys: z.array(z.string()),
  /** One-line human-readable explanation quoting the exact stored values. */
  reason: z.string(),
  disagreements: z.array(formulationDisagreementSchema),
  dataGaps: z.array(formulationDataGapSchema),
  /** The raw per-line facts the verdict was computed from. */
  facts: z.array(productLineFormulationFactsSchema),
});
export type FormulationVariantDecision = z.infer<typeof formulationVariantDecisionSchema>;

/** Input to the pure decision function — facts already loaded, so the rule stays testable. */
export const formulationVariantDecisionInputSchema = z.object({
  aliasNorm: z.string().nullable().default(null),
  facts: z.array(productLineFormulationFactsSchema),
});
export type FormulationVariantDecisionInput = z.infer<typeof formulationVariantDecisionInputSchema>;
