import type { BetcoCandidate } from '~/lib/recommendations/candidate-retrieval';
import type { EnrichedCompetitorSpec } from '~/lib/websearch/enrich-competitor-spec';

/**
 * B0-88 — calibrated 0–1 confidence for a cross-reference recommendation + the threshold gate.
 *
 * Combines four signals into `overallConfidence`:
 *   - retrieval similarity of the top candidate (0.55),
 *   - spec completeness (0.25),
 *   - agreement across candidates = mean similarity (0.20),
 *   then a company/brand factor (missing company → ×0.9 penalty, never a hard block).
 * The gate compares against a configurable threshold (env `XREF_RECOMMENDATION_MIN_CONFIDENCE`,
 * default 0.80, with an optional per-call override) and declines below it. The chosen threshold is
 * returned so callers persist it as `threshold_used`.
 */

export const DEFAULT_XREF_MIN_CONFIDENCE = 0.8;
/** Multiplicative penalty applied when the competitor company/brand is unknown (does not block). */
export const MISSING_COMPANY_PENALTY_FACTOR = 0.9;
export const XREF_DECLINE_COPY =
  "I couldn't confidently identify a Betco equivalent for this product. A Betco sales representative can help identify the right match — please reach out to your rep.";

const SIMILARITY_WEIGHT = 0.55;
const COMPLETENESS_WEIGHT = 0.25;
const AGREEMENT_WEIGHT = 0.2;

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

const SPEC_FIELDS = [
  'chemistryClass',
  'epaRegistration',
  'contactTimeSeconds',
  'dilutionOzPerGal',
  'productCategory',
  'primaryUse',
  'formFactor',
] as const;

/** Fraction of the tracked spec fields (+ keyClaims) that resolved. */
export function computeSpecCompleteness(spec: EnrichedCompetitorSpec): number {
  const filled =
    SPEC_FIELDS.filter((f) => spec[f] != null).length + (spec.keyClaims.length > 0 ? 1 : 0);
  return round3(filled / (SPEC_FIELDS.length + 1));
}

export type ScoreComponents = {
  topSimilarity: number;
  specCompleteness: number;
  candidateAgreement: number;
  brandKnown: boolean;
  brandFactor: number;
};

export type RecommendationScore = {
  overallConfidence: number;
  components: ScoreComponents;
};

export function scoreRecommendation(input: {
  candidates: BetcoCandidate[];
  spec: EnrichedCompetitorSpec;
  brandKnown: boolean;
}): RecommendationScore {
  const topSimilarity = input.candidates[0]?.similarity ?? 0;
  const specCompleteness = computeSpecCompleteness(input.spec);
  const candidateAgreement =
    input.candidates.length > 0
      ? input.candidates.reduce((sum, c) => sum + c.similarity, 0) / input.candidates.length
      : 0;
  const brandFactor = input.brandKnown ? 1 : MISSING_COMPANY_PENALTY_FACTOR;

  const base =
    SIMILARITY_WEIGHT * topSimilarity +
    COMPLETENESS_WEIGHT * specCompleteness +
    AGREEMENT_WEIGHT * candidateAgreement;

  return {
    overallConfidence: round3(clamp01(base * brandFactor)),
    components: {
      topSimilarity: round3(topSimilarity),
      specCompleteness,
      candidateAgreement: round3(candidateAgreement),
      brandKnown: input.brandKnown,
      brandFactor,
    },
  };
}

/** Resolve the gate threshold: explicit override → env → default 0.80. */
export function resolveXrefThreshold(override?: number | null): number {
  if (typeof override === 'number' && Number.isFinite(override)) return override;
  const raw = process.env.XREF_RECOMMENDATION_MIN_CONFIDENCE?.trim();
  const env = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(env) ? env : DEFAULT_XREF_MIN_CONFIDENCE;
}

/**
 * B0-452 — temporary master kill-switch for every numeric confidence threshold/cap in the
 * recommendation and product-support answer pipeline (this gate, the validator confidence
 * floor, and the REC-4 similarity/brand confidence caps). The current threshold values are
 * unproven placeholders (see `src/docs/cross-reference-recommendations.md`) and are suppressing
 * correct answers; flip `BEX_DISABLE_CONFIDENCE_GATING` back off once real thresholds are
 * calibrated. Does NOT affect correctness/safety checks that are not confidence thresholds:
 * regulated-claim grounding, category-mismatch rejection, evidence/candidate grounding, and
 * validator-not-approved / requires-human-review / unsupported-safety-claim all keep running.
 */
export function isConfidenceGatingDisabled(): boolean {
  return process.env.BEX_DISABLE_CONFIDENCE_GATING === 'true';
}

export type RecommendationGate = {
  answered: boolean;
  thresholdUsed: number;
  declineReason: string | null;
};

export function gateRecommendation(input: {
  overallConfidence: number;
  thresholdOverride?: number | null;
}): RecommendationGate {
  const thresholdUsed = resolveXrefThreshold(input.thresholdOverride);
  if (isConfidenceGatingDisabled()) {
    return { answered: true, thresholdUsed, declineReason: null };
  }
  const answered = input.overallConfidence >= thresholdUsed;
  return { answered, thresholdUsed, declineReason: answered ? null : XREF_DECLINE_COPY };
}
