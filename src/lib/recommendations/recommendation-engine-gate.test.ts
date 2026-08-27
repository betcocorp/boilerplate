import { describe, expect, it } from 'vitest';

import {
  evaluateRecommendationEngineGate,
  parseRecommendationEngineOutput,
  type RecommendationEngineOutcome,
} from '~/lib/recommendations/recommendation-engine-gate';

const DECLINE_COPY = 'fallback decline copy';

function outcome(
  overrides: Partial<RecommendationEngineOutcome> = {},
): RecommendationEngineOutcome {
  return {
    source: 'web',
    answered: true,
    status: 'answered',
    overallConfidence: 0.84,
    thresholdUsed: 0.8,
    declineReason: null,
    invocation: 'model_called',
    ...overrides,
  };
}

function evaluate(
  o: RecommendationEngineOutcome,
  confidence = 0.9,
  confidenceGatingDisabled = false,
) {
  return evaluateRecommendationEngineGate({
    outcome: o,
    confidence,
    approved: true,
    requiresHumanReview: false,
    confidenceGatingDisabled,
    fallbackDeclineCopy: DECLINE_COPY,
  });
}

describe('parseRecommendationEngineOutput (B0-356)', () => {
  it('parses the tool payload product-tools.ts emits, ignoring the fields it does not read', () => {
    const parsed = parseRecommendationEngineOutput(
      JSON.stringify({
        ok: true,
        adapter: 'cross_reference_recommendation_v1',
        source: 'web',
        answered: false,
        status: 'declined',
        overallConfidence: 0.41,
        thresholdUsed: 0.8,
        declineReason: 'nope',
        candidates: [],
        evidence: { spec: {} },
        recommendationId: 'rec-1',
      }),
    );
    expect(parsed).toMatchObject({
      source: 'web',
      answered: false,
      status: 'declined',
      overallConfidence: 0.41,
      thresholdUsed: 0.8,
      declineReason: 'nope',
    });
  });

  it('returns null for malformed or non-engine output rather than throwing', () => {
    expect(parseRecommendationEngineOutput('{not json')).toBeNull();
    expect(parseRecommendationEngineOutput(JSON.stringify({ ok: true }))).toBeNull();
  });
});

describe('evaluateRecommendationEngineGate (B0-356)', () => {
  it('caps the workflow confidence at the engine overallConfidence on an answered result', () => {
    const result = evaluate(outcome({ overallConfidence: 0.62 }), 0.9);
    expect(result.confidence).toBe(0.62);
    expect(result.declineText).toBeNull();
    expect(result.approved).toBe(true);
    expect(result.verdict).toBe('answered');
  });

  it('never RAISES the confidence when the engine scored higher than the workflow', () => {
    expect(evaluate(outcome({ overallConfidence: 0.99 }), 0.6).confidence).toBe(0.6);
  });

  it('surfaces declineReason verbatim and forces approved:false on a decline', () => {
    const result = evaluate(
      outcome({
        answered: false,
        status: 'declined',
        overallConfidence: 0.31,
        declineReason: "I couldn't confidently identify a Betco equivalent.",
      }),
      0.9,
    );
    expect(result.declineText).toBe("I couldn't confidently identify a Betco equivalent.");
    expect(result.approved).toBe(false);
    expect(result.confidence).toBe(0.31);
    expect(result.requiresHumanReview).toBe(false);
    expect(result.issues).toEqual(['recommendation_engine_declined']);
  });

  it('falls back to the caller decline copy only when the engine returned none', () => {
    const result = evaluate(
      outcome({ answered: false, status: 'declined', declineReason: null }),
      0.9,
    );
    expect(result.declineText).toBe(DECLINE_COPY);
  });

  it("routes the engine's validator-forced 'escalated' status to human review", () => {
    const result = evaluate(
      outcome({
        answered: false,
        status: 'escalated',
        overallConfidence: 0.86,
        declineReason: 'escalated copy',
      }),
      0.9,
    );
    expect(result.requiresHumanReview).toBe(true);
    expect(result.verdict).toBe('human_review');
    expect(result.issues).toEqual(['recommendation_engine_escalated']);
    expect(result.declineText).toBe('escalated copy');
  });

  it("treats the store's 'pending' default as a human-review state too", () => {
    expect(evaluate(outcome({ answered: true, status: 'pending' }), 0.9).requiresHumanReview).toBe(
      true,
    );
  });

  it('treats a B0-329 latency-ceiling decline as a user-visible decline, not human review', () => {
    // `latencyCeilingFallback` always returns status 'declined' — never 'escalated'/'pending'.
    const result = evaluate(
      outcome({
        source: 'legacy',
        answered: false,
        status: 'declined',
        overallConfidence: 0.55,
        declineReason: 'latency ceiling copy',
      }),
      0.9,
    );
    expect(result.declineText).toBe('latency ceiling copy');
    expect(result.requiresHumanReview).toBe(false);
    expect(result.verdict).toBe('declined');
  });

  describe('BEX_DISABLE_CONFIDENCE_GATING (B0-452) interaction', () => {
    it('suppresses the numeric cap and the approved override, and records that it did', () => {
      const result = evaluate(
        outcome({ answered: false, status: 'declined', overallConfidence: 0.2 }),
        0.9,
        true,
      );
      expect(result.confidence).toBe(0.9);
      expect(result.approved).toBe(true);
      expect(result.capBypassed).toBe(true);
    });

    it('still enforces the verbatim decline — a testing flag must not fabricate an equivalence', () => {
      const result = evaluate(
        outcome({
          answered: false,
          status: 'declined',
          overallConfidence: 0.2,
          declineReason: 'engine decline',
        }),
        0.9,
        true,
      );
      expect(result.declineText).toBe('engine decline');
    });

    it('still escalates a validator-forced review to a human', () => {
      const result = evaluate(
        outcome({ answered: false, status: 'escalated', overallConfidence: 0.2 }),
        0.9,
        true,
      );
      expect(result.requiresHumanReview).toBe(true);
    });

    it('reports capBypassed:false when the engine would not have capped anything anyway', () => {
      expect(evaluate(outcome({ overallConfidence: 0.99 }), 0.6, true).capBypassed).toBe(false);
    });
  });
});
