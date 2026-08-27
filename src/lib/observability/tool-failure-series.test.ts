import { describe, expect, it } from 'vitest';

import {
  buildToolFailureRateSeries,
  type ToolOutcomeScanRow,
} from '~/lib/observability/tool-failure-series';

function ok(createdAt: string, speculative: string | null = null): ToolOutcomeScanRow {
  return { event_type: 'tool_succeeded', created_at: createdAt, speculative };
}

function failed(createdAt: string, speculative: string | null = null): ToolOutcomeScanRow {
  return { event_type: 'tool_failed', created_at: createdAt, speculative };
}

function repeat(count: number, make: (index: number) => ToolOutcomeScanRow): ToolOutcomeScanRow[] {
  return Array.from({ length: count }, (_, index) => make(index));
}

describe('buildToolFailureRateSeries', () => {
  const window = { from: '2026-05-20T00:00:00.000Z', to: '2026-05-23T23:59:59.000Z' };

  it('buckets by UTC day and computes the settled failure rate', () => {
    const series = buildToolFailureRateSeries({
      rows: [
        ...repeat(3, () => ok('2026-05-20T08:00:00.000Z')),
        failed('2026-05-20T09:00:00.000Z'),
        ...repeat(2, () => ok('2026-05-22T10:00:00.000Z')),
        ...repeat(6, () => failed('2026-05-22T11:00:00.000Z')),
      ],
      window,
      bucketSize: 'day',
    });

    expect(series.points.map((point) => point.bucket)).toEqual([
      '2026-05-20',
      '2026-05-21',
      '2026-05-22',
      '2026-05-23',
    ]);
    expect(series.points[0]).toMatchObject({ settled: 4, failed: 1, failureRate: 0.25 });
    expect(series.points[2]).toMatchObject({ settled: 8, failed: 6, failureRate: 0.75 });
    expect(series.scannedRows).toBe(12);
    expect(series.truncated).toBe(false);
  });

  it('seeds empty days with settled 0 and a NULL rate — a gap is never a real 0%', () => {
    const series = buildToolFailureRateSeries({
      rows: [ok('2026-05-20T08:00:00.000Z')],
      window,
      bucketSize: 'day',
    });

    const empty = series.points.find((point) => point.bucket === '2026-05-21');
    expect(empty).toMatchObject({ settled: 0, failed: 0, failureRate: null });
    // The contrast that matters: a day WITH traffic and no failures reports a real 0.
    expect(series.points[0]).toMatchObject({ settled: 1, failureRate: 0 });
  });

  it('never counts tool_called — only settled outcomes reach the denominator', () => {
    // `tool_called` is filtered at the query, so the fold is handed only outcome rows. This
    // asserts the shape that guarantee relies on: every row folded increments `settled`.
    const series = buildToolFailureRateSeries({
      rows: [ok('2026-05-20T08:00:00.000Z'), failed('2026-05-20T08:00:01.000Z')],
      window,
      bucketSize: 'day',
    });
    expect(series.points[0]!.settled).toBe(2);
  });

  it('splits speculative from ordinary calls without changing the settled rate', () => {
    const series = buildToolFailureRateSeries({
      rows: [
        ...repeat(6, () => ok('2026-05-22T10:00:00.000Z', 'true')),
        failed('2026-05-22T10:05:00.000Z', 'true'),
        ...repeat(2, () => ok('2026-05-22T10:10:00.000Z')),
        failed('2026-05-22T10:15:00.000Z'),
      ],
      window,
      bucketSize: 'day',
    });

    const day = series.points.find((point) => point.bucket === '2026-05-22')!;
    expect(day).toMatchObject({
      settled: 10,
      failed: 2,
      failureRate: 0.2,
      speculativeSettled: 7,
      speculativeFailed: 1,
      ordinarySettled: 3,
      ordinaryFailed: 1,
    });
    // The ordinary rate is the noisier one on the smaller denominator — exactly why the alert
    // rules read `failureRate` instead. 1/3 rounds to 4dp.
    expect(day.ordinaryFailureRate).toBe(0.3333);
  });

  it('buckets by hour when asked, keying YYYY-MM-DDTHH in UTC', () => {
    const series = buildToolFailureRateSeries({
      rows: [ok('2026-05-22T10:59:59.000Z'), failed('2026-05-22T11:00:00.000Z')],
      window: { from: '2026-05-22T10:00:00.000Z', to: '2026-05-22T11:30:00.000Z' },
      bucketSize: 'hour',
    });

    expect(series.points.map((point) => point.bucket)).toEqual([
      '2026-05-22T10',
      '2026-05-22T11',
    ]);
    expect(series.points[0]).toMatchObject({ bucketStart: '2026-05-22T10:00:00.000Z', failureRate: 0 });
    expect(series.points[1]).toMatchObject({ failureRate: 1 });
  });

  it('counts rows outside the seeded range rather than discarding evidence', () => {
    const series = buildToolFailureRateSeries({
      rows: [failed('2026-05-19T23:00:00.000Z')],
      window,
      bucketSize: 'day',
    });

    const stray = series.points.find((point) => point.bucket === '2026-05-19');
    expect(stray).toMatchObject({ settled: 1, failed: 1, failureRate: 1 });
  });

  it('drops rows with an unparseable timestamp instead of throwing', () => {
    const series = buildToolFailureRateSeries({
      rows: [{ event_type: 'tool_failed', created_at: 'not-a-date', speculative: null }],
      window,
      bucketSize: 'day',
    });

    expect(series.points.every((point) => point.settled === 0)).toBe(true);
    expect(series.scannedRows).toBe(1);
  });

  it('returns no points for an inverted window rather than looping', () => {
    const series = buildToolFailureRateSeries({
      rows: [],
      window: { from: '2026-05-23T00:00:00.000Z', to: '2026-05-20T00:00:00.000Z' },
      bucketSize: 'day',
    });
    expect(series.points).toEqual([]);
  });
});
