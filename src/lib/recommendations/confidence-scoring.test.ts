import { afterEach, describe, expect, it, vi } from 'vitest';

import type { BetcoCandidate } from '~/lib/recommendations/candidate-retrieval';
import {
  DEFAULT_XREF_MIN_CONFIDENCE,
  MISSING_COMPANY_PENALTY_FACTOR,
  XREF_DECLINE_COPY,
  computeSpecCompleteness,
  gateRecommendation,
  isConfidenceGatingDisabled,
  resolveXrefThreshold,
  scoreRecommendation,
} from '~/lib/recommendations/confidence-scoring';
import { getBooleanSetting, getNumberSetting } from '~/lib/settings/settings-service';
import type { EnrichedCompetitorSpec } from '~/lib/websearch/enrich-competitor-spec';

vi.mock('~/lib/settings/settings-service', () => ({
  getBooleanSetting: vi.fn().mockResolvedValue(false),
  // Mirrors the real getNumberSetting contract: a missing/unreadable row yields the fallback.
  getNumberSetting: vi.fn(async (_key: string, fallback: number) => fallback),
}));

const noProv = {
  chemistryClass: null,
  epaRegistration: null,
  contactTimeSeconds: null,
  dilutionOzPerGal: null,
  productCategory: null,
  primaryUse: null,
  formFactor: null,
  keyClaims: null,
  manufacturer: null,
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
  manufacturer: null,
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
  keySource: 'direct_match',
});

describe('gateRecommendation threshold behavior (B0-88)', () => {
  it('declines just below, answers at and just above the 0.80 threshold', async () => {
    expect(await gateRecommendation({ overallConfidence: 0.79, thresholdOverride: 0.8 })).toEqual({
      answered: false,
      thresholdUsed: 0.8,
      declineReason: XREF_DECLINE_COPY,
    });
    expect(await gateRecommendation({ overallConfidence: 0.8, thresholdOverride: 0.8 })).toMatchObject({
      answered: true,
      thresholdUsed: 0.8,
      declineReason: null,
    });
    expect((await gateRecommendation({ overallConfidence: 0.81, thresholdOverride: 0.8 })).answered).toBe(true);
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

  it('rewards top similarity + completeness + margin', () => {
    const strong = scoreRecommendation({ candidates: [cand(0.95), cand(0.7)], spec: fullSpec, brandKnown: true });
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

  // --- B0-795: candidateAgreement -> candidateMargin ---------------------------------------
  it('ranks a decisive top candidate above an undifferentiated list of the same top similarity', () => {
    // The exact failure the old `candidateAgreement` signal inverted: five near-identical
    // candidates scored HIGHER than one clear leader, because mean similarity was higher.
    const decisive = scoreRecommendation({
      candidates: [cand(0.7), cand(0.5), cand(0.48)],
      spec: fullSpec,
      brandKnown: true,
    });
    const undifferentiated = scoreRecommendation({
      candidates: [cand(0.7), cand(0.699), cand(0.698)],
      spec: fullSpec,
      brandKnown: true,
    });
    expect(decisive.components.candidateMargin).toBe(1);
    expect(undifferentiated.components.candidateMargin).toBe(0.01);
    expect(decisive.overallConfidence).toBeGreaterThan(undifferentiated.overallConfidence);
  });

  it('reports candidateMargin as null (not 0) for a single candidate and redistributes its weight', () => {
    const single = scoreRecommendation({ candidates: [cand(0.6)], spec: fullSpec, brandKnown: true });
    expect(single.components.candidateMargin).toBeNull();
    // A lone candidate must not be punished as if it had lost a run-off: with margin excluded the
    // score is the similarity/completeness mean renormalized to 1, i.e. (0.55*0.6 + 0.25*1) / 0.80.
    expect(single.overallConfidence).toBeCloseTo((0.55 * 0.6 + 0.25 * 1) / 0.8, 3);
  });

  // --- B0-795: categoryCompatibility is measured but deliberately unweighted ----------------
  it('records categoryCompatibility + the kind labels without letting them move the score', () => {
    const bowlSpec: EnrichedCompetitorSpec = {
      ...fullSpec,
      productCategory: 'bowl cleaner',
      primaryUse: 'toilet bowls and urinals',
    };
    const matching = { ...cand(0.7), title: 'Thick Bowl Cleaner' };
    const mismatched = { ...cand(0.7), title: 'Heavy Duty Degreaser' };
    const runnerUp = cand(0.6);

    const same = scoreRecommendation({ candidates: [matching, runnerUp], spec: bowlSpec, brandKnown: true });
    const different = scoreRecommendation({ candidates: [mismatched, runnerUp], spec: bowlSpec, brandKnown: true });

    expect(same.components.categoryCompatibility).toBe(1);
    expect(different.components.categoryCompatibility).toBe(0);
    expect(different.components.categoryKinds).toEqual({
      competitor: 'restroom/bowl_cleaner',
      candidate: 'industrial/degreaser',
    });
    // Same inputs otherwise -> identical confidence. If this ever fails, someone weighted the
    // diagnostic without re-running scripts/calibrate-xref-threshold.ts (see the module header).
    expect(different.overallConfidence).toBe(same.overallConfidence);
  });

  it('leaves categoryCompatibility null when either side cannot be classified', () => {
    const unclassifiable = scoreRecommendation({
      candidates: [{ ...cand(0.7), title: 'Betco X', evidence: 'no category words here' }, cand(0.6)],
      spec: { ...fullSpec, productCategory: null, primaryUse: null },
      brandKnown: true,
    });
    expect(unclassifiable.components.categoryCompatibility).toBeNull();
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

describe('BEX_DISABLE_CONFIDENCE_GATING kill-switch (B0-452)', () => {
  afterEach(() => {
    vi.mocked(getBooleanSetting).mockResolvedValue(false);
  });

  it('is off unless the `settings` row is exactly "true"', async () => {
    vi.mocked(getBooleanSetting).mockResolvedValueOnce(false);
    expect(await isConfidenceGatingDisabled()).toBe(false);
    vi.mocked(getBooleanSetting).mockResolvedValueOnce(true);
    expect(await isConfidenceGatingDisabled()).toBe(true);
  });

  it('answers below the threshold once the kill-switch is on, and still reports thresholdUsed', async () => {
    vi.mocked(getBooleanSetting).mockResolvedValue(true);
    expect(await gateRecommendation({ overallConfidence: 0.1, thresholdOverride: 0.8 })).toEqual({
      answered: true,
      thresholdUsed: 0.8,
      declineReason: null,
    });
  });
});

describe('resolveXrefThreshold (B0-88, settings-backed as of B0-795)', () => {
  afterEach(() => {
    vi.mocked(getNumberSetting).mockImplementation(async (_key: string, fallback: number) => fallback);
  });

  it('prefers an explicit override, then the settings row, then the 0.80 default', async () => {
    expect(await resolveXrefThreshold(0.7)).toBe(0.7);
    expect(await resolveXrefThreshold()).toBe(DEFAULT_XREF_MIN_CONFIDENCE);
    vi.mocked(getNumberSetting).mockResolvedValueOnce(0.9);
    expect(await resolveXrefThreshold()).toBe(0.9);
  });

  it('reads the XREF_RECOMMENDATION_MIN_CONFIDENCE key, not an env var', async () => {
    // B0-638 compliance: the value must come from the settings table. A stray env var of the old
    // name must not be able to influence the gate any more.
    process.env.XREF_RECOMMENDATION_MIN_CONFIDENCE = '0.10';
    expect(await resolveXrefThreshold()).toBe(DEFAULT_XREF_MIN_CONFIDENCE);
    delete process.env.XREF_RECOMMENDATION_MIN_CONFIDENCE;
    expect(vi.mocked(getNumberSetting)).toHaveBeenCalledWith(
      'XREF_RECOMMENDATION_MIN_CONFIDENCE',
      DEFAULT_XREF_MIN_CONFIDENCE,
    );
  });
});
