import { describe, expect, it } from 'vitest';

import {
  CONFIDENCE_HIGH_MIN,
  CONFIDENCE_MID_MIN,
} from '~/lib/observability/aggregates';
import {
  buildConfidenceSpread,
  buildLiveTrafficTiles,
  NOT_MEASURED,
} from '~/lib/observability/live-traffic';
import type { AggregateDashboardData } from '~/types/observability';

function dashboardData(
  overrides: Partial<AggregateDashboardData> = {},
): AggregateDashboardData {
  return {
    windowFrom: '2026-08-14T00:00:00.000Z',
    windowTo: '2026-08-21T00:00:00.000Z',
    totalRuns: 100,
    completedRuns: 90,
    failedRuns: 10,
    avgConfidence: 0.8123,
    humanReviewCount: 3,
    orphanedRuns: 0,
    avgTtftMs: 1500,
    ttftSampleSize: 80,
    avgDurationMs: 9000,
    durationSampleSize: 95,
    tokenUsage: {
      avgTotalTokens: 4200,
      tokenSampleSize: 60,
      cachedPromptShare: 0.35,
      cachedShareSampleSize: 40,
    },
    routingDistribution: [],
    confidenceBuckets: [
      { bucket: 'high', count: 60 },
      { bucket: 'mid', count: 25 },
      { bucket: 'low', count: 5 },
      { bucket: 'none', count: 10 },
    ],
    latencyByStep: [],
    failureRateByDay: [],
    ...overrides,
  };
}

function tile(data: AggregateDashboardData, key: string) {
  const found = buildLiveTrafficTiles(data).find((entry) => entry.key === key);
  if (!found) {
    throw new Error(`missing tile: ${key}`);
  }
  return found;
}

describe('buildLiveTrafficTiles', () => {
  it('produces the six tiles in order', () => {
    expect(buildLiveTrafficTiles(dashboardData()).map((entry) => entry.key)).toEqual([
      'runs',
      'failed',
      'confidence',
      'latency',
      'tokens',
      'orphaned',
    ]);
  });

  it('renders failed as count + rate', () => {
    expect(tile(dashboardData(), 'failed').value).toBe('10 · 10.0%');
  });

  it('shows an em-dash, never 0, for unmeasured confidence, latency and tokens', () => {
    const empty = dashboardData({
      totalRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      avgConfidence: null,
      avgTtftMs: null,
      ttftSampleSize: 0,
      avgDurationMs: null,
      durationSampleSize: 0,
      tokenUsage: {
        avgTotalTokens: null,
        tokenSampleSize: 0,
        cachedPromptShare: null,
        cachedShareSampleSize: 0,
      },
    });

    expect(tile(empty, 'confidence').value).toBe(NOT_MEASURED);
    expect(tile(empty, 'latency').value).toBe(`${NOT_MEASURED} / ${NOT_MEASURED}`);
    expect(tile(empty, 'tokens').value).toBe(NOT_MEASURED);
    expect(tile(empty, 'tokens').hint).toContain(NOT_MEASURED);
  });

  it('states the cache-share sample size so excluded pre-B0-324 runs are visible', () => {
    const hint = tile(dashboardData(), 'tokens').hint;
    expect(hint).toContain('35.0% cached');
    expect(hint).toContain('40 cache-instrumented runs');
    expect(hint).toContain('of 60 with usage');
  });

  it('marks orphaned runs as a warning only when non-zero', () => {
    expect(tile(dashboardData(), 'orphaned').tone).toBe('default');
    expect(tile(dashboardData({ orphanedRuns: 2 }), 'orphaned').tone).toBe('warning');
  });
});

describe('buildConfidenceSpread', () => {
  it('derives labels from the exported thresholds, never restated literals', () => {
    const spread = buildConfidenceSpread(dashboardData().confidenceBuckets);

    expect(spread.map((segment) => segment.label)).toEqual([
      `High (≥ ${CONFIDENCE_HIGH_MIN * 100}%)`,
      `Mid (${CONFIDENCE_MID_MIN * 100}–<${CONFIDENCE_HIGH_MIN * 100}%)`,
      `Low (< ${CONFIDENCE_MID_MIN * 100}%)`,
      'None',
    ]);
  });

  it('computes each bucket share of all runs', () => {
    const spread = buildConfidenceSpread(dashboardData().confidenceBuckets);

    expect(spread.map((segment) => [segment.bucket, segment.count, segment.percent])).toEqual([
      ['high', 60, 60],
      ['mid', 25, 25],
      ['low', 5, 5],
      ['none', 10, 10],
    ]);
  });

  it('handles an empty window without dividing by zero', () => {
    const spread = buildConfidenceSpread([
      { bucket: 'high', count: 0 },
      { bucket: 'mid', count: 0 },
      { bucket: 'low', count: 0 },
      { bucket: 'none', count: 0 },
    ]);

    expect(spread.every((segment) => segment.percent === 0)).toBe(true);
  });
});
