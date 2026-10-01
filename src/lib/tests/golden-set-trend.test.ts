import { describe, expect, it } from 'vitest';

import {
  buildDailyTierSeries,
  computeTierTrendDeltas,
  filterGoldenRunsByVersion,
  type TierTrendPoint,
  type TrendResultItemRow,
} from './golden-set-trend';
import type { GoldenItemRow, GoldenRunRow } from './golden-set';

const run = (id: string, createdAt: string, testId = 't1'): GoldenRunRow => ({
  id,
  test_id: testId,
  app_version: '2.0.0',
  created_at: createdAt,
});

const item = (id: string, priority: number | null): Pick<GoldenItemRow, 'id' | 'priority'> => ({
  id,
  priority,
});

const row = (runId: string, itemId: string, passed: boolean): TrendResultItemRow => ({
  test_result_id: runId,
  test_item_id: itemId,
  passed,
});

describe('buildDailyTierSeries', () => {
  it('a day with no golden-set run is a gap, not a zero', () => {
    const runs = [
      run('r1', '2026-08-18T09:00:00Z'),
      // 2026-08-19: no run at all — must be absent from the series
      run('r2', '2026-08-20T09:00:00Z'),
    ];
    const items = [item('i1', 1)];
    const resultItems = [row('r1', 'i1', true), row('r2', 'i1', false)];

    const series = buildDailyTierSeries({ runs, items, resultItems });

    expect(series.map((point) => point.day)).toEqual(['2026-08-18', '2026-08-20']);
    expect(series.some((point) => point.day === '2026-08-19')).toBe(false);
    expect(series).toEqual([
      { tier: 1, day: '2026-08-18', passed: 1, total: 1 },
      { tier: 1, day: '2026-08-20', passed: 0, total: 1 },
    ]);
  });

  it('a single-run window yields one point per graded tier', () => {
    const runs = [run('r1', '2026-08-20T09:00:00Z')];
    const items = [item('i1', 1), item('i2', 2), item('i3', 2)];
    const resultItems = [
      row('r1', 'i1', true),
      row('r1', 'i2', true),
      row('r1', 'i3', false),
    ];

    const series = buildDailyTierSeries({ runs, items, resultItems });

    expect(series).toEqual([
      { tier: 1, day: '2026-08-20', passed: 1, total: 1 },
      { tier: 2, day: '2026-08-20', passed: 1, total: 2 },
    ]);
  });

  it('rows from runs outside the golden window and untiered items never move the line', () => {
    const runs = [run('r1', '2026-08-20T09:00:00Z')];
    const items = [item('i1', 1), item('i-untiered', null)];
    const resultItems = [
      row('r1', 'i1', true),
      row('r-not-golden', 'i1', false), // run not in the golden run set
      row('r1', 'i-untiered', false), // data-error item, belongs to no tier
    ];

    const series = buildDailyTierSeries({ runs, items, resultItems });

    expect(series).toEqual([{ tier: 1, day: '2026-08-20', passed: 1, total: 1 }]);
  });
});

describe('computeTierTrendDeltas', () => {
  const point = (
    tier: 1 | 2 | 3,
    day: string,
    passed: number,
    total: number,
  ): TierTrendPoint => ({ tier, day, passed, total });

  it('delta is absent (null), not zero, when the prior window has no run', () => {
    const current = [point(1, '2026-08-20', 1, 1)];
    const deltas = computeTierTrendDeltas(current, []);
    expect(deltas[1]).toBeNull();
    expect(deltas[2]).toBeNull();
    expect(deltas[3]).toBeNull();
  });

  it('computes points delta against an equal-length prior window', () => {
    const current = [point(1, '2026-08-20', 9, 10)]; // 90%
    const prior = [point(1, '2026-08-10', 8, 10)]; // 80%
    const deltas = computeTierTrendDeltas(current, prior);
    expect(deltas[1]).toBe(10);
    expect(deltas[2]).toBeNull(); // tier 2 graded in neither window
  });

  it('aggregates multiple days per window before differencing', () => {
    const current = [point(1, '2026-08-19', 5, 5), point(1, '2026-08-20', 5, 5)];
    const prior = [point(1, '2026-08-12', 5, 10)];
    // current: 10/10 = 100%, prior: 5/10 = 50% → +50 pts
    expect(computeTierTrendDeltas(current, prior)[1]).toBe(50);
  });

  it('delta is null when the CURRENT window has no run for the tier', () => {
    const prior = [point(1, '2026-08-10', 8, 10)];
    expect(computeTierTrendDeltas([], prior)[1]).toBeNull();
  });
});

describe('filterGoldenRunsByVersion (B0-580)', () => {
  const unversioned: GoldenRunRow = {
    id: 'r0',
    test_id: 't1',
    app_version: null,
    created_at: '2026-08-18T09:00:00Z',
  };
  const v2 = run('r1', '2026-08-19T09:00:00Z'); // app_version '2.0.0'
  const runs = [unversioned, v2];

  it('undefined keeps every run (any version)', () => {
    expect(filterGoldenRunsByVersion(runs, undefined)).toEqual(runs);
  });

  it('null selects only the unversioned bucket', () => {
    expect(filterGoldenRunsByVersion(runs, null)).toEqual([unversioned]);
  });

  it('a string selects the exact version only', () => {
    expect(filterGoldenRunsByVersion(runs, '2.0.0')).toEqual([v2]);
    expect(filterGoldenRunsByVersion(runs, '9.9.9')).toEqual([]);
  });
});
