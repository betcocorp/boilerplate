import { z } from 'zod';

/**
 * B0-356 — enforcement for the `recommend_cross_reference` engine's own verdict.
 *
 * The engine already returns `answered`, `status`, `overallConfidence`, `thresholdUsed` and
 * `declineReason` (see `recommend-cross-reference.ts`), and the specialist prompt calls those
 * authoritative. Until this module, NO CODE READ ANY OF THEM: the workflow's two cross-reference
 * extractors both filter on `toolName === 'lookup_cross_reference'` and skipped the engine output
 * entirely, so a turn carried two unrelated confidence numbers — the engine's calibrated
 * `overallConfidence`, and the workflow's `validation.confidence` (`sources.length > 0 ? 0.9 : 0.6`,
 * narrowed by `evaluateRecommendationGate`) — and only the second one ever reached the user. An
 * engine decline could therefore ship as a paraphrased answer at `confidence: 0.9`, which is a
 * product-equivalence claim about EPA-registered chemistry made after the grounding filter
 * (`filterGroundedCandidates`) and the safety scan (`scanUnsupportedSafetyClaims`) both said no.
 *
 * This module is pure: parsing the tool payload and deciding what the verdict means. The workflow
 * applies the result.
 */

/**
 * The `recommend_cross_reference` tool payload, as emitted by `product-tools.ts` and mirrored by the
 * B0-355 backstop. `.loose()` because the payload also carries `candidates`/`evidence`/`adapter`,
 * none of which this gate reads — but a shape change there must not make the gate silently stop
 * firing.
 */
export const recommendationEngineOutputSchema = z
  .object({
    ok: z.boolean().optional(),
    source: z.enum(['legacy', 'web']),
    answered: z.boolean(),
    status: z.string(),
    overallConfidence: z.number(),
    thresholdUsed: z.number(),
    declineReason: z.string().nullable().optional(),
    recommendationId: z.string().nullable().optional(),
  })
  .loose();

export type RecommendationEngineOutput = z.infer<typeof recommendationEngineOutputSchema>;

/** Whether the engine ran because the model asked, or because the B0-355 backstop forced it. */
export type RecommendationEngineInvocation = 'model_called' | 'backstop';

export type RecommendationEngineOutcome = RecommendationEngineOutput & {
  invocation: RecommendationEngineInvocation;
};

/**
 * B0-353 — the engine's human-in-the-loop states. `escalated` is what `runWebGroundedPath` writes
 * when the validator gate refuses to pass a drafted recommendation; `pending` is the store's
 * insert-time default and is accepted here defensively so any other writer of this payload lands in
 * the review queue rather than in front of a user.
 *
 * A B0-329 latency-ceiling trip is deliberately NOT in this set: `latencyCeilingFallback` always
 * returns `'declined'`, because a run that was cut short is the opposite of a run whose HITL phase
 * legitimately engaged.
 */
const HUMAN_REVIEW_STATUSES = new Set(['escalated', 'pending']);

/**
 * Prefix for every `validation.issues` token this gate adds, so the engine's verdict is greppable
 * in `workflow_runs.final_output` / `workflow_steps.output` without matching on a whole string.
 */
export const RECOMMENDATION_ENGINE_GATE_ISSUE_PREFIX = 'recommendation_engine_';

export function isRecommendationEngineHumanReviewStatus(status: string): boolean {
  return HUMAN_REVIEW_STATUSES.has(status);
}

/** Parse one `recommend_cross_reference` tool output. Returns null for anything unparseable. */
export function parseRecommendationEngineOutput(
  rawJson: string,
): RecommendationEngineOutput | null {
  try {
    const parsed = recommendationEngineOutputSchema.safeParse(JSON.parse(rawJson));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export type RecommendationEngineGateResult = {
  /** Text that must replace the draft answer verbatim, or null to leave the draft alone. */
  declineText: string | null;
  /** The confidence the turn may report. Never above `overallConfidence` once the engine ran. */
  confidence: number;
  approved: boolean;
  requiresHumanReview: boolean;
  issues: string[];
  /** `answered` | `declined` | `human_review` | `bypassed_cap` — for the persisted gate record. */
  verdict: string;
  /** True when `BEX_DISABLE_CONFIDENCE_GATING` suppressed the numeric cap this run. */
  capBypassed: boolean;
};

/**
 * B0-356 — turn the engine's verdict into the mutations the workflow applies.
 *
 * Kill-switch interaction (`BEX_DISABLE_CONFIDENCE_GATING`, B0-452) is deliberately SPLIT, and the
 * split is the point:
 *
 * - The numeric confidence cap (`min(confidence, overallConfidence)`) and the `approved` override
 *   are calibration. `XREF_RECOMMENDATION_MIN_CONFIDENCE` is exactly the kind of unproven threshold
 *   the kill switch exists to test around, so they honour it and are recorded as `bypassed`.
 * - The decline replacement and the human-review escalation are NOT thresholds. `answered` /
 *   `status` are the FINAL verdict of a gate that already ran to completion — grounding
 *   (`filterGroundedCandidates`), the safety scan (`scanUnsupportedSafetyClaims`) and the
 *   validator gate. Letting a testing flag replace "there is no grounded equivalent" with model
 *   prose would not be relaxing a threshold, it would be fabricating a product-equivalence claim
 *   for an EPA-registered product. Those two are enforced unconditionally.
 *
 * Either way the run stays identifiable: `runtimeConfig.confidenceGatingDisabled` records the flag,
 * and the gate record this result feeds carries `capBypassed`.
 */
export function evaluateRecommendationEngineGate(input: {
  outcome: RecommendationEngineOutcome;
  /** The confidence the workflow has arrived at so far (validator judgment or bypass heuristic). */
  confidence: number;
  approved: boolean;
  requiresHumanReview: boolean;
  /** Resolved value of the B0-452 kill switch for this run. */
  confidenceGatingDisabled: boolean;
  /** Fallback decline copy when the engine returned no `declineReason` (never expected). */
  fallbackDeclineCopy: string;
}): RecommendationEngineGateResult {
  const { outcome } = input;
  const humanReview = isRecommendationEngineHumanReviewStatus(outcome.status);
  const capped = Math.min(input.confidence, outcome.overallConfidence);
  const capBypassed = input.confidenceGatingDisabled && capped < input.confidence;

  // Never let the workflow's 0.9 default RAISE the engine's calibrated number.
  const confidence = input.confidenceGatingDisabled ? input.confidence : capped;

  if (outcome.answered && !humanReview) {
    return {
      declineText: null,
      confidence,
      approved: input.approved,
      requiresHumanReview: input.requiresHumanReview,
      issues: [],
      verdict: capBypassed ? 'bypassed_cap' : 'answered',
      capBypassed,
    };
  }

  const issues = [
    `${RECOMMENDATION_ENGINE_GATE_ISSUE_PREFIX}${humanReview ? outcome.status : 'declined'}`,
  ];

  return {
    // Verbatim: the engine's own copy, never reworded here.
    declineText: outcome.declineReason?.trim()
      ? outcome.declineReason
      : input.fallbackDeclineCopy,
    confidence,
    // `approved` is part of the calibration half, so the kill switch leaves it alone.
    approved: input.confidenceGatingDisabled ? input.approved : false,
    // Enforced unconditionally: a validator-forced review must never be silently downgraded.
    requiresHumanReview: input.requiresHumanReview || humanReview,
    issues,
    verdict: humanReview ? 'human_review' : 'declined',
    capBypassed,
  };
}
