/**
 * B0-911 — run-level "was this run's routing pipeline degraded?" reducer.
 *
 * Why this exists: on 2026-09-08 a paired 106-case OpenAI-vs-Anthropic comparison ran with
 * `classifyUserIntent` returning a 400 on EVERY item. Both it and `analyzeTurnSignals` catch
 * provider failures, log via `logError`, and hand back a keyword-router fallback — so the run
 * completed, produced a letter grade, and looked perfectly healthy. That grade was then read as a
 * vendor verdict. The raw signals were in the DB the whole time (`routing_confidence` 0.000 and
 * `llm_route` 'ambiguous' on all 106 rows); nothing surfaced them.
 *
 * Pure reducer, no I/O — the row fetch lives in `repository.ts`
 * (`listRoutingHealthRowsByResultId`) and the rendering in
 * `~/components/admin/tests/DegradedRunBanner.tsx`, the same split every other harness report in
 * this directory uses (`routing-comparison.ts`, `tool-routing.ts`, `signal-accuracy.ts`).
 */

/**
 * More than 5% of measured items fell back → degraded. Deliberately not zero: one transient
 * provider blip on a 100-case run is noise, and a banner that cries wolf on every run is a banner
 * nobody reads. Five per cent of a 106-case run is 6 items, which is a pattern, not a blip.
 */
export const DEGRADED_FALLBACK_RATE_THRESHOLD = 0.05;

/**
 * Mean `routing_confidence` below 0.30 → degraded, INDEPENDENT of the fallback rate. This is the
 * rule that catches history: rows written before `routing_fallback_reason` existed have no reason
 * to read, but the 2026-09-08 run still shows mean 0.000 because `classifyUserIntent`'s fallback
 * stamps a fixed 0 (ambiguous) / 0.5 (keyword hit) placeholder rather than a real model score.
 * A healthy LLM-routed run sits far above this.
 */
export const DEGRADED_MEAN_CONFIDENCE_THRESHOLD = 0.3;

/** The two per-item columns this reducer reads. Structural, so tests need no DB row shape. */
export type RunRoutingHealthInput = {
  /** `test_result_items.routing_confidence`; null = this row predates routing instrumentation. */
  routingConfidence: number | null;
  /** `test_result_items.routing_fallback_reason`; null = no fallback observed, or predates B0-911. */
  routingFallbackReason: string | null;
};

/** One distinct fallback reason and how many items hit it, most frequent first. */
export type RunRoutingFallbackReason = {
  reason: string;
  count: number;
};

export type RunRoutingHealth = {
  /** Every row considered, including pre-instrumentation ones. */
  totalItems: number;
  /**
   * Rows with a non-null `routing_confidence` — i.e. rows where the routing instrumentation
   * actually ran. Both thresholds are computed over THIS denominator, never `totalItems`: mixing
   * pre-instrumentation rows in would dilute a real 100%-fallback run into a passing rate.
   */
  measuredItems: number;
  /** Rows carrying a fallback reason. */
  fallbackItems: number;
  /** `fallbackItems / measuredItems`, or null when nothing was measured. */
  fallbackRate: number | null;
  /** Mean `routing_confidence` over measured rows, or null when nothing was measured. */
  meanRoutingConfidence: number | null;
  /** True when EITHER threshold trips. */
  degraded: boolean;
  /** Which rule(s) tripped — so the banner can say what it actually detected. */
  reasonsForDegradation: Array<'fallback_rate' | 'low_mean_confidence'>;
  /** Distinct reasons, most frequent first; ties broken alphabetically for a stable render. */
  fallbackReasons: RunRoutingFallbackReason[];
  /**
   * The most common fallback reason, or null when no item recorded one. Null WITH `degraded: true`
   * is a real state (a pre-B0-911 run caught by the confidence rule) and the banner must say
   * "reason not recorded" rather than imply the pipeline was fine.
   */
  topFallbackReason: string | null;
};

const HEALTHY: RunRoutingHealth = {
  totalItems: 0,
  measuredItems: 0,
  fallbackItems: 0,
  fallbackRate: null,
  meanRoutingConfidence: null,
  degraded: false,
  reasonsForDegradation: [],
  fallbackReasons: [],
  topFallbackReason: null,
};

/**
 * Reduces one run's per-item routing instrumentation to a degraded/healthy verdict.
 *
 * A run with zero measured items is NOT degraded: a search-mode run, or one that predates the
 * B0-500 columns entirely, has nothing to say about its router, and calling that "degraded" would
 * put a red banner on most of the run archive.
 */
export function computeRunRoutingHealth(
  items: readonly RunRoutingHealthInput[],
): RunRoutingHealth {
  if (items.length === 0) {
    return HEALTHY;
  }

  const measured = items.filter((item) => item.routingConfidence !== null);
  const reasonCounts = new Map<string, number>();
  let fallbackItems = 0;

  for (const item of items) {
    const reason = item.routingFallbackReason?.trim();
    if (!reason) {
      continue;
    }
    fallbackItems += 1;
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }

  const fallbackReasons: RunRoutingFallbackReason[] = [...reasonCounts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => (b.count - a.count) || a.reason.localeCompare(b.reason));

  if (measured.length === 0) {
    return {
      ...HEALTHY,
      totalItems: items.length,
      fallbackItems,
      fallbackReasons,
      topFallbackReason: fallbackReasons[0]?.reason ?? null,
    };
  }

  const fallbackRate = fallbackItems / measured.length;
  const confidenceSum = measured.reduce((sum, item) => sum + (item.routingConfidence ?? 0), 0);
  const meanRoutingConfidence = confidenceSum / measured.length;

  const reasonsForDegradation: RunRoutingHealth['reasonsForDegradation'] = [];
  if (fallbackRate > DEGRADED_FALLBACK_RATE_THRESHOLD) {
    reasonsForDegradation.push('fallback_rate');
  }
  if (meanRoutingConfidence < DEGRADED_MEAN_CONFIDENCE_THRESHOLD) {
    reasonsForDegradation.push('low_mean_confidence');
  }

  return {
    totalItems: items.length,
    measuredItems: measured.length,
    fallbackItems,
    fallbackRate,
    meanRoutingConfidence,
    degraded: reasonsForDegradation.length > 0,
    reasonsForDegradation,
    fallbackReasons,
    topFallbackReason: fallbackReasons[0]?.reason ?? null,
  };
}

/** `0.0%`-style rate for display; null renders as an em dash by the caller, never as `0%`. */
export function formatRunHealthPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}
