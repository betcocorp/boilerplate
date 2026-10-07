import type { XrefLatencyPolicy } from '~/lib/recommendations/recommend-cross-reference';

/**
 * B0-355 — the deterministic invocation backstop for `recommend_cross_reference`.
 *
 * `lookup_cross_reference` has had a deterministic safety net since B0-339 (the curated-override
 * lookup the workflow runs itself when the model's own call comes up empty). The SECOND hop — the
 * web-grounded recommendation engine — had no equivalent: it ran only if the model chose to call
 * it, and a skipped call left NO trace at all, so "the model never called it" was indistinguishable
 * from "it did not apply here". This module holds the two pure decisions behind the backstop so
 * they are unit-testable without the workflow's Supabase/OpenAI surface.
 */

/** The `recommend_cross_reference` tool name, in one place (matched against `toolOutputLog`). */
export const RECOMMEND_CROSS_REFERENCE_TOOL = 'recommend_cross_reference';

/**
 * Why the backstop did or did not fire this turn. Persisted on the audit row so the model's miss
 * rate (`fired: true` over every row) is a single query against `audit_logs`.
 */
export type XrefBackstopReason =
  /** Not a cross-reference turn at all — the engine was never applicable. */
  | 'not_cross_reference_turn'
  /** The model called `recommend_cross_reference` itself; nothing to back up. */
  | 'model_called_engine'
  /** Legacy/curated returned a confident 1:1 match — the zero-web-spend path stays zero-web-spend. */
  | 'confident_legacy_match'
  /** No legacy match at all, and the model never called the engine. */
  | 'legacy_missing_model_skipped'
  /** Legacy matched but asked for a fallback, and the model never called the engine. */
  | 'legacy_fallback_recommended_model_skipped';

export type XrefBackstopDecision = {
  fired: boolean;
  reason: XrefBackstopReason;
};

/**
 * The three conditions from B0-355, in order of precedence.
 *
 * `crossReferencePostProcessing` is the workflow's `useCrossReferencePostProcessing`
 * (`routingDecision === 'cross_reference' || crossReferenceIntent`). It deliberately does NOT
 * include the `recommendations` route: since B0-663 that route is the job-based recommendation
 * capability, not competitor equivalence, and spending a competitor web search there would be
 * answering a question nobody asked.
 */
export function decideXrefBackstop(input: {
  crossReferencePostProcessing: boolean;
  /** The legacy/curated cross-reference result this turn resolved, if any. */
  legacyMatch: { fallbackRecommended: boolean } | null;
  /** Whether `recommend_cross_reference` already appears in this turn's tool output log. */
  modelCalledEngine: boolean;
}): XrefBackstopDecision {
  if (!input.crossReferencePostProcessing) {
    return { fired: false, reason: 'not_cross_reference_turn' };
  }
  if (input.modelCalledEngine) {
    return { fired: false, reason: 'model_called_engine' };
  }
  // A confident legacy match is authoritative and costs no web spend — see
  // `recommend-cross-reference.ts`'s `legacyConfident` fast path, which would return immediately
  // anyway. Never trade a curated 1:1 mapping for a web search.
  if (input.legacyMatch && !input.legacyMatch.fallbackRecommended) {
    return { fired: false, reason: 'confident_legacy_match' };
  }
  return {
    fired: true,
    reason: input.legacyMatch
      ? 'legacy_fallback_recommended_model_skipped'
      : 'legacy_missing_model_skipped',
  };
}

/**
 * B0-355 / B0-329 — floor for the backstop's total latency budget.
 *
 * The backstop starts AFTER the model's tool loop has already run, so handing it a fresh
 * `totalBudgetMs` would stack a second full ceiling on an already-slow turn — exactly what B0-329
 * exists to prevent. It gets the turn's REMAINING budget instead. The floor keeps a degenerate
 * remainder from turning the backstop into a guaranteed instant timeout: below this, the engine
 * cannot even complete step 1 (the legacy lookup, usually a cache hit) plus a budgeted web search,
 * so a smaller budget would produce a decline that says nothing about the actual match.
 */
export const XREF_BACKSTOP_MIN_BUDGET_MS = 6_000;

/**
 * The backstop's latency policy: the remaining turn budget, floored at
 * `XREF_BACKSTOP_MIN_BUDGET_MS` and capped at the configured `totalBudgetMs` (a backstop never gets
 * MORE than a model-initiated call would). Per-step ceilings are left untouched: `createStepGuard`
 * already clamps every step to `min(stepBudget, totalBudgetMs - elapsed)`, so narrowing the total
 * narrows every step with it.
 */
export function resolveXrefBackstopPolicy(
  policy: XrefLatencyPolicy,
  elapsedTurnMs: number,
): XrefLatencyPolicy {
  const remaining = policy.totalBudgetMs - Math.max(0, elapsedTurnMs);
  return {
    ...policy,
    totalBudgetMs: Math.max(
      XREF_BACKSTOP_MIN_BUDGET_MS,
      Math.min(policy.totalBudgetMs, Math.floor(remaining)),
    ),
  };
}
