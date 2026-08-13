import { describe, expect, it } from 'vitest';

import {
  fromCandidateRow,
  fromRecommendationRow,
  toCandidateInsertRows,
  toRecommendationInsertRow,
} from '~/lib/recommendations/repository';
import {
  addRecommendationCandidateInputSchema,
  createRecommendationInputSchema,
  updateRecommendationStatusInputSchema,
} from '~/lib/recommendations/recommendation-schemas';

describe('recommendation repository mappers (B0-83)', () => {
  it('maps a create input to a snake_case insert row with null/{} defaults', () => {
    const row = toRecommendationInsertRow(
      createRecommendationInputSchema.parse({
        competitorProduct: 'BNC-15',
        overallConfidence: 0.82,
        thresholdUsed: 0.8,
        answerGiven: true,
        evidence: { sources: [{ url: 'https://x' }] },
      }),
    );
    expect(row).toMatchObject({
      competitor_brand: null,
      competitor_product: 'BNC-15',
      normalized_input: {},
      status: 'pending',
      overall_confidence: 0.82,
      threshold_used: 0.8,
      answer_given: true,
      decline_reason: null,
      evidence: { sources: [{ url: 'https://x' }] },
      created_by: null,
    });
  });

  it('assigns rank by position when omitted but preserves an explicit rank', () => {
    const rows = toCandidateInsertRows('rec-1', [
      { betcoProductKey: 'A' },
      { betcoProductKey: 'B', rank: 7 },
    ]);
    expect(rows[0]).toMatchObject({ recommendation_id: 'rec-1', betco_product_key: 'A', rank: 1, source: {} });
    expect(rows[1]).toMatchObject({ betco_product_key: 'B', rank: 7 });
  });

  it('coerces PostgREST numeric-as-string + jsonb back to the domain shape', () => {
    const rec = fromRecommendationRow({
      id: '11111111-1111-4111-8111-111111111111',
      competitor_brand: null,
      competitor_product: 'BNC-15',
      normalized_input: { brand: null, productName: 'bnc 15' },
      status: 'answered',
      overall_confidence: '0.820', // numeric comes back as a string over PostgREST
      threshold_used: '0.80',
      answer_given: true,
      decline_reason: null,
      evidence: { spec: { chemistryClass: 'quat' } },
      created_by: 'system',
      created_at: '2026-07-14T00:00:00Z',
      updated_at: '2026-07-14T00:00:00Z',
    });
    expect(rec.overallConfidence).toBe(0.82);
    expect(rec.thresholdUsed).toBe(0.8);
    expect(rec.answerGiven).toBe(true);
    expect(rec.normalizedInput).toEqual({ brand: null, productName: 'bnc 15' });
    expect(rec.evidence).toEqual({ spec: { chemistryClass: 'quat' } });
  });

  it('maps a candidate row, coercing numeric confidence + rank', () => {
    const cand = fromCandidateRow({
      id: '22222222-2222-4222-8222-222222222222',
      recommendation_id: '11111111-1111-4111-8111-111111111111',
      betco_product_key: '333B5-00',
      betco_prod_id: '333',
      betco_title: 'Triforce',
      candidate_confidence: '0.910',
      rank: '1',
      rationale: 'shared EPA registrant',
      source: { via: 'web' },
      created_at: '2026-07-14T00:00:00Z',
    });
    expect(cand.candidateConfidence).toBe(0.91);
    expect(cand.rank).toBe(1);
    expect(cand.source).toEqual({ via: 'web' });
  });

  it('rejects an empty competitor product and defaults status/answerGiven', () => {
    expect(createRecommendationInputSchema.safeParse({ competitorProduct: '' }).success).toBe(false);
    const ok = createRecommendationInputSchema.parse({ competitorProduct: 'X' });
    expect(ok.status).toBe('pending');
    expect(ok.answerGiven).toBe(false);
    expect(ok.candidates).toEqual([]);
  });

  it('validates the status-update input enum', () => {
    expect(updateRecommendationStatusInputSchema.safeParse({ status: 'verified', verifier: 'tb' }).success).toBe(true);
    expect(updateRecommendationStatusInputSchema.safeParse({ status: 'nope' }).success).toBe(false);
  });
});

/**
 * B0-433 — a reviewer-added candidate exists to make an un-approvable recommendation approvable,
 * so the schema has to guarantee the two fields `promoteRecommendationToOverride` requires. Every
 * one of the 220 candidates the engine had written was missing `betcoProductKey`, which is exactly
 * how the queue ended up unable to promote anything.
 */
describe('addRecommendationCandidateInputSchema (B0-433)', () => {
  it('accepts a candidate carrying both fields promotion requires', () => {
    const parsed = addRecommendationCandidateInputSchema.parse({
      betcoTitle: 'Green Earth Peroxide Cleaner',
      betcoProductKey: '3355',
      rationale: 'Same peroxide chemistry and dilution class.',
    });
    expect(parsed.betcoTitle).toBe('Green Earth Peroxide Cleaner');
    expect(parsed.betcoProductKey).toBe('3355');
  });

  it('trims surrounding whitespace so a padded key still promotes', () => {
    const parsed = addRecommendationCandidateInputSchema.parse({
      betcoTitle: '  Green Earth Peroxide Cleaner  ',
      betcoProductKey: '  3355  ',
    });
    expect(parsed.betcoTitle).toBe('Green Earth Peroxide Cleaner');
    expect(parsed.betcoProductKey).toBe('3355');
  });

  it('rejects a missing or blank product key', () => {
    expect(() =>
      addRecommendationCandidateInputSchema.parse({ betcoTitle: 'Green Earth' }),
    ).toThrow();
    expect(() =>
      addRecommendationCandidateInputSchema.parse({
        betcoTitle: 'Green Earth',
        betcoProductKey: '   ',
      }),
    ).toThrow();
  });

  it('rejects a missing or blank title', () => {
    expect(() =>
      addRecommendationCandidateInputSchema.parse({ betcoProductKey: '3355' }),
    ).toThrow();
    expect(() =>
      addRecommendationCandidateInputSchema.parse({ betcoTitle: '  ', betcoProductKey: '3355' }),
    ).toThrow();
  });

  it('treats rationale as optional', () => {
    const parsed = addRecommendationCandidateInputSchema.parse({
      betcoTitle: 'Green Earth',
      betcoProductKey: '3355',
    });
    expect(parsed.rationale).toBeUndefined();
  });
});
