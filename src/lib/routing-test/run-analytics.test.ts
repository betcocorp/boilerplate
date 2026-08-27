import { describe, expect, it } from 'vitest';

import {
  buildRoutingTestAccuracyTrend,
  buildRoutingTestAggregate,
  buildRoutingTestRouterSummaries,
  formatRoutingTestPercent,
  routingTestRunAccuracy,
} from '~/lib/routing-test/run-analytics';
import type {
  RoutingTestRouterType,
  RoutingTestRunRecord,
} from '~/lib/routing-test/types';

function makeRun(
  overrides: Partial<RoutingTestRunRecord> & {
    id: string;
    router_type: RoutingTestRouterType;
    ran_at: string;
  },
): RoutingTestRunRecord {
  return {
    total_items: 10,
    passed_items: 5,
    degraded_items: 0,
    duration_ms: 1000,
    avg_item_duration_ms: 100,
    warning: null,
    model: null,
    created_at: overrides.ran_at,
    ...overrides,
  };
}

const RUNS: RoutingTestRunRecord[] = [
  // Deliberately newest-first, the order `listRoutingTestRuns()` returns.
  makeRun({
    id: 'r4',
    router_type: 'llm',
    ran_at: '2026-08-04T00:00:00Z',
    passed_items: 9,
    avg_item_duration_ms: 2000,
  }),
  makeRun({
    id: 'r3',
    router_type: 'semantic',
    ran_at: '2026-08-03T00:00:00Z',
    passed_items: 4,
    degraded_items: 2,
    avg_item_duration_ms: 1500,
  }),
  makeRun({
    id: 'r2',
    router_type: 'llm',
    ran_at: '2026-08-02T00:00:00Z',
    passed_items: 7,
    avg_item_duration_ms: 1000,
  }),
  makeRun({
    id: 'r1',
    router_type: 'keyword',
    ran_at: '2026-08-01T00:00:00Z',
    passed_items: 3,
    avg_item_duration_ms: 1,
  }),
];

describe('routingTestRunAccuracy', () => {
  it('derives the fraction from the persisted counts', () => {
    expect(routingTestRunAccuracy(RUNS[0]!)).toBeCloseTo(0.9);
  });

  it('returns 0 rather than dividing by zero on an empty run', () => {
    const empty = makeRun({
      id: 'empty',
      router_type: 'keyword',
      ran_at: '2026-08-01T00:00:00Z',
      total_items: 0,
      passed_items: 0,
    });
    expect(routingTestRunAccuracy(empty)).toBe(0);
  });
});

describe('buildRoutingTestRouterSummaries (B0-698)', () => {
  it('always returns all three router types in a stable order', () => {
    const summaries = buildRoutingTestRouterSummaries([]);
    expect(summaries.map((s) => s.routerType)).toEqual([
      'keyword',
      'semantic',
      'llm',
    ]);
    expect(summaries.every((s) => s.runCount === 0)).toBe(true);
  });

  it('keeps a router with no runs, with null accuracies rather than a fake zero', () => {
    const [, semantic] = buildRoutingTestRouterSummaries([RUNS[3]!]);
    expect(semantic).toMatchObject({
      routerType: 'semantic',
      runCount: 0,
      latestAccuracy: null,
      bestAccuracy: null,
      avgItemDurationMs: null,
    });
  });

  it('averages accuracy across a router s own runs only', () => {
    const summaries = buildRoutingTestRouterSummaries(RUNS);
    const llm = summaries.find((s) => s.routerType === 'llm')!;
    expect(llm.runCount).toBe(2);
    expect(llm.avgAccuracy).toBeCloseTo(0.8); // (0.9 + 0.7) / 2
    expect(llm.bestAccuracy).toBeCloseTo(0.9);
    expect(llm.avgItemDurationMs).toBe(1500);
  });

  it('takes latestAccuracy from the most recent run regardless of input order', () => {
    const shuffled = [RUNS[2]!, RUNS[0]!, RUNS[1]!, RUNS[3]!];
    const llm = buildRoutingTestRouterSummaries(shuffled).find(
      (s) => s.routerType === 'llm',
    )!;
    expect(llm.latestAccuracy).toBeCloseTo(0.9);
  });

  it('sums degraded items per router', () => {
    const semantic = buildRoutingTestRouterSummaries(RUNS).find(
      (s) => s.routerType === 'semantic',
    )!;
    expect(semantic.totalDegradedItems).toBe(2);
  });

  it('ignores runs that never recorded an avg item duration', () => {
    const withNull = [
      makeRun({
        id: 'n1',
        router_type: 'keyword',
        ran_at: '2026-08-01T00:00:00Z',
        avg_item_duration_ms: null,
      }),
      makeRun({
        id: 'n2',
        router_type: 'keyword',
        ran_at: '2026-08-02T00:00:00Z',
        avg_item_duration_ms: 40,
      }),
    ];
    const keyword = buildRoutingTestRouterSummaries(withNull)[0]!;
    expect(keyword.avgItemDurationMs).toBe(40);
  });
});

describe('buildRoutingTestAccuracyTrend (B0-698)', () => {
  it('orders points oldest first and labels them 1..n', () => {
    const trend = buildRoutingTestAccuracyTrend(RUNS);
    expect(trend.map((p) => p.runId)).toEqual(['r1', 'r2', 'r3', 'r4']);
    expect(trend.map((p) => p.label)).toEqual(['1', '2', '3', '4']);
  });

  it('sets only the running router s series, leaving the others null', () => {
    const [first, second] = buildRoutingTestAccuracyTrend(RUNS);
    expect(first).toMatchObject({ keyword: 30, semantic: null, llm: null });
    expect(second).toMatchObject({ keyword: null, semantic: null, llm: 70 });
  });

  it('returns an empty trend for no runs', () => {
    expect(buildRoutingTestAccuracyTrend([])).toEqual([]);
  });
});

describe('buildRoutingTestAggregate (B0-698)', () => {
  it('pools accuracy over every scored item rather than averaging run averages', () => {
    const aggregate = buildRoutingTestAggregate(
      RUNS,
      buildRoutingTestRouterSummaries(RUNS),
    );
    expect(aggregate.totalRuns).toBe(4);
    expect(aggregate.totalItems).toBe(40);
    expect(aggregate.totalPassedItems).toBe(23);
    expect(aggregate.overallAccuracy).toBeCloseTo(0.575);
    expect(aggregate.totalDegradedItems).toBe(2);
  });

  it('picks the highest average-accuracy router that actually has runs', () => {
    const aggregate = buildRoutingTestAggregate(
      RUNS,
      buildRoutingTestRouterSummaries(RUNS),
    );
    expect(aggregate.bestRouter?.routerType).toBe('llm');
  });

  it('reports no best router when nothing has run', () => {
    const aggregate = buildRoutingTestAggregate(
      [],
      buildRoutingTestRouterSummaries([]),
    );
    expect(aggregate.bestRouter).toBeNull();
    expect(aggregate.overallAccuracy).toBe(0);
  });
});

describe('formatRoutingTestPercent', () => {
  it('renders whole percents', () => {
    expect(formatRoutingTestPercent(0.456)).toBe('46%');
    expect(formatRoutingTestPercent(0)).toBe('0%');
    expect(formatRoutingTestPercent(1)).toBe('100%');
  });

  // Plain `Math.round`, same as the existing `formatRoutingTestRunScore` — so a binary-float
  // midpoint like 0.575 (57.499999999999996) rounds DOWN. Pinned so the two never diverge.
  it('rounds a float midpoint the same way the run-history score does', () => {
    expect(formatRoutingTestPercent(0.575)).toBe('57%');
  });
});
