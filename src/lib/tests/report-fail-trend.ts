import type { ReportRunRow } from '~/lib/tests/repository';

/**
 * B0-1015 — the fold needs only these five fields, so it is typed on the structural minimum
 * rather than on the whole `ReportRunRow`. `/admin/tests/reports` still passes full `ReportRunRow`s
 * (assignable as-is); `/admin/tests` passes the lean rows its own reader produces, without having
 * to fabricate the TTFT/elapsed/report-state fields that page never reads.
 */
export type FailTrendRunRow = Pick<
  ReportRunRow,
  'runId' | 'testId' | 'testName' | 'startedAt' | 'failCount'
>;

/**
 * Per-run fail-count trend for `/admin/tests/reports` and the card above "Test sets" on
 * `/admin/tests` (B0-1015) — same fold as `report-metric-trend.ts`
 * (one series per dataset, oldest→newest, run-over-run change against the previous run OF THE
 * SAME DATASET that recorded a fail count), but over a plain integer count rather than a
 * millisecond-valued metric, so values are never divided or scaled into seconds.
 *
 * `FailTrendRunRow.failCount` is `test_results.failed_items` — the same harness-computed count the
 * "Fails" column on `/admin/tests` shows for a test's latest run. A run that never recorded one
 * (`failCount === null`) is dropped from the series — neither a plotted point nor either side of
 * a comparison — same "no data, not zero" rule the score and metric trends use.
 */

const MINUS = '−';

export type ReportFailChange = {
  runId: string;
  previousRunId: string;
  previousValue: number;
  /** current − previous. */
  delta: number;
};

export type ReportFailPoint = {
  runId: string;
  /** Epoch ms of the run's `startedAt` — the chart's numeric X value. */
  timestamp: number;
  startedAt: string;
  value: number;
  change: ReportFailChange | null;
};

export type ReportFailSeries = {
  testId: string;
  testName: string;
  /** Ascending by timestamp — oldest run first. Always at least one point. */
  points: ReportFailPoint[];
  latestValue: number;
  latestChange: ReportFailChange | null;
};

export type ReportFailTrend = {
  /** One entry per dataset with at least one run recording a fail count, ordered by `testName` A→Z. */
  series: ReportFailSeries[];
  changeByRunId: Map<string, ReportFailChange>;
  /** How many input rows were excluded because they don't record a fail count. */
  missingRunCount: number;
  /** Total plotted runs across all series. */
  plottedRunCount: number;
};

type FailRow = { row: FailTrendRunRow; timestamp: number; value: number };

export function buildReportFailTrend(rows: readonly FailTrendRunRow[]): ReportFailTrend {
  const rowsByTestId = new Map<string, FailRow[]>();
  let missingRunCount = 0;

  for (const row of rows) {
    const timestamp = Date.parse(row.startedAt);
    const value = row.failCount;
    if (value === null || !Number.isFinite(timestamp)) {
      missingRunCount += 1;
      continue;
    }
    const bucket = rowsByTestId.get(row.testId);
    if (bucket) bucket.push({ row, timestamp, value });
    else rowsByTestId.set(row.testId, [{ row, timestamp, value }]);
  }

  const changeByRunId = new Map<string, ReportFailChange>();
  const series: ReportFailSeries[] = [];
  let plottedRunCount = 0;

  for (const [testId, bucket] of rowsByTestId) {
    bucket.sort((a, b) =>
      a.timestamp !== b.timestamp
        ? a.timestamp - b.timestamp
        : a.row.runId.localeCompare(b.row.runId),
    );

    const points: ReportFailPoint[] = [];
    let previous: ReportFailPoint | null = null;

    for (const { row, timestamp, value } of bucket) {
      let change: ReportFailChange | null = null;
      if (previous) {
        change = {
          runId: row.runId,
          previousRunId: previous.runId,
          previousValue: previous.value,
          delta: value - previous.value,
        };
        changeByRunId.set(row.runId, change);
      }

      const point: ReportFailPoint = {
        runId: row.runId,
        timestamp,
        startedAt: row.startedAt,
        value,
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
      latestValue: latest.value,
      latestChange: latest.change,
    });
  }

  series.sort((a, b) => a.testName.localeCompare(b.testName));

  return { series, changeByRunId, missingRunCount, plottedRunCount };
}

/** `+3` / `−2` / `0`. Uses a real minus sign (−, U+2212). */
export function formatFailChange(change: ReportFailChange): string {
  if (change.delta === 0) return '0';
  if (change.delta < 0) return `${MINUS}${Math.abs(change.delta)}`;
  return `+${change.delta}`;
}
