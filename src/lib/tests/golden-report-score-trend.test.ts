import { describe, expect, it } from 'vitest';

import {
  buildGoldenReportScoreDailySeries,
  enumerateGoldenReportScoreDays,
  filterGoldenReportRunsByVersion,
  type GoldenReportScoreRunRow,
} from './golden-report-score-trend';
import { emptyReportState, type ReportState } from './report/schemas';

function stateWithScore(avg: number | null): ReportState {
  return {
    ...emptyReportState('gpt-4.1', 1),
    status: 'completed',
    overall: avg === null ? null : { avg, grade: 'B' },
  };
}

const run = (
  id: string,
  createdAt: string,
  avg: number | null,
  testId = 't1',
  appVersion: string | null = '2.0.0',
): GoldenReportScoreRunRow => ({
  id,
  test_id: testId,
  app_version: appVersion,
  created_at: createdAt,
  report_state: stateWithScore(avg),
});

describe('enumerateGoldenReportScoreDays', () => {
  it('enumerates every UTC day inclusive of both ends', () => {
    expect(enumerateGoldenReportScoreDays('2026-08-18', '2026-08-20')).toEqual([
      '2026-08-18',
      '2026-08-19',
      '2026-08-20',
    ]);
  });

  it('a single-day window yields one day', () => {
    expect(enumerateGoldenReportScoreDays('2026-08-18', '2026-08-18')).toEqual(['2026-08-18']);
  });
});

describe('buildGoldenReportScoreDailySeries', () => {
  it('a day with no scored golden run is a gap, not zero', () => {
    const days = enumerateGoldenReportScoreDays('2026-08-18', '2026-08-20');
    const runs = [run('r1', '2026-08-18T09:00:00Z', 80), run('r2', '2026-08-20T09:00:00Z', 90)];

    const points = buildGoldenReportScoreDailySeries({ runs, days });

    expect(points).toEqual([
      { date: '2026-08-18', score: 80, changePct: null },
      { date: '2026-08-19', score: null, changePct: null },
      // Compared against the immediately preceding CALENDAR day (08-19, a gap) — not against
      // 08-18's score — so this must be null even though 08-18 has a real score.
      { date: '2026-08-20', score: 90, changePct: null },
    ]);
  });

  it('averages multiple golden datasets landing on the same day', () => {
    const days = enumerateGoldenReportScoreDays('2026-08-18', '2026-08-18');
    const runs = [
      run('r1', '2026-08-18T01:00:00Z', 80, 't1'),
      run('r2', '2026-08-18T09:00:00Z', 90, 't2'),
    ];

    const points = buildGoldenReportScoreDailySeries({ runs, days });

    expect(points).toEqual([{ date: '2026-08-18', score: 85, changePct: null }]);
  });

  it('computes day-over-day % change against the immediately preceding day', () => {
    const days = enumerateGoldenReportScoreDays('2026-08-18', '2026-08-19');
    const runs = [run('r1', '2026-08-18T09:00:00Z', 80), run('r2', '2026-08-19T09:00:00Z', 88)];

    const points = buildGoldenReportScoreDailySeries({ runs, days });

    expect(points[0]).toEqual({ date: '2026-08-18', score: 80, changePct: null });
    expect(points[1]).toEqual({ date: '2026-08-19', score: 88, changePct: 10 });
  });

  it('changePct is null when the preceding day\'s score is 0 (undefined, not infinite)', () => {
    const days = enumerateGoldenReportScoreDays('2026-08-18', '2026-08-19');
    const runs = [run('r1', '2026-08-18T09:00:00Z', 0), run('r2', '2026-08-19T09:00:00Z', 50)];

    const points = buildGoldenReportScoreDailySeries({ runs, days });

    expect(points[1]).toEqual({ date: '2026-08-19', score: 50, changePct: null });
  });

  it('drops runs whose report has no score yet, without treating them as zero', () => {
    const days = enumerateGoldenReportScoreDays('2026-08-18', '2026-08-18');
    const runs = [run('r1', '2026-08-18T09:00:00Z', null)];

    const points = buildGoldenReportScoreDailySeries({ runs, days });

    expect(points).toEqual([{ date: '2026-08-18', score: null, changePct: null }]);
  });
});

describe('filterGoldenReportRunsByVersion', () => {
  const unversioned = run('r0', '2026-08-18T09:00:00Z', 80, 't1', null);
  const v2 = run('r1', '2026-08-19T09:00:00Z', 90, 't1', '2.0.0');
  const runs = [unversioned, v2];

  it('undefined keeps every run (any version)', () => {
    expect(filterGoldenReportRunsByVersion(runs, undefined)).toEqual(runs);
  });

  it('null selects only the unversioned bucket', () => {
    expect(filterGoldenReportRunsByVersion(runs, null)).toEqual([unversioned]);
  });

  it('a string selects the exact version only', () => {
    expect(filterGoldenReportRunsByVersion(runs, '2.0.0')).toEqual([v2]);
    expect(filterGoldenReportRunsByVersion(runs, '9.9.9')).toEqual([]);
  });
});
