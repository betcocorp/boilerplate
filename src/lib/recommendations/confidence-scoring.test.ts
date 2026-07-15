import { afterEach, describe, expect, it } from 'vitest';

import type { BetcoCandidate } from '~/lib/recommendations/candidate-retrieval';
import {
  DEFAULT_XREF_MIN_CONFIDENCE,
  MISSING_COMPANY_PENALTY_FACTOR,
  XREF_DECLINE_COPY,
  computeSpecCompleteness,
  gateRecommendation,
  resolveXrefThreshold,
  scoreRecommendation,
} from '~/lib/recommendations/confidence-scoring';
import type { EnrichedCompetitorSpec } from '~/lib/websearch/enrich-competitor-spec';

const noProv = {
  chemistryClass: null,
  epaRegistration: null,
  contactTimeSeconds: null,
  dilutionOzPerGal: null,
  productCategory: null,
  primaryUse: null,
  formFactor: null,
  keyClaims: null,
};

const fullSpec: EnrichedCompetitorSpec = {
  chemistryClass: 'quat',
  epaRegistration: '6836-361',
  contactTimeSeconds: 60,
  dilutionOzPerGal: 2,
  productCategory: 'disinfectant',
  primaryUse: 'surface disinfection',
  formFactor: 'RTU',
  keyClaims: ['kills 99.9%'],
  provenance: noProv,
};

const cand = (similarity: number): BetcoCandidate => ({
  betcoProductKey: 'PK',
  betcoProductLineKey: null,
  sku: null,
  title: 'Betco X',
  similarity,
  url: null,
  documentId: 'd',
  evidence: 'e',
});

describe('gateRecommendation threshold behavior (B0-88)', () => {
  it('declines just below, answers at and just above the 0.80 threshold', () => {
    expect(gateRecommendation({ overallConfidence: 0.79, thresholdOverride: 0.8 })).toEqual({
      answered: false,
      thresholdUsed: 0.8,
      declineReason: XREF_DECLINE_COPY,
    });
    expect(gateRecommendation({ overallConfidence: 0.8, thresholdOverride: 0.8 })).toMatchObject({
      answered: true,
      thresholdUsed: 0.8,
      declineReason: null,
    });
    expect(gateRecommendation({ overallConfidence: 0.81, thresholdOverride: 0.8 }).answered).toBe(true);
  });
});

describe('scoreRecommendation (B0-88)', () => {
  it('applies the missing-company penalty without hard-blocking', () => {
    const withCompany = scoreRecommendation({ candidates: [cand(0.9), cand(0.85)], spec: fullSpec, brandKnown: true });
    const withoutCompany = scoreRecommendation({ candidates: [cand(0.9), cand(0.85)], spec: fullSpec, brandKnown: false });
    expect(withoutCompany.components.brandFactor).toBe(MISSING_COMPANY_PENALTY_FACTOR);
    expect(withoutCompany.overallConfidence).toBeCloseTo(
      Math.round(withCompany.overallConfidence * MISSING_COMPANY_PENALTY_FACTOR * 1000) / 1000,
      3,
    );
    // still a real number, not blocked to 0
    expect(withoutCompany.overallConfidence).toBeGreaterThan(0.5);
  });

  it('rewards top similarity + completeness + agreement', () => {
    const strong = scoreRecommendation({ candidates: [cand(0.95), cand(0.9)], spec: fullSpec, brandKnown: true });
    const weak = scoreRecommendation({
      candidates: [cand(0.4)],
      spec: { ...fullSpec, epaRegistration: null, productCategory: null, primaryUse: null, formFactor: null, keyClaims: [] },
      brandKnown: true,
    });
    expect(strong.overallConfidence).toBeGreaterThan(weak.overallConfidence);
    expect(strong.overallConfidence).toBeGreaterThanOrEqual(0.8);
  });

  it('scores 0 when there are no candidates', () => {
    expect(scoreRecommendation({ candidates: [], spec: fullSpec, brandKnown: true }).components.topSimilarity).toBe(0);
  });
});

describe('computeSpecCompleteness (B0-88)', () => {
  it('is 1.0 for a fully resolved spec and lower as fields drop out', () => {
    expect(computeSpecCompleteness(fullSpec)).toBe(1);
    const half = computeSpecCompleteness({
      ...fullSpec,
      epaRegistration: null,
      contactTimeSeconds: null,
      dilutionOzPerGal: null,
      formFactor: null,
    });
    expect(half).toBeLessThan(1);
    expect(half).toBeGreaterThan(0);
  });
});

describe('resolveXrefThreshold (B0-88)', () => {
  const prev = process.env.XREF_RECOMMENDATION_MIN_CONFIDENCE;
  afterEach(() => {
    if (prev === undefined) delete process.env.XREF_RECOMMENDATION_MIN_CONFIDENCE;
    else process.env.XREF_RECOMMENDATION_MIN_CONFIDENCE = prev;
  });

  it('prefers an explicit override, then env, then the 0.80 default', () => {
    expect(resolveXrefThreshold(0.7)).toBe(0.7);
    delete process.env.XREF_RECOMMENDATION_MIN_CONFIDENCE;
    expect(resolveXrefThreshold()).toBe(DEFAULT_XREF_MIN_CONFIDENCE);
    process.env.XREF_RECOMMENDATION_MIN_CONFIDENCE = '0.9';
    expect(resolveXrefThreshold()).toBe(0.9);
  });
});
