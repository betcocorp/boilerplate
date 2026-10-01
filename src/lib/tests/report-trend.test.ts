import { describe, expect, it } from 'vitest';

import {
  buildReportScoreTrend,
  formatChangePercent,
  formatChangePoints,
  type ReportScoreChange,
} from '~/lib/tests/report-trend';
import type { ReportRunRow } from '~/lib/tests/repository';

/** A reported run row as `listAllReportRuns` returns it (newest-first at the call site). */
const runRow = (
  overrides: Partial<ReportRunRow> & Pick<ReportRunRow, 'runId' | 'testId' | 'startedAt'>,
): ReportRunRow => ({
  testName: 'Dataset A',
  reportGeneratedAt: '2026-08-20T12:00:00Z',
  reportStatus: 'completed',
  score: 80,
  grade: 'B',
  triggeredBy: 'tbird@betco.com',
  ...overrides,
});

const change = (overrides: Partial<ReportScoreChange> = {}): ReportScoreChange => ({
  runId: 'r2',
  previousRunId: 'r1',
  previousScore: 80,
  deltaPoints: 0,
  changePercent: 0,
  ...overrides,
});

describe('buildReportScoreTrend', () => {
  it('groups rows per dataset, sorts each series oldest-first, and orders series by name', () => {
    // Deliberately newest-first and interleaved, as the index reader returns them.
    const trend = buildReportScoreTrend([
      runRow({ runId: 'z2', testId: 'z', testName: 'Zeta set', startedAt: '2026-08-22T09:00:00Z', score: 91 }),
      runRow({ runId: 'a3', testId: 'a', testName: 'Alpha set', startedAt: '2026-08-21T09:00:00Z', score: 77 }),
      runRow({ runId: 'z1', testId: 'z', testName: 'Zeta set', startedAt: '2026-08-19T09:00:00Z', score: 90 }),
      runRow({ runId: 'a2', testId: 'a', testName: 'Alpha set', startedAt: '2026-08-18T09:00:00Z', score: 75 }),
      runRow({ runId: 'a1', testId: 'a', testName: 'Alpha set', startedAt: '2026-08-17T09:00:00Z', score: 70 }),
    ]);

    expect(trend.series.map((series) => series.testName)).toEqual(['Alpha set', 'Zeta set']);
    expect(trend.series[0].points.map((point) => point.runId)).toEqual(['a1', 'a2', 'a3']);
    expect(trend.series[1].points.map((point) => point.runId)).toEqual(['z1', 'z2']);
    expect(trend.series[0].points.map((point) => point.timestamp)).toEqual([
      Date.parse('2026-08-17T09:00:00Z'),
      Date.parse('2026-08-18T09:00:00Z'),
      Date.parse('2026-08-21T09:00:00Z'),
    ]);
    expect(trend.series[0].latestScore).toBe(77);
    expect(trend.series[0].latestChange?.previousRunId).toBe('a2');
    expect(trend.scoredRunCount).toBe(5);
    expect(trend.unscoredRunCount).toBe(0);
  });

  it('breaks a timestamp tie by runId so the ordering is deterministic', () => {
    const sameMoment = '2026-08-20T09:00:00Z';
    const trend = buildReportScoreTrend([
      runRow({ runId: 'b', testId: 't1', startedAt: sameMoment, score: 60 }),
      runRow({ runId: 'a', testId: 't1', startedAt: sameMoment, score: 50 }),
    ]);

    expect(trend.series[0].points.map((point) => point.runId)).toEqual(['a', 'b']);
    expect(trend.series[0].latestChange?.previousRunId).toBe('a');
  });

  it('computes points and percent change on realistic scores', () => {
    const trend = buildReportScoreTrend([
      runRow({ runId: 'r2', testId: 't1', startedAt: '2026-08-20T09:00:00Z', score: 74.5 }),
      runRow({ runId: 'r1', testId: 't1', startedAt: '2026-08-19T09:00:00Z', score: 68.2 }),
    ]);

    expect(trend.changeByRunId.get('r2')).toEqual({
      runId: 'r2',
      previousRunId: 'r1',
      previousScore: 68.2,
      deltaPoints: 6.3,
      changePercent: 9.2,
    });
    // The score itself is passed through untouched.
    expect(trend.series[0].points.map((point) => point.score)).toEqual([68.2, 74.5]);
  });

  it('reports a decrease as negative points and percent', () => {
    const trend = buildReportScoreTrend([
      runRow({ runId: 'r2', testId: 't1', startedAt: '2026-08-20T09:00:00Z', score: 67.6 }),
      runRow({ runId: 'r1', testId: 't1', startedAt: '2026-08-19T09:00:00Z', score: 68.2 }),
    ]);

    const latest = trend.series[0].latestChange;
    expect(latest?.deltaPoints).toBe(-0.6);
    expect(latest?.changePercent).toBe(-0.9);
  });

  it('skips an unscored run between two scored runs and compares against the earlier SCORED run', () => {
    const trend = buildReportScoreTrend([
      runRow({ runId: 'r3', testId: 't1', startedAt: '2026-08-21T09:00:00Z', score: 90 }),
      // Still scoring — must be neither a point nor either side of a comparison.
      runRow({
        runId: 'r2',
        testId: 't1',
        startedAt: '2026-08-20T09:00:00Z',
        score: null,
        grade: null,
        reportStatus: 'scoring',
        reportGeneratedAt: null,
      }),
      runRow({ runId: 'r1', testId: 't1', startedAt: '2026-08-19T09:00:00Z', score: 80 }),
    ]);

    expect(trend.series[0].points.map((point) => point.runId)).toEqual(['r1', 'r3']);
    expect(trend.changeByRunId.has('r2')).toBe(false);
    expect(trend.changeByRunId.get('r3')).toEqual({
      runId: 'r3',
      previousRunId: 'r1',
      previousScore: 80,
      deltaPoints: 10,
      changePercent: 12.5,
    });
    expect(trend.unscoredRunCount).toBe(1);
    expect(trend.scoredRunCount).toBe(2);
  });

  it('counts a failed report and an unparseable startedAt as unscored, without throwing', () => {
    const trend = buildReportScoreTrend([
      runRow({
        runId: 'r2',
        testId: 't1',
        startedAt: 'not-a-timestamp',
        score: 95,
      }),
      runRow({
        runId: 'r1',
        testId: 't1',
        startedAt: '2026-08-19T09:00:00Z',
        score: null,
        grade: null,
        reportStatus: 'failed',
      }),
    ]);

    expect(trend.series).toEqual([]);
    expect(trend.unscoredRunCount).toBe(2);
    expect(trend.scoredRunCount).toBe(0);
  });

  it("a dataset's first scored run has no change and no changeByRunId entry", () => {
    const trend = buildReportScoreTrend([
      runRow({ runId: 'r1', testId: 't1', startedAt: '2026-08-19T09:00:00Z', score: 68.1 }),
    ]);

    expect(trend.series[0].points[0].change).toBeNull();
    expect(trend.series[0].latestChange).toBeNull();
    expect(trend.changeByRunId.has('r1')).toBe(false);
    expect(trend.changeByRunId.size).toBe(0);
  });

  it('yields a null changePercent but a real deltaPoints when the previous score is 0', () => {
    const trend = buildReportScoreTrend([
      runRow({ runId: 'r2', testId: 't1', startedAt: '2026-08-20T09:00:00Z', score: 42.5 }),
      runRow({ runId: 'r1', testId: 't1', startedAt: '2026-08-19T09:00:00Z', score: 0, grade: 'F' }),
    ]);

    const latest = trend.series[0].latestChange;
    expect(latest?.previousScore).toBe(0);
    expect(latest?.deltaPoints).toBe(42.5);
    expect(latest?.changePercent).toBeNull();
  });

  it('keeps two datasets that share a name but differ by testId as separate series', () => {
    const trend = buildReportScoreTrend([
      runRow({ runId: 'b1', testId: 't2', testName: 'Same Name', startedAt: '2026-08-20T09:00:00Z', score: 40 }),
      runRow({ runId: 'a1', testId: 't1', testName: 'Same Name', startedAt: '2026-08-19T09:00:00Z', score: 90 }),
    ]);

    expect(trend.series).toHaveLength(2);
    expect(trend.series.map((series) => series.testId).sort()).toEqual(['t1', 't2']);
    // Neither run compares against the other — each dataset's only run is its first.
    expect(trend.changeByRunId.size).toBe(0);
    expect(trend.series.every((series) => series.points.length === 1)).toBe(true);
  });

  it('returns an empty trend for empty input', () => {
    const trend = buildReportScoreTrend([]);

    expect(trend.series).toEqual([]);
    expect(trend.changeByRunId.size).toBe(0);
    expect(trend.unscoredRunCount).toBe(0);
    expect(trend.scoredRunCount).toBe(0);
  });
});

describe('formatChangePercent', () => {
  it('signs an increase and a decrease, and renders an exact zero unsigned', () => {
    expect(formatChangePercent(change({ changePercent: 9.2 }))).toBe('+9.2%');
    expect(formatChangePercent(change({ changePercent: -0.9 }))).toBe('−0.9%');
    expect(formatChangePercent(change({ changePercent: 0 }))).toBe('0.0%');
  });

  it('uses a real minus sign, not a hyphen', () => {
    expect(formatChangePercent(change({ changePercent: -12 }))).toBe('−12.0%');
    expect(formatChangePercent(change({ changePercent: -12 }))).not.toContain('-');
  });

  it('renders n/a when the percent is undefined (previous score of 0)', () => {
    expect(formatChangePercent(change({ changePercent: null }))).toBe('n/a');
  });
});

describe('formatChangePoints', () => {
  it('signs the delta and suffixes pts', () => {
    expect(formatChangePoints(change({ deltaPoints: 6.3 }))).toBe('+6.3 pts');
    expect(formatChangePoints(change({ deltaPoints: -0.6 }))).toBe('−0.6 pts');
    expect(formatChangePoints(change({ deltaPoints: 0 }))).toBe('0.0 pts');
  });

  it('still renders points when the percent is n/a', () => {
    const zeroBaseline = change({ previousScore: 0, deltaPoints: 42.5, changePercent: null });
    expect(formatChangePoints(zeroBaseline)).toBe('+42.5 pts');
    expect(formatChangePercent(zeroBaseline)).toBe('n/a');
  });
});
