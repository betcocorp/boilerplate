import { describe, expect, it } from 'vitest';

import { XREF_DECLINE_COPY } from '~/lib/recommendations/confidence-scoring';
import type {
  RecommendationCandidateOut,
  RecommendCrossReferenceResult,
} from '~/lib/recommendations/recommend-cross-reference';
import { buildWebFallbackAnswer } from '~/lib/recommendations/web-fallback-answer';

const candidate = (over: Partial<RecommendationCandidateOut>): RecommendationCandidateOut => ({
  betcoProductKey: 'PK',
  betcoProdId: null,
  betcoTitle: 'Betco Fight Bac RTU',
  confidence: 0.8,
  rank: 1,
  url: 'https://betco.com/fight-bac',
  rationale: 'Same quat one-step disinfectant chemistry.',
  source: { via: 'web' },
  tier: 'primary',
  ...over,
});

const result = (over: Partial<RecommendCrossReferenceResult>): RecommendCrossReferenceResult => ({
  source: 'web',
  answered: true,
  status: 'answered',
  overallConfidence: 0.82,
  thresholdUsed: 0.6,
  candidates: [candidate({})],
  evidence: { spec: { chemistryClass: 'quat' } },
  declineReason: null,
  ...over,
});

describe('buildWebFallbackAnswer', () => {
  it('composes a competitive answer for an answered web recommendation with alternatives', () => {
    const out = buildWebFallbackAnswer({
      competitorLabel: 'Spartan Xtreme Blue Triple Foam Polish',
      result: result({
        candidates: [
          candidate({ betcoTitle: 'Betco Fight Bac RTU', rank: 1 }),
          candidate({ betcoProductKey: 'PK2', betcoTitle: 'Betco Quat Stat', rank: 2 }),
          candidate({ betcoProductKey: 'PK3', betcoTitle: 'Betco Sentinel', rank: 3 }),
        ],
      }),
    });

    expect(out.answered).toBe(true);
    expect(out.answerText).toContain('Betco Fight Bac RTU');
    expect(out.answerText).toContain('Spartan Xtreme Blue Triple Foam Polish');
    // runners-up surface as alternatives (only when >= 2 exist)
    expect(out.answerText).toContain('Betco Quat Stat');
    expect(out.answerText).toContain('Betco Sentinel');
  });

  it('returns the decline copy for a declined result', () => {
    const out = buildWebFallbackAnswer({
      competitorLabel: 'Spartan Foam Polish',
      result: result({ answered: false, status: 'declined', candidates: [], declineReason: XREF_DECLINE_COPY }),
    });

    expect(out.answered).toBe(false);
    expect(out.answerText).toBe(XREF_DECLINE_COPY);
  });

  it('declines when answered is true but there are no candidates', () => {
    const out = buildWebFallbackAnswer({
      competitorLabel: 'Spartan Foam Polish',
      result: result({ answered: true, candidates: [], declineReason: null }),
    });

    expect(out.answered).toBe(false);
    expect(out.answerText).toBe(XREF_DECLINE_COPY);
  });
});
