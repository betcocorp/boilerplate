import { listGoldenTests } from './golden-set';
import { parseReportState } from './report/schemas';
import { COMPLETED_RUN_STATUSES } from './types';
import { assertSupabaseNoError as assertNoError } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * B0-749 — golden-set-only, day-bucketed REPORT SCORE trend for `/admin` (Mission Control).
 *
 * Do not confuse this with two existing, similar-looking trends:
 *  - `~/lib/tests/golden-set-trend.ts` is golden-scoped and day-bucketed like this module, but
 *    plots PASS RATE (`test_result_items.passed`), never the persisted report score.
 *  - `~/lib/tests/report-trend.ts` plots the persisted report score like this module, but is
 *    per-RUN (not day-bucketed) and spans ALL datasets (not golden-only) — it powers
 *    `/admin/tests/reports` and must be left untouched.
 *
 * Golden-set membership is exactly `tests.is_golden` (via `listGoldenTests`, the canonical
 * reader — no ad-hoc `tests`/`test_items` joins here). A completed run is
 * `test_results.status IN COMPLETED_RUN_STATUSES AND run_mode = 'full'`, matching
 * `listGoldenCandidateRuns`'s definition (`~/lib/tests/golden-set.ts`). The score is
 * `report_state.overall.avg` (`parseReportState`), never recomputed. Days with NO scored golden
 * run are explicit gaps (`score: null`), never zero — the same rule `golden-set-trend.ts` and
 * `TokensPerDayPanel` use. Each day's `changePct` is against the IMMEDIATELY PRECEDING calendar
 * day's aggregate score, `null` when that day has no score (never "the last day with data").
 *
 * Same reasoning as `golden-set-trend.ts` for folding in Node rather than a Postgres RPC: golden
 * sets are a small curated subset and the health page's window is short, so this is a handful of
 * scan pages at most. If that ever stops being true, follow the same escalation path documented
 * there rather than growing the page budget here.
 */

/** PostgREST caps a request at 1000 rows; sweep in pages of that size. */
const SCAN_PAGE_SIZE = 1000;
const MAX_SCAN_PAGES = 20;
const DAY_MS = 24 * 60 * 60 * 1000;

export type GoldenReportScoreRunRow = {
  id: string;
  test_id: string;
  app_version: string | null;
  created_at: string;
  report_state: unknown;
};

export type GoldenReportScoreDayPoint = {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  /**
   * Average of `report_state.overall.avg` across every golden dataset's runs that landed this
   * day, rounded to one decimal. `null` = a gap day (no scored golden run), never 0.
   */
  score: number | null;
  /**
   * `(score − previous day's score) / previous day's score × 100`, rounded to one decimal.
   * `null` when this day has no score, the immediately preceding calendar day has no score, or
   * the preceding day's score is 0 (undefined, not infinite) — never a comparison against an
   * older day that merely happens to have data.
   */
  changePct: number | null;
};

export type GoldenReportScoreTrend = {
  /** Chronological, one entry per day in the window — gaps are explicit `score: null`. */
  points: GoldenReportScoreDayPoint[];
  window: { from: string; to: string };
};

// ---------------------------------------------------------------------------
// Pure computation (unit-tested without a database)
// ---------------------------------------------------------------------------

function utcDayOf(isoTimestamp: string): string {
  return isoTimestamp.slice(0, 10);
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every UTC day from `fromDay` to `toDay` inclusive, as `YYYY-MM-DD`. */
export function enumerateGoldenReportScoreDays(fromDay: string, toDay: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${toDay}T00:00:00.000Z`);
  for (let t = Date.parse(`${fromDay}T00:00:00.000Z`); t <= end; t += DAY_MS) {
    days.push(utcDay(new Date(t)));
  }
  return days;
}

/**
 * Version narrowing matching `filterGoldenRunsByVersion` in `golden-set-trend.ts`: `undefined` =
 * any version, `null` = the unversioned bucket (`app_version IS NULL`), a string = exact match.
 */
export function filterGoldenReportRunsByVersion(
  runs: GoldenReportScoreRunRow[],
  version: string | null | undefined,
): GoldenReportScoreRunRow[] {
  if (version === undefined) return runs;
  if (version === null) return runs.filter((run) => run.app_version === null);
  return runs.filter((run) => run.app_version === version);
}

/**
 * Folds completed golden runs into one aggregate score per UTC calendar day (of the run's
 * `created_at`, matching `golden-set-trend.ts`'s bucketing), against every day in `days` so an
 * unscored day is an explicit gap rather than being absent from the output, and computes each
 * day's change vs the immediately preceding CALENDAR day — never "the previous day with data".
 */
export function buildGoldenReportScoreDailySeries(input: {
  runs: GoldenReportScoreRunRow[];
  /** Every day in the window, ascending, including days with no data. */
  days: string[];
}): GoldenReportScoreDayPoint[] {
  const scoresByDay = new Map<string, number[]>();
  for (const run of input.runs) {
    const state = parseReportState(run.report_state);
    const avg = state?.overall?.avg;
    if (typeof avg !== 'number') continue; // no score yet (still scoring/failed) or unparseable state
    const day = utcDayOf(run.created_at);
    const bucket = scoresByDay.get(day);
    if (bucket) bucket.push(avg);
    else scoresByDay.set(day, [avg]);
  }

  const averageByDay = new Map<string, number>();
  for (const [day, scores] of scoresByDay) {
    const sum = scores.reduce((total, score) => total + score, 0);
    averageByDay.set(day, Math.round((sum / scores.length) * 10) / 10);
  }

  const points: GoldenReportScoreDayPoint[] = [];
  // Tracks the PRECEDING day's score whether or not it had one — a gap day correctly makes the
  // following day's comparison `null` rather than reaching back to an older data point.
  let previousDayScore: number | null = null;
  for (const day of input.days) {
    const score = averageByDay.get(day) ?? null;
    const changePct =
      score !== null && previousDayScore !== null && previousDayScore !== 0
        ? Math.round(((score - previousDayScore) / previousDayScore) * 1000) / 10
        : null;
    points.push({ date: day, score, changePct });
    previousDayScore = score;
  }
  return points;
}

// ---------------------------------------------------------------------------
// Data access
// ---------------------------------------------------------------------------

/** Completed full-mode golden runs with a non-null `report_state`, window-filtered on `created_at`. */
async function listGoldenReportScoreRuns(
  testIds: string[],
  window: { from: string; to: string },
): Promise<GoldenReportScoreRunRow[]> {
  if (testIds.length === 0) return [];
  const supabase = getSupabaseServiceRoleClient();
  const all: GoldenReportScoreRunRow[] = [];
  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    const result = await supabase
      .from('test_results')
      .select('id, test_id, app_version, created_at, report_state')
      .in('test_id', testIds)
      .eq('run_mode', 'full')
      .in('status', [...COMPLETED_RUN_STATUSES])
      .not('report_state', 'is', null)
      .gte('created_at', window.from)
      .lte('created_at', window.to)
      .order('created_at', { ascending: true })
      .range(start, start + SCAN_PAGE_SIZE - 1);
    const rows = (assertNoError(result) ?? []) as GoldenReportScoreRunRow[];
    all.push(...rows);
    if (rows.length < SCAN_PAGE_SIZE) break;
  }
  return all;
}

/**
 * THE reader for the golden report-score-over-time panels (Mission Control and
 * `/admin/tests/reports`): one aggregate score per UTC day across every ACTIVE golden dataset's
 * (`listGoldenTests({ includeArchived: false })`) completed runs in the explicit inclusive window
 * (the page's `?from=`/`?to=` selection) plus day-over-day % change, narrowed to one version
 * bucket (`filterGoldenReportRunsByVersion` semantics; `undefined` = any version). Mirrors
 * `getGoldenSetTrendForWindow`'s shape so the health page composes both trends the same way.
 */
export async function getGoldenReportScoreTrendForWindow(options: {
  window: { from: string; to: string };
  version?: string | null;
}): Promise<GoldenReportScoreTrend> {
  const { window } = options;
  const days = enumerateGoldenReportScoreDays(utcDayOf(window.from), utcDayOf(window.to));

  const tests = await listGoldenTests({ includeArchived: false });
  const testIds = tests.map((test) => test.id);
  if (testIds.length === 0) {
    return {
      points: days.map((date) => ({ date, score: null, changePct: null })),
      window,
    };
  }

  const allRuns = await listGoldenReportScoreRuns(testIds, window);
  const runs = filterGoldenReportRunsByVersion(allRuns, options.version);

  return {
    points: buildGoldenReportScoreDailySeries({ runs, days }),
    window,
  };
}
