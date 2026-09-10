import type { ReportRunRow } from '~/lib/tests/repository';

/**
 * Per-run TTFT/elapsed trend for `/admin/tests/reports` — same shape and folding rules as
 * `~/lib/tests/report-trend.ts`'s score trend (one series per dataset, oldest→newest, run-over-run
 * change against the previous run OF THE SAME DATASET that actually has the metric), generalized
 * to any millisecond-valued field on `ReportRunRow` so it can plot `averageTtftMs` or
 * `averageElapsedMs` without duplicating the fold. `report-trend.ts` itself is left untouched.
 *
 * A run missing the metric (no items recorded it) is dropped from that metric's series — neither
 * a plotted point nor either side of a comparison — the same "no data, not zero" rule the score
 * trend uses for an unscored run.
 */

const MINUS = '−';

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

function formatSigned(value: number, unit: string): string {
  const rounded = roundToTenth(value);
  if (rounded === 0) return `0.0${unit}`;
  if (rounded < 0) return `${MINUS}${Math.abs(rounded).toFixed(1)}${unit}`;
  return `+${rounded.toFixed(1)}${unit}`;
}

export type ReportMetricKey = 'averageTtftMs' | 'averageElapsedMs';

export type ReportMetricChange = {
  runId: string;
  previousRunId: string;
  previousValueMs: number;
  /** current − previous, in ms. */
  deltaMs: number;
  /** (current − previous) / previous × 100. `null` when `previousValueMs` is 0. */
  changePercent: number | null;
};

export type ReportMetricPoint = {
  runId: string;
  /** Epoch ms of the run's `startedAt` — the chart's numeric X value. */
  timestamp: number;
  startedAt: string;
  valueMs: number;
  change: ReportMetricChange | null;
};

export type ReportMetricSeries = {
  testId: string;
  testName: string;
  /** Ascending by timestamp — oldest run first. Always at least one point. */
  points: ReportMetricPoint[];
  latestValueMs: number;
  latestChange: ReportMetricChange | null;
};

export type ReportMetricTrend = {
  /** One entry per dataset with at least one run recording this metric, ordered by `testName` A→Z. */
  series: ReportMetricSeries[];
  changeByRunId: Map<string, ReportMetricChange>;
  /** How many input rows were excluded because they don't record this metric. */
  missingRunCount: number;
  /** Total plotted runs across all series. */
  plottedRunCount: number;
};

type MetricRow = { row: ReportRunRow; timestamp: number; valueMs: number };

export function buildReportMetricTrend(
  rows: readonly ReportRunRow[],
  metric: ReportMetricKey,
): ReportMetricTrend {
  const rowsByTestId = new Map<string, MetricRow[]>();
  let missingRunCount = 0;

  for (const row of rows) {
    const timestamp = Date.parse(row.startedAt);
    const valueMs = row[metric];
    if (valueMs === null || !Number.isFinite(timestamp)) {
      missingRunCount += 1;
      continue;
    }
    const bucket = rowsByTestId.get(row.testId);
    if (bucket) bucket.push({ row, timestamp, valueMs });
    else rowsByTestId.set(row.testId, [{ row, timestamp, valueMs }]);
  }

  const changeByRunId = new Map<string, ReportMetricChange>();
  const series: ReportMetricSeries[] = [];
  let plottedRunCount = 0;

  for (const [testId, bucket] of rowsByTestId) {
    bucket.sort((a, b) =>
      a.timestamp !== b.timestamp
        ? a.timestamp - b.timestamp
        : a.row.runId.localeCompare(b.row.runId),
    );

    const points: ReportMetricPoint[] = [];
    let previous: ReportMetricPoint | null = null;

    for (const { row, timestamp, valueMs } of bucket) {
      let change: ReportMetricChange | null = null;
      if (previous) {
        const deltaMs = Math.round(valueMs - previous.valueMs);
        change = {
          runId: row.runId,
          previousRunId: previous.runId,
          previousValueMs: previous.valueMs,
          deltaMs,
          changePercent:
            previous.valueMs === 0
              ? null
              : roundToTenth(((valueMs - previous.valueMs) / previous.valueMs) * 100),
        };
        changeByRunId.set(row.runId, change);
      }

      const point: ReportMetricPoint = {
        runId: row.runId,
        timestamp,
        startedAt: row.startedAt,
        valueMs,
        change,
      };
      points.push(point);
      previous = point;
    }

    const latest = points[points.length - 1];
    plottedRunCount += points.length;
    series.push({
      testId,
      testName: bucket[bucket.length - 1].row.testName,
      points,
      latestValueMs: latest.valueMs,
      latestChange: latest.change,
    });
  }

  series.sort((a, b) => a.testName.localeCompare(b.testName));

  return { series, changeByRunId, missingRunCount, plottedRunCount };
}

/** `+0.4s` / `−0.1s` / `0.0s`. Uses a real minus sign (−, U+2212). */
export function formatMetricChangeSeconds(change: ReportMetricChange): string {
  return formatSigned(change.deltaMs / 1000, 's');
}

/** `+9.2%` / `−0.9%` / `0.0%`; `n/a` when `changePercent` is null. */
export function formatMetricChangePercent(change: ReportMetricChange): string {
  if (change.changePercent === null) return 'n/a';
  return formatSigned(change.changePercent, '%');
}
