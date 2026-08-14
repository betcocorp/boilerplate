import { afterEach, describe, expect, it } from 'vitest';

import {
  checkCategoryConsistency,
  evaluateRecommendationGate,
} from '~/lib/recommendations/recommendation-gate';

describe('checkCategoryConsistency', () => {
  it('rejects a chemistry-class mismatch and passes an exact match', () => {
    expect(checkCategoryConsistency('quat', 'peroxide').consistent).toBe(false);
    expect(checkCategoryConsistency('quat', 'quat').consistent).toBe(true);
  });

  it('does not block when either class is unknown', () => {
    expect(checkCategoryConsistency('quat', null).consistent).toBe(true);
    expect(checkCategoryConsistency(null, 'quat').consistent).toBe(true);
  });
});

describe('evaluateRecommendationGate (REC-4)', () => {
  it('rejects the wrong-chemistry-class recommendation (quat competitor → peroxide Betco)', () => {
    const result = evaluateRecommendationGate({
      baseConfidence: 0.9,
      topSimilarity: 0.62,
      competitorChemistryClass: 'quat',
      recommendedChemistryClass: 'peroxide',
    });
    expect(result.approved).toBe(false);
    expect(result.requires_human_review).toBe(true);
    expect(result.confidence).toBeLessThanOrEqual(0.2);
    expect(result.issues.some((i) => /mismatch/i.test(i))).toBe(true);
  });

  it('caps confidence at 0.75 when top similarity is below 60% (the 0.90-on-58% bug)', () => {
    const result = evaluateRecommendationGate({
      baseConfidence: 0.9,
      topSimilarity: 0.58,
      competitorChemistryClass: 'quat',
      recommendedChemistryClass: 'quat',
    });
    expect(result.confidence).toBe(0.75);
    expect(result.approved).toBe(true);
  });

  it('keeps a strong, category-consistent match at high confidence', () => {
    const result = evaluateRecommendationGate({
      baseConfidence: 0.9,
      topSimilarity: 0.88,
      competitorChemistryClass: 'quat',
      recommendedChemistryClass: 'quat',
    });
    expect(result.approved).toBe(true);
    expect(result.confidence).toBe(0.9);
    expect(result.issues).toEqual([]);
  });

  it('lowers the ceiling when the competitor brand is unknown', () => {
    const result = evaluateRecommendationGate({
      baseConfidence: 0.95,
      topSimilarity: 0.9,
      brandKnown: false,
    });
    expect(result.confidence).toBe(0.8);
  });

  it('applies no category block when chemistry classes are not yet known (data-gated)', () => {
    const result = evaluateRecommendationGate({
      baseConfidence: 0.7,
      topSimilarity: 0.82,
    });
    expect(result.approved).toBe(true);
    expect(result.confidence).toBe(0.7);
    expect(result.issues).toEqual([]);
  });

  describe('BEX_DISABLE_CONFIDENCE_GATING kill-switch (B0-452)', () => {
    const prev = process.env.BEX_DISABLE_CONFIDENCE_GATING;
    afterEach(() => {
      if (prev === undefined) delete process.env.BEX_DISABLE_CONFIDENCE_GATING;
      else process.env.BEX_DISABLE_CONFIDENCE_GATING = prev;
    });

    it('skips the low-similarity and missing-brand confidence caps', () => {
      process.env.BEX_DISABLE_CONFIDENCE_GATING = 'true';
      const lowSimilarity = evaluateRecommendationGate({
        baseConfidence: 0.9,
        topSimilarity: 0.58,
        competitorChemistryClass: 'quat',
        recommendedChemistryClass: 'quat',
      });
      expect(lowSimilarity.confidence).toBe(0.9);

      const missingBrand = evaluateRecommendationGate({
        baseConfidence: 0.95,
        topSimilarity: 0.9,
        brandKnown: false,
      });
      expect(missingBrand.confidence).toBe(0.95);
    });

    /**
     * B0-452 follow-up: while a user was testing with the flag on, this check was the one thing
     * still silently blocking an answer (in `evaluateRegulatedClaimGrounding`, not this function —
     * but the same "always on" design applied here too), with no way to see what would have
     * happened. Widened deliberately so a real mismatch is still detected and recorded
     * (`bypassedChecks`, `issues`) but no longer rejects, matching the regulated-claim guardrail's
     * behavior in `run-product-support-workflow.ts`.
     */
    it('detects but no longer rejects a chemistry-class mismatch, and records it as bypassed', () => {
      process.env.BEX_DISABLE_CONFIDENCE_GATING = 'true';
      const result = evaluateRecommendationGate({
        baseConfidence: 0.9,
        topSimilarity: 0.62,
        competitorChemistryClass: 'quat',
        recommendedChemistryClass: 'peroxide',
      });
      expect(result.approved).toBe(true);
      expect(result.requires_human_review).toBe(false);
      expect(result.confidence).toBe(0.9);
      expect(result.bypassedChecks).toContain('category_mismatch');
      expect(result.issues.some((issue) => issue.includes('Chemistry-class mismatch'))).toBe(true);
    });

    it('reports no bypassed checks when nothing was wrong', () => {
      process.env.BEX_DISABLE_CONFIDENCE_GATING = 'true';
      const result = evaluateRecommendationGate({
        baseConfidence: 0.9,
        topSimilarity: 0.9,
        competitorChemistryClass: 'quat',
        recommendedChemistryClass: 'quat',
      });
      expect(result.bypassedChecks).toEqual([]);
    });
  });
});
