import { describe, expect, it } from 'vitest';

import { buildGoldenRunSeries } from '~/lib/tests/golden-set-run-series';
import type {
  GoldenItemRow,
  GoldenResultItemRow,
  GoldenRunRow,
  GoldenTestRow,
} from '~/lib/tests/golden-set';

const TESTS: GoldenTestRow[] = [{ id: 'test-1', name: 'Product Golden Test Set', row_count: 3 }];

const ITEMS: GoldenItemRow[] = [
  { id: 'item-1', test_id: 'test-1', row_index: 0, prompt: 'a', priority: 1 },
  { id: 'item-2', test_id: 'test-1', row_index: 1, prompt: 'b', priority: 1 },
  { id: 'item-3', test_id: 'test-1', row_index: 2, prompt: 'c', priority: 2 },
];

const RUNS: GoldenRunRow[] = [
  { id: 'run-old', test_id: 'test-1', app_version: '1.0.0', created_at: '2026-08-21T17:00:00.000Z' },
  { id: 'run-new', test_id: 'test-1', app_version: '1.1.0', created_at: '2026-08-26T19:00:00.000Z' },
];

function resultItem(runId: string, itemId: string, passed: boolean): GoldenResultItemRow {
  return { test_result_id: runId, test_item_id: itemId, passed, app_version: null };
}

describe('buildGoldenRunSeries', () => {
  it('orders a test’s runs newest first so points[0] is current', () => {
    const series = buildGoldenRunSeries({
      tests: TESTS,
      items: ITEMS,
      runs: RUNS,
      resultItems: [
        resultItem('run-old', 'item-1', true),
        resultItem('run-old', 'item-2', true),
        resultItem('run-old', 'item-3', true),
        resultItem('run-new', 'item-1', true),
        resultItem('run-new', 'item-2', false),
        resultItem('run-new', 'item-3', true),
      ],
    });

    const points = series.tests[0]!.points;
    expect(points.map((point) => point.runId)).toEqual(['run-new', 'run-old']);
    expect(points[0]).toMatchObject({ gradedCount: 3, passedCount: 2, passRate: 0.6667 });
    expect(points[1]).toMatchObject({ gradedCount: 3, passedCount: 3, passRate: 1 });
  });

  it('splits per tier, and reports a tier with no graded rows as null not 0%', () => {
    const series = buildGoldenRunSeries({
      tests: TESTS,
      items: ITEMS,
      runs: [RUNS[1]!],
      resultItems: [resultItem('run-new', 'item-1', true), resultItem('run-new', 'item-2', false)],
    });

    const tiers = series.tests[0]!.points[0]!.tiers;
    expect(tiers.find((tier) => tier.tier === 1)).toMatchObject({
      gradedCount: 2,
      passedCount: 1,
      passRate: 0.5,
    });
    expect(tiers.find((tier) => tier.tier === 2)).toMatchObject({ gradedCount: 0, passRate: null });
    expect(tiers.find((tier) => tier.tier === 3)).toMatchObject({ gradedCount: 0, passRate: null });
  });

  it('keeps NULL-priority rows out of every denominator and reports them (golden-set data rule)', () => {
    const series = buildGoldenRunSeries({
      tests: TESTS,
      items: [
        ...ITEMS,
        { id: 'item-bad', test_id: 'test-1', row_index: 3, prompt: 'd', priority: null },
      ],
      runs: [RUNS[1]!],
      resultItems: [
        resultItem('run-new', 'item-1', true),
        resultItem('run-new', 'item-bad', false),
      ],
    });

    const point = series.tests[0]!.points[0]!;
    expect(point).toMatchObject({ gradedCount: 1, passedCount: 1, passRate: 1 });
    expect(point.rowsOnMissingPriorityItems).toBe(1);
  });

  it('ignores result rows for an item that has since been deleted', () => {
    const series = buildGoldenRunSeries({
      tests: TESTS,
      items: ITEMS,
      runs: [RUNS[1]!],
      resultItems: [
        resultItem('run-new', 'item-1', true),
        resultItem('run-new', 'item-deleted', false),
      ],
    });
    expect(series.tests[0]!.points[0]).toMatchObject({ gradedCount: 1, passRate: 1 });
  });

  it('reports a golden test with no completed run instead of inventing a point', () => {
    const series = buildGoldenRunSeries({ tests: TESTS, items: ITEMS, runs: [], resultItems: [] });
    expect(series.tests).toEqual([]);
    expect(series.testsWithoutRuns).toEqual([
      { testId: 'test-1', testName: 'Product Golden Test Set' },
    ]);
  });

  it('caps points per test but never below two — a diff always has something to compare', () => {
    const manyRuns: GoldenRunRow[] = Array.from({ length: 9 }, (_, index) => ({
      id: `run-${index}`,
      test_id: 'test-1',
      app_version: null,
      created_at: `2026-08-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`,
    }));

    expect(
      buildGoldenRunSeries({
        tests: TESTS,
        items: ITEMS,
        runs: manyRuns,
        resultItems: [],
        maxRunsPerTest: 3,
      }).tests[0]!.points,
    ).toHaveLength(3);

    expect(
      buildGoldenRunSeries({
        tests: TESTS,
        items: ITEMS,
        runs: manyRuns,
        resultItems: [],
        maxRunsPerTest: 1,
      }).tests[0]!.points,
    ).toHaveLength(2);
  });
});
