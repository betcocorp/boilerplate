/**
 * B0-629 — the Mission Control KPI row: four cards over the selected window (runs, failure rate,
 * p95 elapsed, spend).
 *
 * Async server component; presentation only. Every figure comes from an existing reader —
 * `getRunKpiSummary` (which is itself composed from `~/lib/observability/aggregates`),
 * `getAggregateDashboardData` for TTFT, and the `cost_by_model_per_day` view via
 * `fetchDailyCostPoints` — so the row reconciles with /admin/observability and /admin/cost for the
 * same window by construction.
 *
 * Three things this file is deliberately careful about, because each is a way a card could lie:
 *
 *  1. The failure-rate delta is measured, not assumed: the preceding EQUAL-LENGTH window is
 *     fetched as a second scan (the technique `TokensPerDayPanel` uses), and `deltaPoints`
 *     returns null — rendered as an em dash — when either side has no terminal runs.
 *  2. The p95 card carries NO sparkline. `RunKpiSummary.buckets` counts runs per bucket; there is
 *     no per-bucket latency series anywhere in the reader, so drawing a line there would be a
 *     picture of run volume mislabelled as latency. The sample size is shown as text instead.
 *  3. The spend card is labelled "· window", not "· 24h": `cost_by_model_per_day` is EST-day
 *     grained and cannot express a rolling 24 hours. Its sparkline IS real — one point per EST
 *     day of `estimatedCostUsd`, which is exactly what the view stores.
 */

import type { ReactNode } from 'react';

import {
  getAggregateDashboardData,
  type AggregateWindow,
} from '~/lib/observability/aggregates';
import {
  fetchCostCoveredRunCount,
  fetchDailyCostPoints,
} from '~/lib/observability/cost-metrics';
import { deltaPoints, getRunKpiSummary } from '~/lib/observability/dashboard-kpis';
import { utcDay, type HealthPanelProps } from '~/lib/bex-health/search-params';

import {
  formatCount,
  formatDeltaPoints,
  formatMs,
  formatRatePercent,
  formatUsd,
  formatUsdPerRun,
} from './format';

/**
 * Verified against `getRunKpiSummary`, `getAggregateDashboardData`, `fetchDailyCostPoints` and
 * `fetchCostCoveredRunCount`; keep in sync with them. Rendered by the page's consolidated
 * provenance footer, not by this component.
 */
export const KPI_ROW_SOURCES = [
  'Runs, failure rate & elapsed percentiles: workflow_runs (status, created_at, updated_at) via scanWorkflowRuns — failure rate’s denominator is TERMINAL runs (completed + failed), and elapsed excludes in-flight runs rather than counting them as fast',
  'Failure-rate delta: a second scan of the preceding equal-length window; absent (never zero) when that window has no terminal runs',
  'TTFT: workflow_runs.final_output plus the harness first-token index, via getAggregateDashboardData',
  'Spend: cost_by_model_per_day view (EST-day grained, so it cannot express a rolling 24h) — steps with no output->>\'model\' are NOT in the view, so window spend is understated rather than zero-filled; per-run divides by the cost_covered_run_count RPC',
];

const DAY_MS = 24 * 60 * 60 * 1000;

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 32;
/** Keeps a 1.5px stroke from being clipped at the viewBox edges. */
const SPARK_PAD = 2;

/**
 * `number[]` → an SVG `points` string, or null when there is nothing to draw.
 *
 * The baseline is always zero (these are counts and dollars, not deviations), so a series of all
 * zeros is a flat line ALONG THE BASELINE rather than a divide-by-zero or a misleading mid-height
 * line. A single point is drawn as a full-width horizontal rule at its own height.
 */
function sparklinePoints(series: number[]): string | null {
  if (series.length === 0) {
    return null;
  }

  const top = SPARK_PAD;
  const bottom = SPARK_HEIGHT - SPARK_PAD;
  const max = Math.max(...series);
  const y = (value: number): number =>
    max <= 0 ? bottom : bottom - (value / max) * (bottom - top);

  if (series.length === 1) {
    const only = y(series[0]);
    return `0,${only.toFixed(2)} ${SPARK_WIDTH},${only.toFixed(2)}`;
  }

  const step = SPARK_WIDTH / (series.length - 1);
  return series
    .map((value, index) => `${(index * step).toFixed(2)},${y(value).toFixed(2)}`)
    .join(' ');
}

/**
 * Decorative trend line — a plain polyline, no interactivity, so this stays a server component
 * (no recharts, no `'use client'`). The figures it echoes are always present as text in the card.
 */
function Sparkline({ series, stroke }: { series: number[]; stroke: string }) {
  const points = sparklinePoints(series);
  if (points === null) {
    return <div className="mt-3 h-8" />;
  }
  return (
    <svg
      aria-hidden
      className="mt-3 h-8 w-full"
      preserveAspectRatio="none"
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
    >
      <polyline
        fill="none"
        points={points}
        stroke={stroke}
        strokeLinecap="round"
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function KpiCard({
  label,
  value,
  sub,
  subTone = 'muted',
  note,
  children,
}: {
  label: string;
  value: string;
  sub: string;
  subTone?: 'muted' | 'destructive';
  note?: string;
  children?: ReactNode;
}) {
  return (
    <article className="flex min-w-0 flex-col rounded-2xl border border-border bg-card p-4">
      <p className="text-[10px] font-bold uppercase tracking-[0.1em] text-muted-foreground">
        {label}
      </p>
      <p className="mt-1.5 text-3xl font-semibold tabular-nums tracking-tight text-foreground">
        {value}
      </p>
      <p
        className={[
          'mt-1 text-xs tabular-nums',
          subTone === 'destructive' ? 'text-destructive' : 'text-muted-foreground',
        ].join(' ')}
      >
        {sub}
      </p>
      {children}
      {note !== undefined ? (
        <p className="mt-auto pt-3 text-[11px] leading-4 text-muted-foreground">{note}</p>
      ) : null}
    </article>
  );
}

export async function KpiRow({ window, version }: HealthPanelProps) {
  const fromDay = utcDay(window.from);
  const toDay = utcDay(window.to);

  const current: AggregateWindow = {
    from: window.from.toISOString(),
    to: window.to.toISOString(),
  };

  // Preceding window of equal length, ending the day before this one starts — the same day
  // arithmetic `TokensPerDayPanel` uses, expressed back as inclusive EST-day bounds.
  const dayCount =
    Math.floor(
      (Date.parse(`${toDay}T00:00:00.000Z`) - Date.parse(`${fromDay}T00:00:00.000Z`)) / DAY_MS,
    ) + 1;
  const priorToMs = Date.parse(`${fromDay}T00:00:00.000Z`) - DAY_MS;
  const priorToDay = utcDay(new Date(priorToMs));
  const priorFromDay = utcDay(new Date(priorToMs - (dayCount - 1) * DAY_MS));
  const prior: AggregateWindow = {
    from: `${priorFromDay}T00:00:00.000Z`,
    to: `${priorToDay}T23:59:59.999Z`,
  };

  const [runKpis, priorKpis, aggregates] = await Promise.all([
    getRunKpiSummary(current, version),
    getRunKpiSummary(prior, version),
    getAggregateDashboardData(current, { version }),
  ]);

  // The cost view is a separate surface with its own failure mode; a broken view must not take the
  // other three cards down with it, so its absence degrades to em dashes.
  let costTotalUsd: number | null = null;
  let costRunCount = 0;
  let dailySpend: number[] = [];
  try {
    const [points, runCount] = await Promise.all([
      fetchDailyCostPoints({ startDate: fromDay, endDate: toDay }),
      fetchCostCoveredRunCount({ startDate: fromDay, endDate: toDay }),
    ]);
    costTotalUsd = points.reduce((sum, point) => sum + point.estimatedCostUsd, 0);
    costRunCount = runCount;

    // One point per EST day the view covers, summed across models.
    const byDay = new Map<string, number>();
    for (const point of points) {
      const day = point.bucket.slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + point.estimatedCostUsd);
    }
    dailySpend = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, usd]) => usd);
  } catch {
    costTotalUsd = null;
  }

  const failureDelta = deltaPoints(runKpis.failureRate, priorKpis.failureRate);
  const costPerRun =
    costTotalUsd !== null && costRunCount > 0 ? costTotalUsd / costRunCount : null;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        label="Runs"
        sub={`${formatCount(runKpis.completedRuns)} completed · ${formatCount(runKpis.runningRuns)} running`}
        value={formatCount(runKpis.totalRuns)}
      >
        <Sparkline
          series={runKpis.buckets.map((bucket) => bucket.total)}
          stroke="var(--color-chart-4)"
        />
      </KpiCard>

      <KpiCard
        label="Failure rate"
        sub={`${formatCount(runKpis.failedRuns)} failed · ${formatDeltaPoints(failureDelta)}`}
        // Worse than the preceding window is stated in words by `formatDeltaPoints`; the tint only
        // reinforces it.
        subTone={failureDelta !== null && failureDelta > 0 ? 'destructive' : 'muted'}
        value={formatRatePercent(runKpis.failureRate)}
      >
        <Sparkline
          series={runKpis.buckets.map((bucket) => bucket.failed)}
          stroke="var(--color-destructive)"
        />
      </KpiCard>

      <KpiCard
        label="p95 elapsed"
        // No sparkline: the reader has no per-bucket latency series, and `buckets[].total` is run
        // volume. The sample size is the honest thing to show in its place.
        note={`Over ${formatCount(runKpis.elapsedSampleSize)} terminal run${runKpis.elapsedSampleSize === 1 ? '' : 's'} · no per-bucket latency series is measured, so no trend line is drawn`}
        sub={`avg ${formatMs(runKpis.avgElapsedMs)} · TTFT ${formatMs(aggregates.avgTtftMs)}`}
        value={formatMs(runKpis.p95ElapsedMs)}
      />

      <KpiCard
        // EST-day grained view — "window", never "24h".
        label="Spend · window"
        note="Steps with no model recorded are absent from cost_by_model_per_day, so this is a floor, not a total."
        sub={`${formatUsdPerRun(costPerRun)} per run · ${formatCount(costRunCount)} cost-tracked runs`}
        value={formatUsd(costTotalUsd)}
      >
        <Sparkline series={dailySpend} stroke="var(--color-chart-2)" />
      </KpiCard>
    </div>
  );
}
