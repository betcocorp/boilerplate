import { z } from 'zod';

import {
  BRAND_FAMILIES,
  INTENT_VALUES,
  llmTokenUsageSchema,
  USE_SETTINGS,
} from '~/lib/orchestrator/intent-classifier';
import { PRODUCT_TOOL_NAMES } from '~/lib/tools/tool-schemas';

import type { ProductEntityResolutionSource } from '~/lib/rag/entity-context';
import type {
  CompetitorSelfReferenceReason,
  CompetitorSelfReferenceVerdict,
} from '~/lib/recommendations/competitor-self-reference';
// Type-only: `run-product-support-workflow.ts` imports THIS module, so a value import here would
// close a runtime cycle. `import type` is erased at build time, which is what makes the
// `AssertDeclineClassesMatchEarlyDeclineReasons` check below free.
import type { EARLY_DECLINE_REASONS } from '~/lib/workflows/product-support/run-product-support-workflow';

/**
 * B0-786 — the contract for the ONE pre-orchestration signal-detection call.
 *
 * Before this, "what is the user asking?" was answered in nine places, eight of them keyword or
 * regex based, plus a SECOND LLM call (`extractCompetitorProduct`) that re-extracted the competitor
 * brand/product the intent classifier had already produced. This schema is the union of all of
 * them, so one structured-output call answers the whole question and the keyword sites become
 * degraded-mode fallbacks rather than the deciding path.
 *
 * Three groups of fields, and the difference matters:
 *   1. carried over verbatim from `intentClassificationSchema` (same names, same semantics — the
 *      routing/entity fields every existing consumer already reads);
 *   2. NEW model-produced signals, each replacing one named keyword site;
 *   3. enrichment, produced DETERMINISTICALLY after the call by `analyzeTurnSignals` — never by
 *      the model. A product-line key or a self-reference verdict is a database fact; asking a
 *      language model to assert one is exactly the failure this ticket exists to reduce.
 */

/**
 * Bumped whenever this schema or the analyzer's prompt changes in a way that makes an older cached
 * result wrong. Folded into the cache key so a contract change can never serve a stale shape.
 */
export const SIGNALS_CONTRACT_VERSION = 'v1';

/**
 * B0-786 — the shape of the answer the user is asking for, replacing `PROCEDURAL_DEPTH_PATTERNS`
 * (`~/lib/tools/product-tools.ts`) as the input to `classifyRetrievalIntent`'s width tuning.
 * The four values map onto the tunings that already exist there; adding a fifth means deciding what
 * retrieval width it earns, so keep this closed.
 */
export const ANSWER_SHAPES = [
  /** One fact: a dilution ratio, a contact time, a pH. Default retrieval breadth. */
  'single_value',
  /** A list: causes, fixtures, mistakes, options. Needs width. */
  'enumeration',
  /** Ordered steps or an interval/schedule. Needs width. */
  'procedure',
  /** Two or more named things weighed against each other. Needs several distinct product lines. */
  'comparison',
] as const;
export type AnswerShape = (typeof ANSWER_SHAPES)[number];

/**
 * The four early-decline classes, replacing the four detection regexes in `classifyEarlyDecline`.
 * Deliberately a local copy (see the type-only import above) with a compile-time equivalence check,
 * so a change to `EARLY_DECLINE_REASONS` fails `tsc` here instead of silently producing a signal
 * value the gate cannot map to canned copy.
 */
export const DECLINE_CLASSES = [
  'chemical_mixing_or_safety',
  'legal_or_compliance',
  'storage_or_expiration',
  'broad_recommendation_without_context',
] as const;
export type DeclineClass = (typeof DECLINE_CLASSES)[number];

type MutuallyAssignable<A, B> = A extends B ? (B extends A ? true : never) : never;
/** Fails `tsc` if `DECLINE_CLASSES` and `EARLY_DECLINE_REASONS` ever drift apart. */
export type AssertDeclineClassesMatchEarlyDeclineReasons = MutuallyAssignable<
  DeclineClass,
  (typeof EARLY_DECLINE_REASONS)[number]
>;

/** Runtime mirror of `ProductEntityResolutionSource`, checked against the type below. */
export const PRODUCT_ENTITY_RESOLUTION_SOURCES = [
  'alias_exact',
  'alias_fuzzy',
  'alias_fuzzy_trgm',
  'prod_line_id',
  'title_exact',
  'title_fuzzy',
  'alias_exact_freeform',
  'alias_fuzzy_freeform',
] as const;
export type AssertResolutionSourcesMatch = MutuallyAssignable<
  (typeof PRODUCT_ENTITY_RESOLUTION_SOURCES)[number] | null,
  ProductEntityResolutionSource
>;

/** Runtime mirror of `CompetitorSelfReferenceReason`, checked against the type below. */
export const COMPETITOR_SELF_REFERENCE_REASONS = [
  'betco_brand',
  'betco_product',
  'betco_catalog',
  'chemistry_term',
  // B0-875 — "<chemistry> <product class>" offered in place of a product (see competitor-self-reference.ts).
  'generic_chemistry_description',
  'conversion_list_ask',
] as const;
export type AssertSelfReferenceReasonsMatch = MutuallyAssignable<
  (typeof COMPETITOR_SELF_REFERENCE_REASONS)[number],
  CompetitorSelfReferenceReason
>;

export const competitorSelfReferenceVerdictSchema = z.union([
  z.object({ suppressed: z.literal(false) }),
  z.object({
    suppressed: z.literal(true),
    reason: z.enum(COMPETITOR_SELF_REFERENCE_REASONS),
    productLineKey: z.string().nullable(),
    matched: z.string(),
  }),
]);
export type AssertSelfReferenceVerdictMatches = MutuallyAssignable<
  z.infer<typeof competitorSelfReferenceVerdictSchema>,
  CompetitorSelfReferenceVerdict
>;

/**
 * Exactly what the model is constrained to emit (see `SIGNALS_JSON_SCHEMA` in
 * `analyze-turn-signals.ts`). Flat on purpose: the nested `entities` object in
 * `intentClassificationSchema` predates half these fields and there is no longer a meaningful
 * split between "entity" and "signal" — `analyzeTurnSignals` re-nests them for the existing
 * `IntentClassification` consumers.
 */
export const llmTurnSignalsSchema = z.object({
  // --- carried over from `intentClassificationSchema`, unchanged semantics -------------------
  intent: z.enum(INTENT_VALUES),
  confidence: z.number().min(0).max(1),
  betcoProduct: z.string().nullable(),
  competitorBrand: z.string().nullable(),
  competitorProduct: z.string().nullable(),
  surfaceType: z.string().nullable(),
  taskDescription: z.string().nullable(),
  brandFamily: z.enum(BRAND_FAMILIES).nullable(),
  setting: z.enum(USE_SETTINGS).nullable(),
  productCategory: z.string().nullable(),
  carriedProduct: z.string().nullable(),
  suggestedTool: z.enum(PRODUCT_TOOL_NAMES).nullable(),

  // --- new signals, one per replaced keyword site -------------------------------------------
  /**
   * B0-357 — a SECOND distinct competitor product named in the same message but NOT chosen as
   * `competitorProduct`. Same semantics as `extractedCompetitorSchema.otherCompetitorProduct`
   * (`~/lib/recommendations/extract-competitor-product.ts`), which this replaces: that module made
   * a whole second LLM call to re-derive `brand`/`product` the classifier had already extracted.
   */
  otherCompetitorProduct: z.string().nullable(),
  /** Replaces `shouldForceCrossReferenceLookup` on the deciding path (it stays as the fallback). */
  crossReferenceIntent: z.boolean(),
  /** Replaces `CHEMISTRY_TERMS` (`competitor-self-reference.ts`): the "competitor" is a bare chemistry. */
  competitorIsGenericChemistry: z.boolean(),
  /** Replaces `CONVERSION_LIST_PATTERNS` (`competitor-self-reference.ts`). */
  isConversionListAsk: z.boolean(),
  /** Replaces `PROCEDURAL_DEPTH_PATTERNS` (`product-tools.ts`). */
  answerShape: z.enum(ANSWER_SHAPES),
  /** Replaces the four detection regexes in `classifyEarlyDecline`; `null` = no decline class. */
  declineClass: z.enum(DECLINE_CLASSES).nullable(),
  /**
   * ADDITIVE ONLY. The question is about label-governed content (dilution, contact time, kill
   * claims, EPA registration, hazards, PPE, first aid). This is OR'd with `inferSectionTypeFromQuery`
   * and `isClaimLikeQuery` — never substituted for them — so a model miss can only WIDEN
   * label-first grounding, never narrow it. See `resolveRequiredDocumentKinds`
   * (`~/lib/retrieval/product-knowledge.ts`).
   */
  regulatedSectionIntent: z.boolean(),
});

export type LlmTurnSignals = z.infer<typeof llmTurnSignalsSchema>;

export const turnSignalsSchema = llmTurnSignalsSchema.extend({
  /** `llm` = the model call ran and parsed; `keyword_fallback` = degraded, see `fallbackReason`. */
  source: z.enum(['llm', 'keyword_fallback']),
  /** Non-null exactly when `source` is `keyword_fallback`: disabled flag, timeout, API or parse error. */
  fallbackReason: z.string().nullable(),
  /** Null on the fallback path and on a cache hit (no NEW model call was billed for this turn). */
  usage: llmTokenUsageSchema.nullable(),
  /** The resolved model id actually called; null alongside `usage`. */
  model: z.string().nullable(),

  // --- deterministic enrichment, never model-produced ---------------------------------------
  /** `betcoProduct` resolved through `resolveProductEntityByName`; null when nothing resolved. */
  resolvedProductLineKey: z.string().nullable(),
  resolutionSource: z.enum(PRODUCT_ENTITY_RESOLUTION_SOURCES).nullable(),
  /**
   * `classifyCompetitorSelfReference`'s verdict, run only for cross-reference candidates and reusing
   * the competitor identity above instead of re-extracting it. Null when the turn was never a
   * cross-reference candidate.
   */
  selfReferenceVerdict: competitorSelfReferenceVerdictSchema.nullable(),
});

export type TurnSignals = z.infer<typeof turnSignalsSchema>;
