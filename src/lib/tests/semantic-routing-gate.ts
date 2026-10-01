import {
  computeSemanticRoutingReport,
  type SemanticRoutingItem,
  type SemanticRoutingReport,
} from './routing-comparison';

/**
 * B0-652 — the pass/fail half of the semantic-router eval gate, kept as a pure function so the
 * thresholds and the "did it regress" logic are unit-testable without an OpenAI key, a database, or
 * a deployed app. The measurement half is `computeSemanticRoutingReport`; the execution half (which
 * actually calls the routers over the golden set) is `semantic-routing-eval.live.test.ts`.
 *
 * Nothing here hardcodes a passing result. Every threshold is an input with an explicit default,
 * and a check whose data is missing reports `'skip'` rather than `'pass'` — an unmeasured gate must
 * never read as a green one (the B0-465 lesson: a gate that cannot fail is not a gate).
 */

/** The B0-497 LLM-classifier baseline the semantic router has to at least match. */
export type SemanticRoutingGateThresholds = {
  /**
   * Strict accuracy floor. Expressed as an explicit number rather than "whatever the LLM scored"
   * so a run can be graded offline; pass the LLM router's measured accuracy from the same run to
   * compare like-for-like (see `baselineAccuracy`).
   */
  minStrictAccuracy: number;
  /** Lenient (`plausible_agents`) accuracy floor — always ≥ the strict figure by construction. */
  minLenientAccuracy: number;
  /** Hard cap on CONFIDENTLY wrong routes: `path === 'semantic'` and the route missed ground truth. */
  maxFalsePositiveRate: number;
  /** Hard cap on how often the router declines (both thresholds must pass for it to commit). */
  maxFallbackRate: number;
  /**
   * p95 budget for the COSINE-SCORING component only. The end-to-end p95 includes an OpenAI
   * embedding round-trip (tens to hundreds of ms cold) and is reported, never gated — asserting
   * ≤10ms on a network call would be a test that lies.
   */
  maxScoringP95Ms: number;
  /** Minimum scored items before any accuracy check is meaningful. Below this everything skips. */
  minScoredItemCount: number;
};

export const DEFAULT_SEMANTIC_ROUTING_GATE_THRESHOLDS: SemanticRoutingGateThresholds = {
  // 0.7 mirrors the B0-499 golden set's shape: 74 items across 5 agents plus a deliberate
  // ambiguous bucket, so a router that only nails the clean-cut rows lands well under this.
  minStrictAccuracy: 0.7,
  minLenientAccuracy: 0.8,
  maxFalsePositiveRate: 0.05,
  maxFallbackRate: 0.35,
  maxScoringP95Ms: 10,
  minScoredItemCount: 20,
};

export type GateCheckStatus = 'pass' | 'fail' | 'skip';

export type SemanticRoutingGateCheck = {
  name: string;
  status: GateCheckStatus;
  /** The measured value, or null when there was nothing to measure (`status: 'skip'`). */
  actual: number | null;
  threshold: number;
  /** Human-readable one-liner for the CI log. */
  detail: string;
};

export type SemanticRoutingGateResult = {
  pass: boolean;
  checks: SemanticRoutingGateCheck[];
  report: SemanticRoutingReport;
  /** Present only when a baseline accuracy was supplied — the "≥ B0-497 baseline" comparison. */
  baselineComparison: {
    baselineAccuracy: number;
    semanticAccuracy: number | null;
    status: GateCheckStatus;
  } | null;
};

function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function atMost(
  name: string,
  actual: number | null,
  threshold: number,
  unit: 'rate' | 'ms',
): SemanticRoutingGateCheck {
  const format = (value: number | null) => (unit === 'rate' ? pct(value) : value === null ? 'n/a' : `${value}ms`);
  if (actual === null) {
    return {
      name,
      status: 'skip',
      actual: null,
      threshold,
      detail: `${name}: no measurement — skipped (not counted as a pass)`,
    };
  }
  const status: GateCheckStatus = actual <= threshold ? 'pass' : 'fail';
  return {
    name,
    status,
    actual,
    threshold,
    detail: `${name}: ${format(actual)} (max ${format(threshold)}) → ${status.toUpperCase()}`,
  };
}

function atLeast(name: string, actual: number | null, threshold: number): SemanticRoutingGateCheck {
  if (actual === null) {
    return {
      name,
      status: 'skip',
      actual: null,
      threshold,
      detail: `${name}: no measurement — skipped (not counted as a pass)`,
    };
  }
  const status: GateCheckStatus = actual >= threshold ? 'pass' : 'fail';
  return {
    name,
    status,
    actual,
    threshold,
    detail: `${name}: ${pct(actual)} (floor ${pct(threshold)}) → ${status.toUpperCase()}`,
  };
}

/**
 * Grades one golden-set run of the semantic router. `baselineAccuracy` is the "≥ B0-497 baseline"
 * side of the AC: pass the LLM classifier's STRICT accuracy measured over the very same items, so
 * the comparison isn't against a stale historical number. Omit it and that comparison is reported
 * as skipped rather than silently assumed to hold.
 *
 * `pass` is true only when no check FAILED. Skipped checks do not make the gate pass on their own:
 * a result whose every check skipped is reported with `pass: true` but zero passing checks, and the
 * caller (the live eval test) fails loudly on an empty measurement instead — see that file.
 */
export function evaluateSemanticRoutingGate(params: {
  items: SemanticRoutingItem[];
  thresholds?: Partial<SemanticRoutingGateThresholds>;
  baselineAccuracy?: number | null;
}): SemanticRoutingGateResult {
  const thresholds = { ...DEFAULT_SEMANTIC_ROUTING_GATE_THRESHOLDS, ...params.thresholds };
  const report = computeSemanticRoutingReport(params.items);
  const enoughItems = report.accuracy.scoredItemCount >= thresholds.minScoredItemCount;

  const checks: SemanticRoutingGateCheck[] = [
    atLeast(
      'strict accuracy',
      enoughItems ? report.accuracy.strictAccuracy : null,
      thresholds.minStrictAccuracy,
    ),
    atLeast(
      'lenient accuracy (plausible_agents)',
      enoughItems ? report.accuracy.lenientAccuracy : null,
      thresholds.minLenientAccuracy,
    ),
    atMost(
      'false-positive rate (confidently wrong)',
      report.falsePositives.falsePositiveRate,
      thresholds.maxFalsePositiveRate,
      'rate',
    ),
    atMost('fallback rate', report.fallback.fallbackRate, thresholds.maxFallbackRate, 'rate'),
    atMost('scoring p95', report.latency.scoring.p95Ms, thresholds.maxScoringP95Ms, 'ms'),
  ];

  const baseline = params.baselineAccuracy;
  const baselineComparison =
    typeof baseline === 'number'
      ? {
          baselineAccuracy: baseline,
          semanticAccuracy: report.accuracy.strictAccuracy,
          status: (report.accuracy.strictAccuracy === null || !enoughItems
            ? 'skip'
            : report.accuracy.strictAccuracy >= baseline
              ? 'pass'
              : 'fail') as GateCheckStatus,
        }
      : null;

  if (baselineComparison) {
    checks.push({
      name: 'semantic ≥ LLM-classifier baseline',
      status: baselineComparison.status,
      actual: baselineComparison.semanticAccuracy,
      threshold: baselineComparison.baselineAccuracy,
      detail:
        `semantic ≥ LLM-classifier baseline: ${pct(baselineComparison.semanticAccuracy)} vs ` +
        `${pct(baselineComparison.baselineAccuracy)} → ${baselineComparison.status.toUpperCase()}`,
    });
  }

  return {
    pass: checks.every((check) => check.status !== 'fail'),
    checks,
    report,
    baselineComparison,
  };
}

/** Multi-line CI log rendering of a gate result — the thing a PR author actually reads. */
export function formatSemanticRoutingGateResult(result: SemanticRoutingGateResult): string {
  const { report } = result;
  const lines = [
    'Semantic router eval (B0-652)',
    `  scored items:            ${report.accuracy.scoredItemCount}`,
    `  strict accuracy:         ${pct(report.accuracy.strictAccuracy)}`,
    `  lenient accuracy:        ${pct(report.accuracy.lenientAccuracy)}`,
    `  false positives:         ${report.falsePositives.falsePositiveCount}/${report.falsePositives.confidentItemCount} confident routes (${pct(report.falsePositives.falsePositiveRate)})`,
    `  fallback rate:           ${report.fallback.fallbackCount}/${report.fallback.pathPresentCount} (${pct(report.fallback.fallbackRate)})`,
    `  latency total   p50/p95/p99: ${report.latency.total.p50Ms}/${report.latency.total.p95Ms}/${report.latency.total.p99Ms} ms`,
    `  latency embed   p50/p95/p99: ${report.latency.embedding.p50Ms}/${report.latency.embedding.p95Ms}/${report.latency.embedding.p99Ms} ms`,
    `  latency scoring p50/p95/p99: ${report.latency.scoring.p50Ms}/${report.latency.scoring.p95Ms}/${report.latency.scoring.p99Ms} ms`,
    '  per-route accuracy (strict / lenient):',
    ...report.accuracyByRoute.map(
      (route) =>
        `    ${route.groundTruthLabel.padEnd(12)} ${route.strictMatchedCount}/${route.itemCount} (${pct(route.strictAccuracy)}) / ${route.lenientMatchedCount}/${route.itemCount} (${pct(route.lenientAccuracy)})`,
    ),
    '  checks:',
    ...result.checks.map((check) => `    ${check.detail}`),
    `  gate: ${result.pass ? 'PASS' : 'FAIL'}`,
  ];
  return lines.join('\n');
}
