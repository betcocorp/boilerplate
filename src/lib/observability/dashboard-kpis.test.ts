import { describe, expect, it } from 'vitest';

import type { RunScanRow } from '~/lib/observability/aggregates';
import { buildRunKpiSummary, deltaPoints } from '~/lib/observability/dashboard-kpis';

/** 3 UTC days → daily buckets. */
const DAY_WINDOW = { from: '2026-08-18T00:00:00.000Z', to: '2026-08-20T00:00:00.000Z' };
/** 1 UTC day, 4 hour-starts → hourly buckets. */
const HOUR_WINDOW = { from: '2026-08-20T00:00:00.000Z', to: '2026-08-20T03:00:00.000Z' };

function run(overrides: Partial<RunScanRow>): RunScanRow {
  return {
    id: 'run-1',
    status: 'completed',
    confidence: null,
    created_at: '2026-08-19T12:00:00.000Z',
    updated_at: '2026-08-19T12:00:10.000Z',
    routing_decision: 'product',
    ttft_ms: null,
    total_tokens: null,
    prompt_tokens: null,
    cached_prompt_tokens: null,
    ...overrides,
  };
}

describe('buildRunKpiSummary — elapsed', () => {
  it('measures elapsed over terminal runs only, never counting an in-flight run as fast', () => {
    const summary = buildRunKpiSummary(
      [
        run({
          id: 'run-1',
          status: 'completed',
          created_at: '2026-08-19T12:00:00.000Z',
          updated_at: '2026-08-19T12:00:10.000Z', // 10s
        }),
        run({
          id: 'run-2',
          status: 'failed',
          created_at: '2026-08-19T12:00:00.000Z',
          updated_at: '2026-08-19T12:00:02.000Z', // 2s
        }),
        // Still running: `updated_at` is the last progress write, not an end time. Including it
        // would report a 100ms "run" — it must be out of the sample entirely.
        run({
          id: 'run-3',
          status: 'running',
          created_at: '2026-08-19T12:00:00.000Z',
          updated_at: '2026-08-19T12:00:00.100Z',
        }),
      ],
      DAY_WINDOW,
    );

    expect(summary.avgElapsedMs).toBe(6000); // (10000 + 2000) / 2, the running row excluded
    // Nearest rank, no interpolation: p50 of [2000, 10000] is the lower middle value.
    expect(summary.p50ElapsedMs).toBe(2000);
    expect(summary.p95ElapsedMs).toBe(10000);
    expect(summary.elapsedSampleSize).toBe(2);
  });

  it('reports null elapsed (not zero) when no run in the window has finished', () => {
    const summary = buildRunKpiSummary([run({ status: 'running' })], DAY_WINDOW);

    expect(summary.avgElapsedMs).toBeNull();
    expect(summary.p50ElapsedMs).toBeNull();
    expect(summary.p95ElapsedMs).toBeNull();
    expect(summary.elapsedSampleSize).toBe(0);
  });

  it('drops an inverted span rather than counting a negative duration', () => {
    const summary = buildRunKpiSummary(
      [
        run({
          id: 'run-1',
          status: 'completed',
          created_at: '2026-08-19T12:00:05.000Z',
          updated_at: '2026-08-19T12:00:00.000Z',
        }),
      ],
      DAY_WINDOW,
    );

    expect(summary.elapsedSampleSize).toBe(0);
    expect(summary.avgElapsedMs).toBeNull();
    // The run still counts as a run and as completed — only its duration is unusable.
    expect(summary.totalRuns).toBe(1);
    expect(summary.completedRuns).toBe(1);
  });
});

describe('buildRunKpiSummary — runningRuns', () => {
  it('counts every running run, fresh AND long-stuck (this is in-flight, not the orphan count)', () => {
    const summary = buildRunKpiSummary(
      [
        // Seconds old — a genuinely in-flight run.
        run({ id: 'run-1', status: 'running', created_at: '2026-08-19T23:59:55.000Z' }),
        // Days old — past any staleness threshold, but still `running`, so still counted here.
        run({ id: 'run-2', status: 'running', created_at: '2026-08-18T01:00:00.000Z' }),
        run({ id: 'run-3', status: 'completed' }),
      ],
      DAY_WINDOW,
    );

    expect(summary.runningRuns).toBe(2);
    expect(summary.totalRuns).toBe(3);
    expect(summary.completedRuns).toBe(1);
    expect(summary.failedRuns).toBe(0);
  });
});

describe('buildRunKpiSummary — failureRate', () => {
  it('divides by terminal runs, so in-flight runs cannot dilute the rate', () => {
    const summary = buildRunKpiSummary(
      [
        run({ id: 'run-1', status: 'failed' }),
        run({ id: 'run-2', status: 'completed' }),
        // Eight in-flight runs. Against `totalRuns` this would read as 10%; the real rate is 50%.
        ...Array.from({ length: 8 }, (_, index) =>
          run({ id: `running-${index}`, status: 'running' }),
        ),
      ],
      DAY_WINDOW,
    );

    expect(summary.failureRate).toBe(0.5);
  });

  it('returns null, never 0, when the window holds no terminal runs', () => {
    const summary = buildRunKpiSummary(
      [run({ id: 'run-1', status: 'running' }), run({ id: 'run-2', status: 'running' })],
      DAY_WINDOW,
    );

    // "No data" is not the claim "0% of runs failed".
    expect(summary.failureRate).toBeNull();
  });

  it('reports a real 0 when runs finished and none failed', () => {
    const summary = buildRunKpiSummary([run({ status: 'completed' })], DAY_WINDOW);

    expect(summary.failureRate).toBe(0);
  });
});

describe('buildRunKpiSummary — buckets', () => {
  it('zero-fills every UTC day in the window so the sparkline has no phantom gaps', () => {
    const summary = buildRunKpiSummary(
      [
        run({ id: 'run-1', status: 'completed', created_at: '2026-08-18T04:00:00.000Z' }),
        run({ id: 'run-2', status: 'failed', created_at: '2026-08-20T23:59:59.000Z' }),
        run({ id: 'run-3', status: 'running', created_at: '2026-08-20T10:00:00.000Z' }),
      ],
      DAY_WINDOW,
    );

    expect(summary.granularity).toBe('day');
    expect(summary.buckets).toEqual([
      { bucket: '2026-08-18', total: 1, completed: 1, failed: 0, running: 0 },
      // Nothing ran on the 19th — present and visibly zero, not missing.
      { bucket: '2026-08-19', total: 0, completed: 0, failed: 0, running: 0 },
      { bucket: '2026-08-20', total: 2, completed: 0, failed: 1, running: 1 },
    ]);
  });

  it('buckets hourly on ISO hour starts and keeps the buckets in chronological order', () => {
    const summary = buildRunKpiSummary(
      [
        run({ id: 'run-1', status: 'completed', created_at: '2026-08-20T02:45:00.000Z' }),
        run({ id: 'run-2', status: 'completed', created_at: '2026-08-20T00:05:00.000Z' }),
      ],
      HOUR_WINDOW,
    );

    expect(summary.granularity).toBe('hour');
    expect(summary.buckets.map((bucket) => [bucket.bucket, bucket.total])).toEqual([
      ['2026-08-20T00:00:00.000Z', 1],
      ['2026-08-20T01:00:00.000Z', 0],
      ['2026-08-20T02:00:00.000Z', 1],
      ['2026-08-20T03:00:00.000Z', 0],
    ]);
  });

  it('bucket totals always add up to totalRuns', () => {
    const runs = [
      run({ id: 'run-1', status: 'completed', created_at: '2026-08-18T01:00:00.000Z' }),
      run({ id: 'run-2', status: 'failed', created_at: '2026-08-19T01:00:00.000Z' }),
      run({ id: 'run-3', status: 'running', created_at: '2026-08-20T01:00:00.000Z' }),
    ];
    const summary = buildRunKpiSummary(runs, DAY_WINDOW);

    const bucketTotal = summary.buckets.reduce((sum, bucket) => sum + bucket.total, 0);
    expect(bucketTotal).toBe(summary.totalRuns);
    expect(bucketTotal).toBe(3);
  });
});

describe('buildRunKpiSummary — granularity switch', () => {
  it('uses hourly buckets at the 2-UTC-day boundary and daily buckets beyond it', () => {
    // 22:00 on the 19th → 01:00 on the 20th spans exactly 2 UTC days.
    const twoDays = buildRunKpiSummary([], {
      from: '2026-08-19T22:00:00.000Z',
      to: '2026-08-20T01:00:00.000Z',
    });
    expect(twoDays.granularity).toBe('hour');
    expect(twoDays.buckets).toHaveLength(4); // 22:00, 23:00, 00:00, 01:00

    // One hour later on the far side pulls in a third UTC day.
    const threeDays = buildRunKpiSummary([], {
      from: '2026-08-19T22:00:00.000Z',
      to: '2026-08-21T01:00:00.000Z',
    });
    expect(threeDays.granularity).toBe('day');
    expect(threeDays.buckets.map((bucket) => bucket.bucket)).toEqual([
      '2026-08-19',
      '2026-08-20',
      '2026-08-21',
    ]);
  });
});

describe('buildRunKpiSummary — empty window', () => {
  it('reports zeros, null rates and a fully zero-filled bucket series for no runs at all', () => {
    const summary = buildRunKpiSummary([], DAY_WINDOW);

    expect(summary).toEqual({
      windowFrom: DAY_WINDOW.from,
      windowTo: DAY_WINDOW.to,
      totalRuns: 0,
      completedRuns: 0,
      failedRuns: 0,
      runningRuns: 0,
      failureRate: null,
      avgElapsedMs: null,
      p50ElapsedMs: null,
      p95ElapsedMs: null,
      elapsedSampleSize: 0,
      granularity: 'day',
      buckets: [
        { bucket: '2026-08-18', total: 0, completed: 0, failed: 0, running: 0 },
        { bucket: '2026-08-19', total: 0, completed: 0, failed: 0, running: 0 },
        { bucket: '2026-08-20', total: 0, completed: 0, failed: 0, running: 0 },
      ],
    });
  });
});

describe('deltaPoints', () => {
  it('returns the percentage-POINT difference between two rates', () => {
    expect(deltaPoints(0.12, 0.08)).toBe(4); // 12% vs 8% → +4 points, not +50%
    expect(deltaPoints(0.05, 0.2)).toBe(-15);
    expect(deltaPoints(0.1, 0.1)).toBe(0);
  });

  it('propagates null rather than inventing a comparison against missing data', () => {
    expect(deltaPoints(null, 0.1)).toBeNull();
    expect(deltaPoints(0.1, null)).toBeNull();
    expect(deltaPoints(null, null)).toBeNull();
  });

  it('treats a prior rate of 0 as a real measurement, not as missing', () => {
    expect(deltaPoints(0.03, 0)).toBe(3);
  });
});
