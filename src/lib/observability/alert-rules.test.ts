import { describe, expect, it } from 'vitest';

import {
  alertEvaluationSchema,
  DEFAULT_ALERT_THRESHOLDS,
  evaluateAlertRules,
  maxSeverity,
  selectToolBuckets,
  type AlertThresholds,
} from '~/lib/observability/alert-rules';
import type {
  ToolFailureRatePoint,
  ToolFailureRateSeries,
} from '~/lib/observability/tool-failure-series';
import type { GoldenRunSeries } from '~/lib/tests/golden-set-run-series';
import type { TierTarget } from '~/lib/tests/tier-targets';

/**
 * B0-466 — the two assertions the ticket actually asks for live in the first describe block:
 * the 2026-05-22 regression must trip the rules, and the noisiest ordinary recent day must not.
 * Every number below is REAL, queried live from `audit_logs` on 2026-08-27 (day buckets over the
 * settled `tool_succeeded` + `tool_failed` denominator).
 */

function point(
  bucket: string,
  settled: number,
  failed: number,
  overrides: Partial<ToolFailureRatePoint> = {},
): ToolFailureRatePoint {
  return {
    bucket,
    bucketStart: `${bucket}T00:00:00.000Z`,
    settled,
    failed,
    failureRate: settled > 0 ? Math.round((failed / settled) * 10_000) / 10_000 : null,
    ordinarySettled: settled,
    ordinaryFailed: failed,
    ordinaryFailureRate: settled > 0 ? Math.round((failed / settled) * 10_000) / 10_000 : null,
    speculativeSettled: 0,
    speculativeFailed: 0,
    ...overrides,
  };
}

function series(points: ToolFailureRatePoint[]): ToolFailureRateSeries {
  return {
    bucketSize: 'day',
    windowFrom: `${points[0]?.bucket ?? '2026-05-16'}T00:00:00.000Z`,
    windowTo: `${points.at(-1)?.bucket ?? '2026-05-23'}T23:59:59.000Z`,
    points,
    scannedRows: points.reduce((sum, entry) => sum + entry.settled, 0),
    truncated: false,
  };
}

const EMPTY_GOLDEN_TREND: GoldenRunSeries = {
  windowFrom: null,
  windowTo: null,
  tests: [],
  testsWithoutRuns: [],
};

const TIER_TARGETS: TierTarget[] = [
  { tier: 1, targetPassRate: 1, isGate: true, label: 'Critical' },
  { tier: 2, targetPassRate: 0.8, isGate: false, label: 'Core' },
  { tier: 3, targetPassRate: 0, isGate: false, label: 'Exploratory' },
];

function evaluate(points: ToolFailureRatePoint[], thresholds: AlertThresholds = DEFAULT_ALERT_THRESHOLDS) {
  return evaluateAlertRules({
    toolSeries: series(points),
    goldenTrend: EMPTY_GOLDEN_TREND,
    tierTargets: TIER_TARGETS,
    thresholds,
  });
}

describe('tool failure rate — the B0-446 regression vs. ordinary noise', () => {
  /**
   * Live day series around the incident (2026-08-27 query):
   *   2026-05-18  197 settled,   2 failed  (1.02%)
   *   2026-05-20  235 settled,   3 failed  (1.28%)
   *   2026-05-21   43 settled,   0 failed  (0.00%)  ← under the 50-call floor
   *   2026-05-22 1149 settled, 792 failed  (68.93%)
   * The cron runs part-way through 2026-05-23, so that day is a thin partial bucket.
   */
  const INCIDENT_POINTS = [
    point('2026-05-18', 197, 2),
    point('2026-05-19', 0, 0),
    point('2026-05-20', 235, 3),
    point('2026-05-21', 43, 0),
    point('2026-05-22', 1149, 792),
    point('2026-05-23', 12, 9),
  ];

  it('trips BOTH the absolute and the spike rule at critical severity on 2026-05-22', () => {
    const result = evaluate(INCIDENT_POINTS);

    expect(result.findings.map((finding) => finding.metric).sort()).toEqual([
      'tool_failure_rate',
      'tool_failure_rate_spike',
    ]);
    expect(maxSeverity(result.findings)).toBe('critical');
    expect(result.findings.every((finding) => finding.severity === 'critical')).toBe(true);

    const absolute = result.findings.find((finding) => finding.metric === 'tool_failure_rate')!;
    expect(absolute.observed).toBeCloseTo(0.6893, 4);
    expect(absolute.sampleSize).toBe(1149);
    expect(absolute.window).toBe('2026-05-22');
    expect(absolute.message).toContain('792 of 1149 settled calls');

    // The baseline skips 2026-05-21 (43 settled, under the floor) and the empty 05-19.
    const spike = result.findings.find((finding) => finding.metric === 'tool_failure_rate_spike')!;
    expect(spike.context.baselineBucket).toBe('2026-05-20');
    expect(spike.context.baselineRate).toBeCloseTo(0.0128, 4);
  });

  it('stays silent on the noisiest ordinary recent day (2026-08-26, 8.33% of 132)', () => {
    // Live tail of the healthy regime: 0.00%-1.32% per day, with one 8.33% blip.
    const result = evaluate([
      point('2026-08-21', 733, 9),
      point('2026-08-22', 0, 0),
      point('2026-08-23', 201, 0),
      point('2026-08-24', 228, 3),
      point('2026-08-25', 116, 1),
      point('2026-08-26', 132, 11),
    ]);

    expect(result.findings).toEqual([]);
    // …and the verdict still explains what it looked at.
    expect(result.metrics.toolFailure.current).toMatchObject({
      bucket: '2026-08-26',
      settled: 132,
      failureRate: 0.0833,
    });
    expect(result.metrics.toolFailure.baseline).toMatchObject({ bucket: '2026-08-25' });
  });

  it('stays silent across the whole healthy 2026-08-11 → 2026-08-21 stretch', () => {
    const healthy = [
      point('2026-08-11', 463, 6),
      point('2026-08-12', 112, 1),
      point('2026-08-13', 164, 1),
      point('2026-08-14', 414, 5),
      point('2026-08-17', 250, 0),
      point('2026-08-19', 230, 2),
      point('2026-08-20', 400, 4),
      point('2026-08-21', 733, 9),
    ];
    // Every day is judged in turn as if the cron had run the next morning.
    for (let end = 1; end < healthy.length; end += 1) {
      const result = evaluate(healthy.slice(0, end + 1));
      expect(result.findings, `day ${healthy[end]!.bucket}`).toEqual([]);
    }
  });
});

describe('selectToolBuckets', () => {
  it('falls back exactly one bucket when the newest is too thin (the cron mid-day case)', () => {
    const selection = selectToolBuckets(
      [point('2026-05-20', 235, 3), point('2026-05-22', 1149, 792), point('2026-05-23', 12, 9)],
      DEFAULT_ALERT_THRESHOLDS,
      'day',
    );
    expect(selection.current?.bucket).toBe('2026-05-22');
    expect(selection.baseline?.bucket).toBe('2026-05-20');
  });

  it('refuses to reach further back than the lag, so an old spike is never re-alerted', () => {
    const selection = selectToolBuckets(
      [point('2026-05-22', 1149, 792), point('2026-05-23', 4, 4), point('2026-05-24', 3, 3)],
      DEFAULT_ALERT_THRESHOLDS,
      'day',
    );
    expect(selection.current?.bucket).toBe('2026-05-24');
    expect(selection.skipped).toEqual(['insufficient_sample']);
  });

  it('reports no_traffic for an all-empty window', () => {
    const selection = selectToolBuckets(
      [point('2026-06-10', 0, 0), point('2026-06-11', 0, 0)],
      DEFAULT_ALERT_THRESHOLDS,
      'day',
    );
    expect(selection).toMatchObject({ current: null, baseline: null, skipped: ['no_traffic'] });
  });

  it('reports no_baseline when nothing earlier meets the floor', () => {
    const selection = selectToolBuckets(
      [point('2026-05-21', 43, 0), point('2026-05-22', 1149, 792)],
      DEFAULT_ALERT_THRESHOLDS,
      'day',
    );
    expect(selection.current?.bucket).toBe('2026-05-22');
    expect(selection.skipped).toEqual(['no_baseline']);
  });
});

describe('tool failure rate — rule mechanics', () => {
  it('never judges a bucket below the min-sample floor, however bad its rate', () => {
    // 2026-08-26 is 10-for-10 failures — 100% — but on 10 settled calls. The evaluation must fall
    // back to the last bucket big enough to mean something rather than alert on it.
    const result = evaluate([
      point('2026-08-24', 228, 3),
      point('2026-08-25', 116, 1),
      point('2026-08-26', 10, 10),
    ]);
    expect(result.findings).toEqual([]);
    expect(result.metrics.toolFailure.current?.bucket).toBe('2026-08-25');
  });

  it('raises nothing at all when every recent bucket is too small', () => {
    const result = evaluate([
      point('2026-08-24', 228, 3),
      point('2026-08-25', 8, 8),
      point('2026-08-26', 10, 10),
    ]);
    expect(result.findings).toEqual([]);
    expect(result.metrics.toolFailure.skipped).toEqual(['insufficient_sample']);
    expect(result.metrics.toolFailure.current?.bucket).toBe('2026-08-26');
  });

  it('cannot manufacture a spike off an empty (null-rate) baseline bucket', () => {
    const result = evaluate([
      point('2026-08-24', 0, 0),
      point('2026-08-25', 0, 0),
      point('2026-08-26', 200, 40), // 20%: absolute warning, but no baseline to spike from
    ]);
    expect(result.findings.map((finding) => finding.metric)).toEqual(['tool_failure_rate']);
    expect(result.findings[0]!.severity).toBe('warning');
    expect(result.metrics.toolFailure.skipped).toEqual(['no_baseline']);
  });

  it('requires BOTH the delta and the ratio for a spike', () => {
    // 12% over a 9% baseline: 1.3x, +3pp — neither test passes.
    expect(evaluate([point('2026-08-25', 200, 18), point('2026-08-26', 200, 24)]).findings).toEqual(
      [],
    );
    // 11% over a 0.5% baseline: 22x, but only +10.5pp… which does clear the 10pp delta.
    const both = evaluate([point('2026-08-25', 200, 1), point('2026-08-26', 200, 22)]);
    expect(both.findings.map((finding) => finding.metric)).toEqual(['tool_failure_rate_spike']);
    expect(both.findings[0]!.severity).toBe('warning');
  });

  it('escalates to critical only at the critical rate', () => {
    const warning = evaluate([point('2026-08-25', 200, 2), point('2026-08-26', 200, 40)]);
    expect(warning.findings.every((finding) => finding.severity === 'warning')).toBe(true);
    const critical = evaluate([point('2026-08-25', 200, 2), point('2026-08-26', 200, 70)]);
    expect(critical.findings.every((finding) => finding.severity === 'critical')).toBe(true);
  });

  it('reads the settled rate, not the speculative-excluded one', () => {
    // Ordinary rate 50% (well over the critical threshold), settled rate 5% — must stay silent.
    const result = evaluate([
      point('2026-08-25', 200, 2),
      point('2026-08-26', 200, 10, {
        ordinarySettled: 20,
        ordinaryFailed: 10,
        ordinaryFailureRate: 0.5,
        speculativeSettled: 180,
        speculativeFailed: 0,
      }),
    ]);
    expect(result.findings).toEqual([]);
    expect(result.metrics.toolFailure.current?.ordinaryFailureRate).toBe(0.5);
  });

  it('honours a lowered threshold — the QA "force an alert" path', () => {
    const forced = evaluate([point('2026-08-26', 5, 1)], {
      ...DEFAULT_ALERT_THRESHOLDS,
      toolFailureRateWarning: 0,
      toolFailureMinSettledCalls: 1,
    });
    expect(forced.findings.map((finding) => finding.metric)).toEqual(['tool_failure_rate']);
  });

  it('still fires when the two rate thresholds are stored inverted', () => {
    // A hand-edited `settings` pair with warning ABOVE critical: 35% is over the critical bar and
    // must not be silent just because it is under the (nonsensically higher) warning bar.
    const result = evaluate([point('2026-08-26', 200, 70)], {
      ...DEFAULT_ALERT_THRESHOLDS,
      toolFailureRateWarning: 0.9,
      toolFailureRateCritical: 0.3,
    });
    expect(result.findings.map((finding) => finding.metric)).toEqual(['tool_failure_rate']);
    expect(result.findings[0]!.severity).toBe('critical');
  });

  it('emits a schema-valid evaluation', () => {
    const result = evaluate([point('2026-05-20', 235, 3), point('2026-05-22', 1149, 792)]);
    expect(alertEvaluationSchema.safeParse(result).success).toBe(true);
  });
});

describe('golden-set rules', () => {
  function trend(points: Array<{ pass: number; graded: number; createdAt: string }>): GoldenRunSeries {
    return {
      windowFrom: null,
      windowTo: null,
      testsWithoutRuns: [],
      tests: [
        {
          testId: 'test-1',
          testName: 'Product Golden Test Set',
          points: points.map((entry, index) => ({
            runId: `run-${index}`,
            appVersion: '1.0.0',
            createdAt: entry.createdAt,
            gradedCount: entry.graded,
            passedCount: entry.pass,
            passRate: entry.graded > 0 ? entry.pass / entry.graded : null,
            tiers: [
              {
                tier: 1 as const,
                gradedCount: entry.graded,
                passedCount: entry.pass,
                passRate: entry.graded > 0 ? entry.pass / entry.graded : null,
              },
              { tier: 2 as const, gradedCount: 0, passedCount: 0, passRate: null },
              { tier: 3 as const, gradedCount: 0, passedCount: 0, passRate: null },
            ],
            rowsOnMissingPriorityItems: 0,
          })),
        },
      ],
    };
  }

  function evaluateGolden(goldenTrend: GoldenRunSeries, thresholds = DEFAULT_ALERT_THRESHOLDS) {
    return evaluateAlertRules({
      toolSeries: series([]),
      goldenTrend,
      tierTargets: TIER_TARGETS,
      thresholds,
    });
  }

  it('is silent when the latest run matches the previous one at 100%', () => {
    const result = evaluateGolden(
      trend([
        { pass: 20, graded: 20, createdAt: '2026-08-25T20:00:00.000Z' },
        { pass: 20, graded: 20, createdAt: '2026-08-21T17:00:00.000Z' },
      ]),
    );
    expect(result.findings).toEqual([]);
    expect(result.metrics.goldenSet).toMatchObject({ testsEvaluated: 1, testsCompared: 1 });
  });

  it('raises a critical drop and a gate miss when tier 1 regresses 100% → 70%', () => {
    const result = evaluateGolden(
      trend([
        { pass: 14, graded: 20, createdAt: '2026-08-26T20:00:00.000Z' },
        { pass: 20, graded: 20, createdAt: '2026-08-21T17:00:00.000Z' },
      ]),
    );

    expect(result.findings.map((finding) => finding.metric).sort()).toEqual([
      'golden_set_gate_miss',
      'golden_set_pass_rate_drop',
    ]);
    const drop = result.findings.find((f) => f.metric === 'golden_set_pass_rate_drop')!;
    expect(drop.severity).toBe('critical');
    expect(drop.observed).toBeCloseTo(0.7, 4);
    expect(drop.threshold).toBeCloseTo(1, 4);
  });

  it('raises only a warning for a 15% drop', () => {
    const result = evaluateGolden(
      trend([
        { pass: 17, graded: 20, createdAt: '2026-08-26T20:00:00.000Z' },
        { pass: 20, graded: 20, createdAt: '2026-08-21T17:00:00.000Z' },
      ]),
      { ...DEFAULT_ALERT_THRESHOLDS, goldenGateMissEnabled: false },
    );
    expect(result.findings.map((finding) => finding.metric)).toEqual([
      'golden_set_pass_rate_drop',
    ]);
    expect(result.findings[0]!.severity).toBe('warning');
  });

  it('skips a test whose latest run graded too few items', () => {
    const result = evaluateGolden(
      trend([
        { pass: 0, graded: 2, createdAt: '2026-08-26T20:00:00.000Z' },
        { pass: 20, graded: 20, createdAt: '2026-08-21T17:00:00.000Z' },
      ]),
    );
    expect(result.findings).toEqual([]);
    expect(result.metrics.goldenSet.skipped).toEqual([
      { testName: 'Product Golden Test Set', reason: 'insufficient_graded' },
    ]);
  });

  it('reports no_comparable_previous for a first-ever run rather than alerting', () => {
    const result = evaluateGolden(trend([{ pass: 20, graded: 20, createdAt: '2026-08-26T20:00:00.000Z' }]));
    expect(result.findings).toEqual([]);
    expect(result.metrics.goldenSet.skipped).toEqual([
      { testName: 'Product Golden Test Set', reason: 'no_comparable_previous' },
    ]);
  });

  it('never blocks on a non-gating tier, even far below target', () => {
    const goldenTrend = trend([{ pass: 20, graded: 20, createdAt: '2026-08-26T20:00:00.000Z' }]);
    goldenTrend.tests[0]!.points[0]!.tiers = [
      { tier: 1, gradedCount: 0, passedCount: 0, passRate: null },
      { tier: 2, gradedCount: 20, passedCount: 2, passRate: 0.1 },
      { tier: 3, gradedCount: 0, passedCount: 0, passRate: null },
    ];
    expect(evaluateGolden(goldenTrend).findings).toEqual([]);
  });

  it('reports no_golden_sets when there is nothing to evaluate', () => {
    const result = evaluateGolden(EMPTY_GOLDEN_TREND);
    expect(result.metrics.goldenSet.skipped).toEqual([{ testName: '*', reason: 'no_golden_sets' }]);
  });
});
