import { writeAuditLog } from '~/lib/audit/audit-log';
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
  /** B0-92 — record per-recommendation web-search cost/outcome. Best-effort (never blocks). */
  audit?: (eventType: string, payload: Record<string, unknown>, ctx: { traceId: string }) => Promise<void>;
};

/**
 * Production entry point: compute the recommendation (B0-85) and persist the outcome (B0-89) on
 * every call. Persistence never blocks the returned result. Also records a per-recommendation cost
 * audit entry (B0-92) with the web-search spend/telemetry.
 */
export async function runCrossReferenceRecommendation(
  input: RecommendCrossReferenceInput,
  ctx: RecommendationPersistContext = {},
  deps: RunCrossReferenceRecommendationDeps = {},
): Promise<RecommendCrossReferenceResult & { recommendationId: string | null }> {
  const traceId = ctx.traceId ?? newCorrelationId();
  const result = await recommendCrossReference(input, deps.recommend);
  const recommendationId = await persistRecommendation(input, result, { ...ctx, traceId }, deps.persist);

  const audit = deps.audit ?? ((eventType, payload, auditCtx) => writeAuditLog(eventType, payload, auditCtx));
  const evidence = result.evidence as {
    webSearch?: Record<string, unknown>;
    timingBreakdown?: Record<string, unknown>;
  };
  const webSearch = evidence.webSearch ?? null;
  // B0-323 — mirror the per-sub-step latency onto the audit entry so the tool call's 2.8s–13.2s
  // spread is attributable from the audit log as well as from `recommendation.evidence`.
  const timingBreakdown = evidence.timingBreakdown ?? null;
  await audit(
    'cross_reference_recommendation',
    {
      competitor_product: input.competitorProduct,
      competitor_brand: input.competitorBrand ?? null,
      source: result.source,
      status: result.status,
      answered: result.answered,
      overall_confidence: result.overallConfidence,
      threshold_used: result.thresholdUsed,
      recommendation_id: recommendationId,
      web_search: webSearch,
      timing_breakdown: timingBreakdown,
    },
    { traceId },
  );

  return { ...result, recommendationId };
}
