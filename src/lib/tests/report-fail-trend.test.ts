import { describe, expect, it } from 'vitest';

import {
  buildReportFailTrend,
  formatFailChange,
  type FailTrendRunRow,
} from '~/lib/tests/report-fail-trend';

/** A run row as `listTestSetFailTrendRuns` / `listAllReportRuns` return them (newest-first). */
const runRow = (
  overrides: Partial<FailTrendRunRow> &
    Pick<FailTrendRunRow, 'runId' | 'testId' | 'startedAt'>,
): FailTrendRunRow => ({
  testName: 'Dataset A',
  failCount: 0,
  ...overrides,
});

describe('buildReportFailTrend', () => {
  it('groups rows per dataset, sorts each series oldest-first, and orders series by name', () => {
    const trend = buildReportFailTrend([
      runRow({ runId: 'z2', testId: 'z', testName: 'Zeta set', startedAt: '2026-09-14T19:25:00Z', failCount: 11 }),
      runRow({ runId: 'a2', testId: 'a', testName: 'Alpha set', startedAt: '2026-09-14T18:21:00Z', failCount: 4 }),
      runRow({ runId: 'z1', testId: 'z', testName: 'Zeta set', startedAt: '2026-09-13T19:41:00Z', failCount: 2 }),
      runRow({ runId: 'a1', testId: 'a', testName: 'Alpha set', startedAt: '2026-09-13T19:41:00Z', failCount: 5 }),
    ]);

    expect(trend.series.map((s) => s.testName)).toEqual(['Alpha set', 'Zeta set']);
    expect(trend.series[0].points.map((p) => p.runId)).toEqual(['a1', 'a2']);
    expect(trend.series[1].points.map((p) => p.value)).toEqual([2, 11]);
    expect(trend.plottedRunCount).toBe(4);
    expect(trend.missingRunCount).toBe(0);
  });

  it('measures each run against the previous run of the SAME dataset', () => {
    const trend = buildReportFailTrend([
      runRow({ runId: 'r2', testId: 't', startedAt: '2026-09-14T19:25:00Z', failCount: 13 }),
      runRow({ runId: 'other', testId: 'other', testName: 'Other set', startedAt: '2026-09-14T19:00:00Z', failCount: 99 }),
      runRow({ runId: 'r1', testId: 't', startedAt: '2026-09-14T18:21:00Z', failCount: 0 }),
    ]);

    const series = trend.series.find((s) => s.testId === 't');
    expect(series?.latestValue).toBe(13);
    expect(series?.latestChange).toEqual({
      runId: 'r2',
      previousRunId: 'r1',
      previousValue: 0,
      delta: 13,
    });
    expect(trend.changeByRunId.get('r2')?.delta).toBe(13);
    // The first run of a dataset has nothing to compare against.
    expect(trend.changeByRunId.has('r1')).toBe(false);
  });

  it('drops runs with no recorded fail count rather than plotting them as zero', () => {
    const trend = buildReportFailTrend([
      runRow({ runId: 'r2', testId: 't', startedAt: '2026-09-14T19:25:00Z', failCount: 3 }),
      runRow({ runId: 'r1', testId: 't', startedAt: '2026-09-14T18:21:00Z', failCount: null }),
    ]);

    expect(trend.missingRunCount).toBe(1);
    expect(trend.plottedRunCount).toBe(1);
    expect(trend.series[0].points.map((p) => p.runId)).toEqual(['r2']);
    // Dropped on both sides: it is not the baseline for the surviving run either.
    expect(trend.series[0].latestChange).toBeNull();
  });

  it('drops runs whose startedAt is unparseable', () => {
    const trend = buildReportFailTrend([
      runRow({ runId: 'bad', testId: 't', startedAt: 'not-a-date', failCount: 7 }),
    ]);

    expect(trend.series).toEqual([]);
    expect(trend.missingRunCount).toBe(1);
  });

  it('returns an empty trend for no rows', () => {
    const trend = buildReportFailTrend([]);
    expect(trend.series).toEqual([]);
    expect(trend.plottedRunCount).toBe(0);
    expect(trend.missingRunCount).toBe(0);
  });
});

describe('formatFailChange', () => {
  it('signs an increase, uses a real minus for a decrease, and renders no sign for flat', () => {
    expect(formatFailChange({ runId: 'r', previousRunId: 'p', previousValue: 0, delta: 13 })).toBe('+13');
    expect(formatFailChange({ runId: 'r', previousRunId: 'p', previousValue: 13, delta: -13 })).toBe('−13');
    expect(formatFailChange({ runId: 'r', previousRunId: 'p', previousValue: 3, delta: 0 })).toBe('0');
  });
});
