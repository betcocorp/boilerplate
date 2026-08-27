import type { ReportRunRow } from '~/lib/tests/repository';

/**
 * B0-689 — score-over-time series and run-over-run change for `/admin/tests/reports`.
 *
 * Pure folding of the cross-dataset index rows (`listAllReportRuns`, B0-687/B0-688) — no I/O,
 * so the arithmetic is unit-testable without a database.
 *
 * A run's comparison is always against the previous SCORED run OF THE SAME DATASET. Runs whose
 * report has no `score` yet (still `scoring`, `failed`, or `idle`) are dropped entirely: they are
 * neither a point on the line nor either side of a comparison, so a dataset that ran, failed to
 * grade, then ran again compares the two runs that actually produced a number. Treating an
 * ungraded run as 0 would draw a cliff that never happened.
 *
 * For the same reason a missing comparison is `null`, never 0 — the same rule
 * `~/lib/tests/golden-set-trend.ts` uses for its tier delta. A dataset's first scored run has no
 * prior number to compare against; that is "no comparison", not "no change", and the two must
 * render differently.
 *
 * `score` is passed through exactly as persisted (already one decimal, B0-609) and never
 * re-rounded; only the derived delta/percent are rounded here, to one decimal, so consumers can
 * render them directly.
 */

/** Real minus sign (U+2212) — renders as a proper minus next to `+` rather than a hyphen. */
const MINUS = '−';

function roundToTenth(value: number): number {
  return Math.round(value * 10) / 10;
}

/** `+9.2` / `−0.9` / `0.0` — one decimal, real minus sign, no sign on an exact zero. */
function formatSigned(value: number): string {
  const rounded = roundToTenth(value);
  if (rounded === 0) return '0.0'; // also catches -0, which would otherwise print a sign
  if (rounded < 0) return `${MINUS}${Math.abs(rounded).toFixed(1)}`;
  return `+${rounded.toFixed(1)}`;
}

export type ReportScoreChange = {
  runId: string;
  previousRunId: string;
  previousScore: number;
  /** current − previous, in score POINTS on the 0–100 scale. */
  deltaPoints: number;
  /** (current − previous) / previous × 100. `null` when `previousScore` is 0 — undefined, not infinite. */
  changePercent: number | null;
};

export type ReportTrendPoint = {
  runId: string;
  /** Epoch ms of the run's `startedAt` — the chart's numeric X value. */
  timestamp: number;
  startedAt: string;
  /** Exactly as persisted; never re-rounded. */
  score: number;
  grade: string | null;
  /** Change vs the previous SCORED run of the same dataset; `null` on a dataset's first scored run. */
  change: ReportScoreChange | null;
};

export type ReportTrendSeries = {
  testId: string;
  testName: string;
  /** Ascending by timestamp — oldest run first. Always at least one point. */
  points: ReportTrendPoint[];
  /** Score of the newest point. */
  latestScore: number;
  /** Change on the newest point; `null` when the dataset has only one scored run. */
  latestChange: ReportScoreChange | null;
};

export type ReportScoreTrend = {
  /** One entry per dataset with at least one scored report, ordered by `testName` A→Z (localeCompare). */
  series: ReportTrendSeries[];
  /**
   * Every scored run keyed by `runId` → its change vs the previous scored run of the same
   * dataset. Runs with no comparison are absent from the map.
   */
  changeByRunId: Map<string, ReportScoreChange>;
  /** How many input rows were excluded because their report has no score yet (still scoring / failed / idle). */
  unscoredRunCount: number;
  /** Total scored runs across all series. */
  scoredRunCount: number;
};

/** A scored row with its parsed timestamp and non-null score, before grouping. */
type ScoredRow = {
  row: ReportRunRow;
  timestamp: number;
  score: number;
};

/**
 * Folds the newest-first index rows into one ascending score series per dataset plus a
 * run-keyed lookup of each run's change vs the previous scored run of that dataset.
 *
 * Rows with no `score`, or with an unparseable `startedAt`, are excluded and counted in
 * `unscoredRunCount` rather than throwing — the index must still render when one report row is
 * malformed.
 */
export function buildReportScoreTrend(rows: readonly ReportRunRow[]): ReportScoreTrend {
  const rowsByTestId = new Map<string, ScoredRow[]>();
  let unscoredRunCount = 0;

  for (const row of rows) {
    const timestamp = Date.parse(row.startedAt);
    const score = row.score;
    if (score === null || !Number.isFinite(timestamp)) {
      unscoredRunCount += 1;
      continue;
    }
    const bucket = rowsByTestId.get(row.testId);
    if (bucket) bucket.push({ row, timestamp, score });
    else rowsByTestId.set(row.testId, [{ row, timestamp, score }]);
  }

  const changeByRunId = new Map<string, ReportScoreChange>();
  const series: ReportTrendSeries[] = [];
  let scoredRunCount = 0;

  for (const [testId, bucket] of rowsByTestId) {
    // Input arrives newest-first; the chart needs oldest-first. `runId` breaks timestamp ties so
    // the ordering (and therefore every comparison) is deterministic.
    bucket.sort((a, b) =>
      a.timestamp !== b.timestamp
        ? a.timestamp - b.timestamp
        : a.row.runId.localeCompare(b.row.runId),
    );

    const points: ReportTrendPoint[] = [];
    let previous: ReportTrendPoint | null = null;

    for (const { row, timestamp, score } of bucket) {
      let change: ReportScoreChange | null = null;
      if (previous) {
        const deltaPoints = roundToTenth(score - previous.score);
        change = {
          runId: row.runId,
          previousRunId: previous.runId,
          previousScore: previous.score,
          deltaPoints,
          changePercent:
            previous.score === 0
              ? null
              : roundToTenth(((score - previous.score) / previous.score) * 100),
        };
        changeByRunId.set(row.runId, change);
      }

      const point: ReportTrendPoint = {
        runId: row.runId,
        timestamp,
        startedAt: row.startedAt,
        score,
        grade: row.grade ?? null,
        change,
      };
      points.push(point);
      previous = point;
    }

    const latest = points[points.length - 1];
    scoredRunCount += points.length;
    series.push({
      testId,
      // Newest run's name, not the oldest: a dataset renamed between runs should read under the
      // name it has now.
      testName: bucket[bucket.length - 1].row.testName,
      points,
      latestScore: latest.score,
      latestChange: latest.change,
    });
  }

  series.sort((a, b) => a.testName.localeCompare(b.testName));

  return { series, changeByRunId, unscoredRunCount, scoredRunCount };
}

/** `+9.2%` / `−0.9%` / `0.0%`; `n/a` when `changePercent` is null. Uses a real minus sign (−, U+2212). */
export function formatChangePercent(change: ReportScoreChange): string {
  if (change.changePercent === null) return 'n/a';
  return `${formatSigned(change.changePercent)}%`;
}

/** `+6.3 pts` / `−0.6 pts` / `0.0 pts`. Uses a real minus sign. */
export function formatChangePoints(change: ReportScoreChange): string {
  return `${formatSigned(change.deltaPoints)} pts`;
}
