import { XREF_DECLINE_COPY } from '~/lib/recommendations/confidence-scoring';
import { buildCompetitiveRecommendationAnswer } from '~/lib/recommendations/recommendation-answer';
import type { RecommendCrossReferenceResult } from '~/lib/recommendations/recommend-cross-reference';

/**
 * B0-183 — turn a web-grounded cross-reference recommendation (produced by the deterministic
 * `recommendCrossReference` engine when the legacy/curated lookups miss) into the user-facing answer.
 *
 * - answered + at least one candidate → a full competitive-recommendation answer (reuses the curated
 *   composer), with same-chemistry runners-up as alternatives.
 * - declined / pending / no candidates → the standard decline copy. The outcome is already persisted
 *   to the recommendations store for HITL 1-1 review by `runCrossReferenceRecommendation`.
 */

export type WebFallbackAnswer = { answerText: string; answered: boolean };

export function buildWebFallbackAnswer(input: {
  result: RecommendCrossReferenceResult;
  competitorLabel: string;
}): WebFallbackAnswer {
  const { result, competitorLabel } = input;

  if (!result.answered || result.candidates.length === 0) {
    return { answerText: result.declineReason ?? XREF_DECLINE_COPY, answered: false };
  }

  const [top, ...rest] = result.candidates;
  const spec = (result.evidence as { spec?: { chemistryClass?: string | null } } | null)?.spec;

  const answerText = buildCompetitiveRecommendationAnswer({
    competitorLabel,
    recommendedTitle: top.betcoTitle?.trim() || 'the recommended Betco product',
    recommendedUrl: top.url,
    chemistryClass: spec?.chemistryClass ?? null,
    rationale: top.rationale,
    alternatives: rest
      .map((c) => ({ name: c.betcoTitle ?? '' }))
      .filter((a) => a.name.trim().length > 0)
      .slice(0, 2),
  });

  return { answerText, answered: true };
}
