import { newCorrelationId } from '~/lib/observability/correlation-id';
import { createRecommendation } from '~/lib/recommendations/repository';
import type { CreateRecommendationInput } from '~/lib/recommendations/recommendation-schemas';
import {
  recommendCrossReference,
  type RecommendCrossReferenceDeps,
  type RecommendCrossReferenceInput,
  type RecommendCrossReferenceResult,
} from '~/lib/recommendations/recommend-cross-reference';
import { getErrorMessage } from '~/lib/utils';

/**
 * B0-89 — HITL persistence. Every recommendation outcome (answered AND declined) is written to the
 * durable store so accuracy can be reviewed later. Persistence is best-effort: a write failure is
 * logged but never blocks returning the result to the caller. A trace id ties the row to audit logs.
 */

export type RecommendationPersistContext = {
  traceId?: string;
  createdBy?: string | null;
};

/** Pure: normalize a recommendation result into the repository create-input (answered or declined). */
export function mapResultToRecommendationInput(
  input: RecommendCrossReferenceInput,
  result: RecommendCrossReferenceResult,
  ctx: { traceId: string; createdBy: string | null },
): CreateRecommendationInput {
  return {
    competitorBrand: input.competitorBrand ?? null,
    competitorProduct: input.competitorProduct,
    normalizedInput: {
      brand: input.competitorBrand ?? null,
      productName: input.competitorProduct,
      traceId: ctx.traceId,
    },
    status: result.status,
    overallConfidence: result.overallConfidence,
    thresholdUsed: result.thresholdUsed,
    answerGiven: result.answered,
    declineReason: result.declineReason,
    evidence: { ...result.evidence, source: result.source, traceId: ctx.traceId },
    createdBy: ctx.createdBy,
    candidates: result.candidates.map((c) => ({
      betcoProductKey: c.betcoProductKey,
      betcoProdId: c.betcoProdId,
      betcoTitle: c.betcoTitle,
      candidateConfidence: c.confidence,
      rank: c.rank,
      rationale: c.rationale,
      source: c.source,
    })),
  };
}

export type PersistRecommendationDeps = {
  createRecommendation: typeof createRecommendation;
};

/** Best-effort persist. Returns the new recommendation id, or null if the write failed. Never throws. */
export async function persistRecommendation(
  input: RecommendCrossReferenceInput,
  result: RecommendCrossReferenceResult,
  ctx: RecommendationPersistContext = {},
  deps: PersistRecommendationDeps = { createRecommendation },
): Promise<string | null> {
  const traceId = ctx.traceId ?? newCorrelationId();
  try {
    const created = await deps.createRecommendation(
      mapResultToRecommendationInput(input, result, {
        traceId,
        createdBy: ctx.createdBy ?? 'system',
      }),
    );
    return created.id;
  } catch (error) {
    // Best-effort: surfaced to logs/Sentry, but the caller still gets its result.
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'recommendation_persist_failed',
        trace_id: traceId,
        competitor_product: input.competitorProduct,
        message: getErrorMessage(error),
      }),
    );
    return null;
  }
}

export type RunCrossReferenceRecommendationDeps = {
  recommend?: RecommendCrossReferenceDeps;
  persist?: PersistRecommendationDeps;
};

/**
 * Production entry point: compute the recommendation (B0-85) and persist the outcome (B0-89) on
 * every call. Persistence never blocks the returned result.
 */
export async function runCrossReferenceRecommendation(
  input: RecommendCrossReferenceInput,
  ctx: RecommendationPersistContext = {},
  deps: RunCrossReferenceRecommendationDeps = {},
): Promise<RecommendCrossReferenceResult & { recommendationId: string | null }> {
  const traceId = ctx.traceId ?? newCorrelationId();
  const result = await recommendCrossReference(input, deps.recommend);
  const recommendationId = await persistRecommendation(input, result, { ...ctx, traceId }, deps.persist);
  return { ...result, recommendationId };
}
