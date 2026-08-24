import type { CompetitorSpec } from '~/lib/websearch/extract-competitor-spec';
import { isConfidenceGatingDisabled } from '~/lib/recommendations/confidence-scoring';

/**
 * REC-4 — Category-consistency gate + confidence calibrated to retrieval strength.
 *
 * Two root-cause fixes from the BNC-15 failure:
 *  1. A recommendation whose chemistry class ≠ the grounded competitor's class is rejected
 *     (the system had recommended a peroxide cleaner for a quat disinfectant).
 *  2. Confidence is capped by retrieval strength — a top-hit similarity below 60% can no
 *     longer produce > 0.75 confidence (it had reported 0.90 on ~58% similarity).
 *
 * Returns a `ValidatorResult`-shaped object so it can compose with the existing validator
 * pass at the workflow gate. The category check is a no-op when either chemistry class is
 * unknown (it never fabricates agreement — it simply cannot block without both sides), which
 * is the graceful state until REC-1 grounding + REC-2/REC-3 structured fields are wired.
 */

export type ChemistryClass = NonNullable<CompetitorSpec['chemistryClass']>;

export const LOW_SIMILARITY_THRESHOLD = 0.6;
export const LOW_SIMILARITY_CONFIDENCE_CAP = 0.75;
export const MISSING_BRAND_CONFIDENCE_CAP = 0.8;
export const CATEGORY_MISMATCH_CONFIDENCE_CAP = 0.2;

export type RecommendationGateInput = {
  /** Confidence proposed before calibration (validator output or heuristic). */
  baseConfidence: number;
  /** Best retrieval similarity (0–1) supporting the recommendation, when known. */
  topSimilarity?: number | null;
  /** Grounded competitor chemistry class (REC-1), when resolved. */
  competitorChemistryClass?: ChemistryClass | null;
  /** Recommended Betco product chemistry class (REC-2/REC-3), when known. */
  recommendedChemistryClass?: ChemistryClass | null;
  /** Whether the competitor brand was provided (missing brand lowers the ceiling). */
  brandKnown?: boolean;
};

export type RecommendationGateResult = {
  approved: boolean;
  confidence: number;
  issues: string[];
  requires_human_review: boolean;
  /**
   * B0-452 follow-up — which checks below were detected but not enforced because
   * `BEX_DISABLE_CONFIDENCE_GATING` is set. Empty when nothing was bypassed (including when
   * nothing was wrong in the first place) so callers can tell "ran clean" apart from "ran but
   * was overridden for testing".
   */
  bypassedChecks: string[];
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function checkCategoryConsistency(
  competitorChemistryClass: ChemistryClass | null,
  recommendedChemistryClass: ChemistryClass | null,
): { consistent: boolean; issue?: string } {
  if (!competitorChemistryClass || !recommendedChemistryClass) {
    // Cannot judge without both sides; do not block and do not claim agreement.
    return { consistent: true };
  }
  if (competitorChemistryClass === recommendedChemistryClass) {
    return { consistent: true };
  }
  return {
    consistent: false,
    issue: `Chemistry-class mismatch: competitor is "${competitorChemistryClass}" but the recommended Betco product is "${recommendedChemistryClass}".`,
  };
}

/**
 * B0-452: the two confidence *caps* below (low-similarity, missing-brand) are skipped while
 * `BEX_DISABLE_CONFIDENCE_GATING` is set — both are unproven placeholder thresholds.
 *
 * B0-452 follow-up: the category-consistency check normally rejects a recommendation whose
 * chemistry class actually disagrees with the competitor's regardless of the flag, since that is
 * a correctness check, not a confidence-calibration guess. During the temporary testing window
 * this flag also opens up, a real mismatch is still detected and recorded in `bypassedChecks` +
 * `issues`, but no longer forces `approved: false` / caps confidence — so it can be seen ("this
 * would have been rejected for chemistry mismatch") without actually withholding the answer.
 */
export async function evaluateRecommendationGate(
  input: RecommendationGateInput,
): Promise<RecommendationGateResult> {
  const issues: string[] = [];
  const bypassedChecks: string[] = [];
  let confidence = clamp01(input.baseConfidence);
  let approved = true;
  let requiresHumanReview = false;

  const gatingDisabled = await isConfidenceGatingDisabled();

  const category = checkCategoryConsistency(
    input.competitorChemistryClass ?? null,
    input.recommendedChemistryClass ?? null,
  );
  if (!category.consistent && category.issue) {
    if (gatingDisabled) {
      bypassedChecks.push('category_mismatch');
      issues.push(
        `${category.issue} (BEX_DISABLE_CONFIDENCE_GATING is set: not rejected, confidence not capped)`,
      );
    } else {
      approved = false;
      requiresHumanReview = true;
      confidence = Math.min(confidence, CATEGORY_MISMATCH_CONFIDENCE_CAP);
      issues.push(category.issue);
    }
  }

  if (
    !gatingDisabled &&
    typeof input.topSimilarity === 'number' &&
    input.topSimilarity < LOW_SIMILARITY_THRESHOLD &&
    confidence > LOW_SIMILARITY_CONFIDENCE_CAP
  ) {
    confidence = LOW_SIMILARITY_CONFIDENCE_CAP;
    issues.push(
      `Top retrieval similarity ${Math.round(input.topSimilarity * 100)}% is below ${Math.round(
        LOW_SIMILARITY_THRESHOLD * 100,
      )}%; confidence capped at ${LOW_SIMILARITY_CONFIDENCE_CAP}.`,
    );
  }

  if (!gatingDisabled && input.brandKnown === false && confidence > MISSING_BRAND_CONFIDENCE_CAP) {
    confidence = MISSING_BRAND_CONFIDENCE_CAP;
    issues.push(
      'Competitor brand was not provided; matched conservatively with a lower confidence ceiling.',
    );
  }

  return {
    approved,
    confidence: round2(confidence),
    issues,
    requires_human_review: requiresHumanReview,
    bypassedChecks,
  };
}
