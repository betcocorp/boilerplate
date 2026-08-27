/**
 * B0-466 — the pure, unit-tested decision surface for observability alerting.
 *
 * No I/O, no clock, no Sentry: this module takes already-fetched series plus resolved thresholds
 * and returns structured findings. Everything that touches the world lives in
 * `~/lib/observability/run-alert-evaluation.ts`, the same split as
 * `stalled-run-sweeper.ts` / `stalled-run-repository.ts` (B0-371).
 *
 * ## The regression this is calibrated against
 * B0-446 found that the `tool_failed` share jumped ~75x on 2026-05-22 and stayed elevated for
 * months with no alert. Measured live 2026-08-27 on the settled denominator (see
 * `~/lib/observability/tool-failure-series.ts`), the real day series around it was:
 *
 * | day        | settled | failed | rate    |
 * | ---------- | ------: | -----: | ------: |
 * | 2026-05-20 |     235 |      3 |  1.28%  |
 * | 2026-05-21 |      43 |      0 |  0.00%  |  ← below the min-sample floor, not a baseline
 * | 2026-05-22 |   1,149 |    792 | 68.93%  |  ← must alert, same day
 * | 2026-05-23 |     419 |    295 | 70.41%  |
 *
 * (The ticket quotes 0.6% → 45.6%; those are B0-446's figures over a different denominator and a
 * different window. The direction and the magnitude are the same, and the rules below are
 * calibrated against the settled-basis numbers above, which are what this code actually reads.)
 *
 * ## …and the noise it must tolerate
 * The current healthy regime is 0.00%–1.32% per day. The noisiest ordinary recent day was
 * 2026-08-26 at 8.33% of 132 settled calls — that is real noise on a small denominator and MUST
 * stay silent: it is below the 15% absolute floor, and its +7.47pp step over the previous day
 * (0.86% of 116 settled) is below the 10pp spike delta. Both cases are asserted in
 * `alert-rules.test.ts` against these exact numbers.
 *
 * ## Four deliberate anti-false-positive rules
 * 1. **Min sample.** A bucket under `toolFailureMinSettledCalls` settled calls is never alertable.
 *    Live data has days with 1–43 settled calls where a single failure is 2%–100%.
 * 2. **`null` is not zero.** An empty bucket's `failureRate` is null (not 0), so a gap can never
 *    be used as a baseline to manufacture a spike off.
 * 3. **Baseline is the last QUALIFYING bucket, not the calendar-previous one.** Traffic has gaps
 *    (whole days with no runs), so "yesterday" is frequently absent or too small. Which bucket was
 *    used is recorded on the finding, so a human can check the comparison.
 * 4. **The judged bucket may lag by one, and never more.** The cron runs part-way through the
 *    newest bucket; see `MAX_CURRENT_BUCKET_LAG`. This is what stops a mid-morning run from either
 *    evaluating a 7-hour-old sample or reaching back into settled history.
 *
 * ## Why `failureRate` (all settled) and not `ordinaryFailureRate`
 * The speculative-call marker (B0-436) only exists from 2026-08 onward, so on all historical
 * buckets the two are identical. On current traffic, excluding speculative retrievals shrinks the
 * denominator by ~2/3 and the resulting rate swings 0%–17% day to day on 10–30 calls — it would
 * false-positive constantly. The all-settled rate is both the ticket's literal metric and the
 * stable one. `ordinaryFailureRate` still travels on every finding as context.
 */

import { z } from 'zod';

import type { ToolFailureRatePoint, ToolFailureRateSeries } from '~/lib/observability/tool-failure-series';
import type { GoldenRunSeries } from '~/lib/tests/golden-set-run-series';
import { verdictForTier, type TierTarget } from '~/lib/tests/tier-targets';

export const ALERT_SEVERITIES = ['warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

export const ALERT_METRICS = [
  'tool_failure_rate',
  'tool_failure_rate_spike',
  'golden_set_pass_rate_drop',
  'golden_set_gate_miss',
] as const;

export const alertFindingSchema = z.object({
  metric: z.enum(ALERT_METRICS),
  severity: z.enum(ALERT_SEVERITIES),
  /** Which slice of time or which run the observation covers, in human terms. */
  window: z.string(),
  /** The measured value, 0..1 for every metric currently defined. */
  observed: z.number(),
  /** The value it was compared against — a threshold, a baseline rate, or a tier target. */
  threshold: z.number(),
  /** Denominator behind `observed`: settled tool calls, or graded golden-set items. */
  sampleSize: z.number().int().nonnegative(),
  /** One sentence an operator can act on without opening a dashboard. */
  message: z.string(),
  /** Metric-specific supporting numbers (baseline bucket, per-tier rates, run ids…). */
  context: z.record(z.string(), z.unknown()),
});
export type AlertFinding = z.infer<typeof alertFindingSchema>;

/**
 * Resolved thresholds. Defaults match the seeded `settings` rows in
 * `20260827021000_add_observability_alert_settings_b0466.sql`; the reader
 * (`getObservabilityAlertConfig` in `~/lib/observability/alert-settings.ts`) is what makes them
 * tunable without a deploy.
 */
export const alertThresholdsSchema = z.object({
  toolFailureRateWarning: z.number().min(0).max(1).default(0.15),
  toolFailureRateCritical: z.number().min(0).max(1).default(0.3),
  toolFailureMinSettledCalls: z.number().int().min(1).default(50),
  toolFailureSpikeDelta: z.number().min(0).max(1).default(0.1),
  toolFailureSpikeRatio: z.number().min(1).default(3),
  goldenPassRateDropWarning: z.number().min(0).max(1).default(0.1),
  goldenPassRateDropCritical: z.number().min(0).max(1).default(0.2),
  goldenMinGradedItems: z.number().int().min(1).default(5),
  goldenGateMissEnabled: z.boolean().default(true),
});
export type AlertThresholds = z.infer<typeof alertThresholdsSchema>;

export const DEFAULT_ALERT_THRESHOLDS: AlertThresholds = alertThresholdsSchema.parse({});

/**
 * Why a rule produced nothing. Recorded on every evaluation so a silent verdict is explained
 * rather than merely empty — the whole point of B0-466 is that silence was previously ambiguous.
 */
export const ALERT_SKIP_REASONS = [
  'no_traffic',
  'insufficient_sample',
  'no_baseline',
  'no_golden_sets',
  'no_comparable_previous',
  'insufficient_graded',
  'gate_rule_disabled',
] as const;
export type AlertSkipReason = (typeof ALERT_SKIP_REASONS)[number];

export const alertMetricsSummarySchema = z.object({
  toolFailure: z.object({
    bucketSize: z.enum(['day', 'hour']),
    windowFrom: z.string(),
    windowTo: z.string(),
    bucketCount: z.number().int().nonnegative(),
    scannedRows: z.number().int().nonnegative(),
    /** True when the paged scan hit its budget — the rate may be under-counted. */
    truncated: z.boolean(),
    current: z
      .object({
        bucket: z.string(),
        settled: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        failureRate: z.number().nullable(),
        ordinaryFailureRate: z.number().nullable(),
      })
      .nullable(),
    baseline: z
      .object({
        bucket: z.string(),
        settled: z.number().int().nonnegative(),
        failureRate: z.number().nullable(),
      })
      .nullable(),
    skipped: z.array(z.enum(ALERT_SKIP_REASONS)),
  }),
  goldenSet: z.object({
    testsEvaluated: z.number().int().nonnegative(),
    testsCompared: z.number().int().nonnegative(),
    skipped: z.array(z.object({ testName: z.string(), reason: z.enum(ALERT_SKIP_REASONS) })),
  }),
});
export type AlertMetricsSummary = z.infer<typeof alertMetricsSummarySchema>;

export const alertEvaluationSchema = z.object({
  findings: z.array(alertFindingSchema),
  metrics: alertMetricsSummarySchema,
});
export type AlertEvaluation = z.infer<typeof alertEvaluationSchema>;

/** `critical` outranks `warning`; null when there are no findings. */
export function maxSeverity(findings: readonly AlertFinding[]): AlertSeverity | null {
  if (findings.some((finding) => finding.severity === 'critical')) {
    return 'critical';
  }
  return findings.some((finding) => finding.severity === 'warning') ? 'warning' : null;
}

function asPercent(rate: number): string {
  return `${(rate * 100).toFixed(2)}%`;
}

/**
 * `critical` above the critical rate, `warning` otherwise.
 *
 * The FIRING floor is `min(warning, critical)` at the call site, not `warning` — `settings.value`
 * is free text with no cross-row constraint, so a hand edit can leave warning ABOVE critical, and
 * trusting `warning` alone would then make a rate between the two silent even though it is over the
 * critical bar. Clamping is cheaper and safer than validating a relationship between two rows.
 */
function severityForRate(rate: number, thresholds: AlertThresholds): AlertSeverity {
  return rate >= thresholds.toolFailureRateCritical ? 'critical' : 'warning';
}

type ToolBucketSelection = {
  current: ToolFailureRatePoint | null;
  baseline: ToolFailureRatePoint | null;
  skipped: AlertSkipReason[];
};

/**
 * How far back from the end of the window `current` may sit, in buckets.
 *
 * This exists because the cron necessarily runs PART-WAY through the newest bucket. A daily run at
 * 07:10 UTC sees only ~7 hours of today, which routinely falls under the sample floor; if `current`
 * were pinned to the newest bucket with traffic, that run would evaluate nothing and yesterday's
 * completed day — the day an incident actually shows up in — would never be judged at all. A lag of
 * 1 lets the evaluation fall back exactly one bucket (yesterday for a day series) when today is
 * still too thin, and no further, so an alert can never be raised off stale history.
 */
export const MAX_CURRENT_BUCKET_LAG: Record<'day' | 'hour', number> = { day: 1, hour: 2 };

/**
 * Picks the bucket to judge and the bucket to judge it against.
 *
 * `current` is the newest bucket that meets the sample floor within `MAX_CURRENT_BUCKET_LAG` of the
 * window's end — never merely the last bucket in the window (usually a seeded empty one), and never
 * an arbitrarily old bucket that happens to be big enough. `baseline` is the newest STRICTLY EARLIER
 * bucket meeting the same floor, with no age limit: traffic here has multi-day gaps, so "yesterday"
 * is frequently absent or too small, and which bucket was used travels on the finding.
 *
 * When nothing qualifies, `current` still reports the newest bucket with traffic (so the persisted
 * verdict shows what was looked at) and `skipped` explains why no rule ran.
 */
export function selectToolBuckets(
  points: readonly ToolFailureRatePoint[],
  thresholds: AlertThresholds,
  bucketSize: 'day' | 'hour' = 'day',
): ToolBucketSelection {
  const skipped: AlertSkipReason[] = [];

  let newestWithTrafficIndex = -1;
  for (let i = points.length - 1; i >= 0; i -= 1) {
    if ((points[i]?.settled ?? 0) > 0) {
      newestWithTrafficIndex = i;
      break;
    }
  }

  if (newestWithTrafficIndex < 0) {
    return { current: null, baseline: null, skipped: ['no_traffic'] };
  }

  const maxLag = MAX_CURRENT_BUCKET_LAG[bucketSize];
  const oldestAllowedIndex = Math.max(0, points.length - 1 - maxLag);

  let currentIndex = -1;
  for (let i = points.length - 1; i >= oldestAllowedIndex; i -= 1) {
    const candidate = points[i];
    if (candidate && candidate.settled >= thresholds.toolFailureMinSettledCalls) {
      currentIndex = i;
      break;
    }
  }

  if (currentIndex < 0) {
    // Nothing recent enough is big enough to judge. Report what was seen; raise nothing.
    return {
      current: points[newestWithTrafficIndex]!,
      baseline: null,
      skipped: ['insufficient_sample'],
    };
  }

  const current = points[currentIndex]!;

  let baseline: ToolFailureRatePoint | null = null;
  for (let i = currentIndex - 1; i >= 0; i -= 1) {
    const candidate = points[i];
    if (candidate && candidate.settled >= thresholds.toolFailureMinSettledCalls) {
      baseline = candidate;
      break;
    }
  }
  if (!baseline) {
    skipped.push('no_baseline');
  }

  return { current, baseline, skipped };
}

function evaluateToolFailureRate(
  series: ToolFailureRateSeries,
  thresholds: AlertThresholds,
): { findings: AlertFinding[]; metrics: AlertMetricsSummary['toolFailure'] } {
  const findings: AlertFinding[] = [];
  const { current, baseline, skipped } = selectToolBuckets(
    series.points,
    thresholds,
    series.bucketSize,
  );
  const alertable =
    current !== null &&
    current.failureRate !== null &&
    current.settled >= thresholds.toolFailureMinSettledCalls;

  if (alertable) {
    const observed = current.failureRate!;
    const sharedContext = {
      bucketSize: series.bucketSize,
      failed: current.failed,
      settled: current.settled,
      ordinaryFailureRate: current.ordinaryFailureRate,
      ordinarySettled: current.ordinarySettled,
      speculativeSettled: current.speculativeSettled,
      seriesTruncated: series.truncated,
    };

    if (observed >= Math.min(thresholds.toolFailureRateWarning, thresholds.toolFailureRateCritical)) {
      const severity = severityForRate(observed, thresholds);
      findings.push({
        metric: 'tool_failure_rate',
        severity,
        window: current.bucket,
        observed,
        threshold:
          severity === 'critical'
            ? thresholds.toolFailureRateCritical
            : thresholds.toolFailureRateWarning,
        sampleSize: current.settled,
        message: `Tool-call failure rate is ${asPercent(observed)} (${current.failed} of ${current.settled} settled calls) in bucket ${current.bucket}.`,
        context: sharedContext,
      });
    }

    if (baseline && baseline.failureRate !== null) {
      const baselineRate = baseline.failureRate;
      const meetsDelta = observed >= baselineRate + thresholds.toolFailureSpikeDelta;
      const meetsRatio = observed >= baselineRate * thresholds.toolFailureSpikeRatio;
      if (meetsDelta && meetsRatio) {
        findings.push({
          metric: 'tool_failure_rate_spike',
          severity: severityForRate(observed, thresholds),
          window: `${baseline.bucket} → ${current.bucket}`,
          observed,
          threshold: baselineRate + thresholds.toolFailureSpikeDelta,
          sampleSize: current.settled,
          message: `Tool-call failure rate jumped from ${asPercent(baselineRate)} (${baseline.bucket}, ${baseline.settled} settled) to ${asPercent(observed)} (${current.bucket}, ${current.settled} settled).`,
          context: {
            ...sharedContext,
            baselineBucket: baseline.bucket,
            baselineRate,
            baselineSettled: baseline.settled,
            deltaThreshold: thresholds.toolFailureSpikeDelta,
            ratioThreshold: thresholds.toolFailureSpikeRatio,
          },
        });
      }
    }
  }

  return {
    findings,
    metrics: {
      bucketSize: series.bucketSize,
      windowFrom: series.windowFrom,
      windowTo: series.windowTo,
      bucketCount: series.points.length,
      scannedRows: series.scannedRows,
      truncated: series.truncated,
      current: current
        ? {
            bucket: current.bucket,
            settled: current.settled,
            failed: current.failed,
            failureRate: current.failureRate,
            ordinaryFailureRate: current.ordinaryFailureRate,
          }
        : null,
      baseline: baseline
        ? { bucket: baseline.bucket, settled: baseline.settled, failureRate: baseline.failureRate }
        : null,
      skipped,
    },
  };
}

function evaluateGoldenSet(
  trend: GoldenRunSeries,
  tierTargets: readonly TierTarget[],
  thresholds: AlertThresholds,
): { findings: AlertFinding[]; metrics: AlertMetricsSummary['goldenSet'] } {
  const findings: AlertFinding[] = [];
  const skipped: { testName: string; reason: AlertSkipReason }[] = [];
  let testsCompared = 0;

  if (trend.tests.length === 0) {
    return {
      findings,
      metrics: { testsEvaluated: 0, testsCompared: 0, skipped: [{ testName: '*', reason: 'no_golden_sets' }] },
    };
  }

  for (const test of trend.tests) {
    const current = test.points[0];
    if (!current || current.gradedCount < thresholds.goldenMinGradedItems) {
      skipped.push({ testName: test.testName, reason: 'insufficient_graded' });
      continue;
    }

    // Gate miss is judged on the CURRENT run alone — it needs no previous run, so it is checked
    // before the comparison below can `continue`.
    if (thresholds.goldenGateMissEnabled) {
      for (const target of tierTargets) {
        if (!target.isGate) {
          continue;
        }
        const tier = current.tiers.find((entry) => entry.tier === target.tier);
        if (!tier || tier.gradedCount < thresholds.goldenMinGradedItems || tier.passRate === null) {
          continue;
        }
        if (verdictForTier(target, tier.passRate) === 'blocked') {
          findings.push({
            metric: 'golden_set_gate_miss',
            severity: 'critical',
            window: current.createdAt,
            observed: tier.passRate,
            threshold: target.targetPassRate,
            sampleSize: tier.gradedCount,
            message: `Golden set "${test.testName}" tier ${target.tier} (${target.label}) is gating and passed ${asPercent(tier.passRate)} (${tier.passedCount}/${tier.gradedCount}) against a ${asPercent(target.targetPassRate)} target.`,
            context: {
              testId: test.testId,
              runId: current.runId,
              appVersion: current.appVersion,
              tier: target.tier,
              tierLabel: target.label,
            },
          });
        }
      }
    } else if (tierTargets.some((target) => target.isGate)) {
      skipped.push({ testName: test.testName, reason: 'gate_rule_disabled' });
    }

    const previous = test.points[1];
    if (
      !previous ||
      previous.gradedCount < thresholds.goldenMinGradedItems ||
      previous.passRate === null ||
      current.passRate === null
    ) {
      skipped.push({ testName: test.testName, reason: 'no_comparable_previous' });
      continue;
    }

    testsCompared += 1;
    const drop = previous.passRate - current.passRate;
    const criticalDrop = Math.max(
      thresholds.goldenPassRateDropCritical,
      thresholds.goldenPassRateDropWarning,
    );
    if (drop >= thresholds.goldenPassRateDropWarning) {
      findings.push({
        metric: 'golden_set_pass_rate_drop',
        severity: drop >= criticalDrop ? 'critical' : 'warning',
        window: `${previous.createdAt} → ${current.createdAt}`,
        observed: current.passRate,
        threshold: previous.passRate,
        sampleSize: current.gradedCount,
        message: `Golden set "${test.testName}" pass rate fell ${asPercent(drop)} — ${asPercent(previous.passRate)} (${previous.gradedCount} graded) to ${asPercent(current.passRate)} (${current.gradedCount} graded).`,
        context: {
          testId: test.testId,
          drop,
          currentRunId: current.runId,
          previousRunId: previous.runId,
          currentAppVersion: current.appVersion,
          previousAppVersion: previous.appVersion,
          tiers: current.tiers,
        },
      });
    }
  }

  return {
    findings,
    metrics: { testsEvaluated: trend.tests.length, testsCompared, skipped },
  };
}

/**
 * THE evaluation entry point: every finding this system can raise comes from here, and the
 * `metrics` half explains a zero-finding verdict rather than leaving it ambiguous.
 */
export function evaluateAlertRules(input: {
  toolSeries: ToolFailureRateSeries;
  goldenTrend: GoldenRunSeries;
  tierTargets: readonly TierTarget[];
  thresholds: AlertThresholds;
}): AlertEvaluation {
  const tool = evaluateToolFailureRate(input.toolSeries, input.thresholds);
  const golden = evaluateGoldenSet(input.goldenTrend, input.tierTargets, input.thresholds);

  return {
    // Critical first, then by metric name, so the highest-signal finding leads every message.
    findings: [...tool.findings, ...golden.findings].sort(
      (a, b) =>
        Number(b.severity === 'critical') - Number(a.severity === 'critical') ||
        a.metric.localeCompare(b.metric),
    ),
    metrics: { toolFailure: tool.metrics, goldenSet: golden.metrics },
  };
}
