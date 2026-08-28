/**
 * B0-749 — golden-set report-score trend panel for `/admin/bex/health` (epic B0-569).
 *
 * Async server component. One aggregate score per UTC day, across ALL golden datasets'
 * completed runs (`tests.is_golden = true`), from `~/lib/tests/golden-report-score-trend`. This
 * is DELIBERATELY separate from `/admin/tests/reports`'s `ReportScoreTrendChart` (per-run,
 * per-dataset, all datasets) — this panel is golden-only and day-bucketed, and must not be
 * confused with it or reused in its place.
 */

import { toGoldenSetVersionQuery, type HealthPanelProps } from '~/lib/bex-health/search-params';
import { getGoldenReportScoreTrendForWindow } from '~/lib/tests/golden-report-score-trend';

import { GoldenReportScoreTrendChart } from './GoldenReportScoreTrendChart';
import { ProvenanceFooter } from './ProvenanceFooter';

/** B0-749 — verified against `getGoldenReportScoreTrendForWindow`; keep in sync with it. */
const REPORT_SCORE_TREND_SOURCES = [
  'Score: test_results.report_state.overall.avg (persisted once report generation completes), scoped to golden-set membership (tests.is_golden) and each day\'s completed full-mode runs',
  'One point per UTC day of test_results.created_at, averaged across every golden dataset\'s runs that day; days with no scored golden run are empty slots, not zero',
  'Day-over-day % change is vs the immediately preceding calendar day\'s aggregate score',
];

export async function ReportScoreTrendPanel({ window, version }: HealthPanelProps) {
  const windowIso = { from: window.from.toISOString(), to: window.to.toISOString() };
  const versionQuery = toGoldenSetVersionQuery(version);

  let trend;
  try {
    trend = await getGoldenReportScoreTrendForWindow({
      window: windowIso,
      version: versionQuery.version,
    });
  } catch (error) {
    return (
      <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6">
        <p className="text-sm font-semibold text-destructive">Golden report score per day</p>
        <p className="mt-1 text-sm text-destructive">
          {error instanceof Error ? error.message : 'Unable to load the golden report score trend.'}
        </p>
      </section>
    );
  }

  const scoredDayCount = trend.points.filter((point) => point.score !== null).length;

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-950">
            Golden report score per day
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            One point per UTC day — the aggregate report score across all golden test sets,
            0-100.
          </p>
        </div>
      </div>

      <div className="mt-6">
        <GoldenReportScoreTrendChart points={trend.points} />
      </div>

      <p className="mt-3 text-xs text-slate-500">
        {scoredDayCount > 0
          ? `${scoredDayCount} of ${trend.points.length} day${trend.points.length === 1 ? '' : 's'} in this window have a scored golden report. Shaded slots have none — an empty day, not a zero score.`
          : 'No scored golden reports in this window — every day is an empty slot, not a zero score.'}
      </p>

      <ProvenanceFooter sources={REPORT_SCORE_TREND_SOURCES} />
    </section>
  );
}
