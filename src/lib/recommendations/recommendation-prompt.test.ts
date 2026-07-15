import { describe, expect, it } from 'vitest';

import { XREF_DECLINE_COPY } from '~/lib/recommendations/confidence-scoring';
import {
  buildCrossReferenceRecommendationPrompt,
  recommendationAnswerSchema,
} from '~/lib/recommendations/recommendation-prompt';

describe('buildCrossReferenceRecommendationPrompt (B0-90)', () => {
  it('injects the threshold from config and inlines the shared decline copy', () => {
    const prompt = buildCrossReferenceRecommendationPrompt({ threshold: 0.8 });
    expect(prompt).toContain('at or above 0.8');
    expect(prompt).toContain(XREF_DECLINE_COPY);
    // threshold is not hardcoded — a different config value flows through
    expect(buildCrossReferenceRecommendationPrompt({ threshold: 0.9 })).toContain('at or above 0.9');
  });

  it('instructs grounding (no fabricated products/keys/specs)', () => {
    const prompt = buildCrossReferenceRecommendationPrompt({ threshold: 0.8 });
    expect(prompt).toMatch(/real retrieved candidate/i);
    expect(prompt).toMatch(/do not (use outside knowledge|invent)/i);
  });

  it('is stable for a fixed threshold (snapshot)', () => {
    expect(buildCrossReferenceRecommendationPrompt({ threshold: 0.8 })).toMatchSnapshot();
  });
});

describe('recommendationAnswerSchema (B0-90)', () => {
  it('parses a well-formed answered result', () => {
    const parsed = recommendationAnswerSchema.parse({
      answer_given: true,
      overall_confidence: 0.86,
      candidates: [
        { betco_product: 'Triforce', product_key: '333B5-00', confidence: 0.9, rationale: 'shared EPA registrant', evidence_urls: ['https://epa.gov/x'] },
      ],
      decline_reason: null,
    });
    expect(parsed.answer_given).toBe(true);
    expect(parsed.candidates[0].product_key).toBe('333B5-00');
  });

  it('parses a decline and rejects out-of-range confidence', () => {
    expect(
      recommendationAnswerSchema.safeParse({ answer_given: false, overall_confidence: 0.4, candidates: [], decline_reason: 'contact a rep' }).success,
    ).toBe(true);
    expect(
      recommendationAnswerSchema.safeParse({ answer_given: true, overall_confidence: 1.5, candidates: [], decline_reason: null }).success,
    ).toBe(false);
  });
});
