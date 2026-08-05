'use client';

/**
 * B0-336 — aggregate observability charts for `/admin/observability` (epic B0-330).
 *
 * Presentation only: every number is computed server-side by
 * `~/lib/observability/aggregates.ts` over the same window as the runs list.
 * No polling — the page is a fresh server render per request.
 */

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts';

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart';

import type { AggregateDashboardData } from '~/types/observability';

const ROUTING_COLORS: Record<string, string> = {
  product: '#0284c7',
  bathroom: '#9333ea',
  dilution: '#d97706',
  floor: '#059669',
  recommendations: '#e11d48',
  /** Planner could not commit to an SME (`routingDecisionSchema`'s `ambiguous`). */
  ambiguous: '#475569',
  /** Derived bucket for runs whose `final_output` has no routing decision at all. */
  unrouted: '#94a3b8',
};

const ROUTING_FALLBACK_COLOR = '#64748b';

const CONFIDENCE_BUCKET_META: Record<
  AggregateDashboardData['confidenceBuckets'][number]['bucket'],
  { label: string; fill: string }
> = {
  high: { label: 'High (≥ 80%)', fill: '#16a34a' },
  mid: { label: 'Mid (50–79%)', fill: '#f59e0b' },
  low: { label: 'Low (< 50%)', fill: '#dc2626' },
  none: { label: 'No confidence', fill: '#94a3b8' },
};

const chartConfig = {
  count: { label: 'Runs', color: '#0ea5e9' },
  avgDurationMs: { label: 'Average', color: '#0ea5e9' },
  p95DurationMs: { label: 'p95', color: '#f59e0b' },
  failureRatePercent: { label: 'Failure rate', color: '#dc2626' },
} satisfies ChartConfig;

function formatMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function formatWindowDay(iso: string): string {
  return iso.slice(0, 10);
}

function StatTile({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string;
  value: string;
  hint?: string;
  /** `warning` marks a number that should normally be zero (B0-371 orphaned runs). */
  tone?: 'default' | 'warning';
}) {
  const warn = tone === 'warning';
  return (
    <div
      className={
        warn
          ? 'min-w-0 rounded-2xl border border-amber-300 bg-amber-50 p-5'
          : 'min-w-0 rounded-2xl border border-slate-200 p-5'
      }
    >
      <p
        className={
          warn
            ? 'text-xs font-medium uppercase tracking-wide text-amber-700'
            : 'text-xs font-medium uppercase tracking-wide text-slate-500'
        }
      >
        {label}
      </p>
      <p
        className={
          warn
            ? 'mt-2 text-2xl font-semibold tabular-nums text-amber-900'
            : 'mt-2 text-2xl font-semibold tabular-nums text-slate-950'
        }
      >
        {value}
      </p>
      {hint ? (
        <p className={warn ? 'mt-1 text-xs text-amber-700' : 'mt-1 text-xs text-slate-500'}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function AggregateDashboard({ data }: { data: AggregateDashboardData }) {
  const routingPieData = useMemo(
    () =>
      data.routingDistribution.map((datum) => ({
        label: datum.routingDecision,
        count: datum.count,
        avgConfidence: datum.avgConfidence,
        fill: ROUTING_COLORS[datum.routingDecision] ?? ROUTING_FALLBACK_COLOR,
      })),
    [data.routingDistribution],
  );

  const confidenceBucketData = useMemo(
    () =>
      data.confidenceBuckets.map((datum) => ({
        label: CONFIDENCE_BUCKET_META[datum.bucket].label,
        count: datum.count,
        fill: CONFIDENCE_BUCKET_META[datum.bucket].fill,
      })),
    [data.confidenceBuckets],
  );

  const failureRateData = useMemo(
    () =>
      data.failureRateByDay.map((datum) => ({
        day: datum.day.slice(5),
        failureRatePercent: Number((datum.failureRate * 100).toFixed(2)),
        total: datum.total,
        failed: datum.failed,
      })),
    [data.failureRateByDay],
  );

  const latencyData = useMemo(
    () =>
      data.latencyByStep.map((datum) => ({
        stepName: datum.stepName,
        avgDurationMs: datum.avgDurationMs,
        p95DurationMs: datum.p95DurationMs,
        sampleSize: datum.sampleSize,
      })),
    [data.latencyByStep],
  );

  const failureRatePercent =
    data.totalRuns > 0 ? (data.failedRuns / data.totalRuns) * 100 : 0;

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900">Aggregate dashboard</h2>
        <p className="text-xs text-slate-500">
          {formatWindowDay(data.windowFrom)} → {formatWindowDay(data.windowTo)} (UTC days)
        </p>
      </div>

      {/* Headline numbers */}
      <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-6">
        <StatTile label="Total runs" value={String(data.totalRuns)} />
        <StatTile
          hint={
            data.totalRuns > 0
              ? `${((data.completedRuns / data.totalRuns) * 100).toFixed(1)}% of runs`
              : undefined
          }
          label="Completed"
          value={String(data.completedRuns)}
        />
        <StatTile
          hint={data.totalRuns > 0 ? `${failureRatePercent.toFixed(1)}% failure rate` : undefined}
          label="Failed"
          value={String(data.failedRuns)}
        />
        <StatTile
          hint="Mean over runs that recorded a confidence"
          label="Avg confidence"
          value={
            data.avgConfidence === null ? 'n/a' : `${(data.avgConfidence * 100).toFixed(1)}%`
          }
        />
        <StatTile
          hint="Distinct runs with an open review task"
          label="Human review"
          value={String(data.humanReviewCount)}
        />
        <StatTile
          hint={
            data.orphanedRuns > 0
              ? 'Stuck in "running" > 2h with no terminal row — awaiting the sweeper'
              : 'No runs stuck in "running" past the 2h threshold'
          }
          label="Orphaned"
          tone={data.orphanedRuns > 0 ? 'warning' : 'default'}
          value={String(data.orphanedRuns)}
        />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-4">
        {/* Routing distribution + avg confidence */}
        <article className="col-span-4 min-w-0 rounded-2xl border border-slate-200 p-5 lg:col-span-2">
          <h3 className="text-sm font-semibold text-slate-900">
            Routing distribution &amp; average confidence
          </h3>
          {routingPieData.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No runs in this window.</p>
          ) : (
            <>
              <ChartContainer className="mt-4 h-56 w-full min-w-0" config={chartConfig}>
                <PieChart>
                  <Pie
                    cx="50%"
                    cy="50%"
                    data={routingPieData}
                    dataKey="count"
                    innerRadius={50}
                    nameKey="label"
                    outerRadius={82}
                  >
                    {routingPieData.map((entry) => (
                      <Cell fill={entry.fill} key={entry.label} />
                    ))}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                </PieChart>
              </ChartContainer>
              <dl className="mt-3 space-y-1.5 text-xs">
                {routingPieData.map((entry) => (
                  <div className="flex items-center gap-2" key={entry.label}>
                    <span
                      className="inline-block size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: entry.fill }}
                    />
                    <dt className="flex-1 truncate text-slate-600">{entry.label}</dt>
                    <dd className="tabular-nums text-slate-500">
                      {entry.count} run{entry.count === 1 ? '' : 's'} · avg conf{' '}
                      <span className="font-medium text-slate-700">
                        {entry.avgConfidence === null
                          ? 'n/a'
                          : `${(entry.avgConfidence * 100).toFixed(1)}%`}
                      </span>
                    </dd>
                  </div>
                ))}
              </dl>
            </>
          )}
        </article>

        {/* Confidence health */}
        <article className="col-span-4 min-w-0 rounded-2xl border border-slate-200 p-5 lg:col-span-2">
          <h3 className="text-sm font-semibold text-slate-900">Confidence health</h3>
          <ChartContainer className="mt-4 h-56 w-full min-w-0" config={chartConfig}>
            <BarChart data={confidenceBucketData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" interval={0} tick={{ fontSize: 10 }} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11 }} />
              <ChartTooltip content={<ChartTooltipContent />} />
              <Bar dataKey="count" radius={[8, 8, 0, 0]}>
                {confidenceBucketData.map((entry) => (
                  <Cell fill={entry.fill} key={entry.label} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
          <p className="mt-2 text-xs text-slate-500">
            {data.humanReviewCount} run{data.humanReviewCount === 1 ? '' : 's'} escalated to
            human review in this window
            {data.totalRuns > 0
              ? ` (${((data.humanReviewCount / data.totalRuns) * 100).toFixed(1)}% of runs).`
              : '.'}
          </p>
        </article>

        {/* Latency by step */}
        <article className="col-span-4 min-w-0 rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Duration by workflow step (average vs p95)
          </h3>
          {latencyData.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              No completed workflow steps in this window.
            </p>
          ) : (
            <>
              <ChartContainer className="mt-4 h-64 w-full min-w-0" config={chartConfig}>
                <BarChart data={latencyData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="stepName" interval={0} tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => formatMs(Number(value))} />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value) =>
                          typeof value === 'number' && Number.isFinite(value)
                            ? formatMs(value)
                            : 'n/a'
                        }
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Bar
                    dataKey="avgDurationMs"
                    fill="var(--color-avgDurationMs)"
                    radius={[8, 8, 0, 0]}
                  />
                  <Bar
                    dataKey="p95DurationMs"
                    fill="var(--color-p95DurationMs)"
                    radius={[8, 8, 0, 0]}
                  />
                </BarChart>
              </ChartContainer>
              <p className="mt-2 text-xs text-slate-500">
                Sample sizes:{' '}
                {latencyData
                  .map((datum) => `${datum.stepName} (${datum.sampleSize})`)
                  .join(', ')}
                .
              </p>
            </>
          )}
        </article>

        {/* Failure rate by day */}
        <article className="col-span-4 min-w-0 rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900">Failure rate by day (UTC)</h3>
          {failureRateData.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">No days in this window.</p>
          ) : (
            <>
              <ChartContainer className="mt-4 h-56 w-full min-w-0" config={chartConfig}>
                <LineChart data={failureRateData}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="day" interval={0} tick={{ fontSize: 11 }} />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fontSize: 11 }}
                    tickFormatter={(value) => `${value}%`}
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        formatter={(value) =>
                          typeof value === 'number' && Number.isFinite(value)
                            ? `${value.toFixed(2)}%`
                            : 'n/a'
                        }
                      />
                    }
                  />
                  <Line
                    activeDot={{ r: 4 }}
                    dataKey="failureRatePercent"
                    dot={{ r: 2 }}
                    stroke="var(--color-failureRatePercent)"
                    strokeWidth={2}
                    type="monotone"
                  />
                </LineChart>
              </ChartContainer>
              <p className="mt-2 text-xs text-slate-500">
                {data.failedRuns} failed of {data.totalRuns} runs across{' '}
                {failureRateData.length} day{failureRateData.length === 1 ? '' : 's'}.
              </p>
            </>
          )}
        </article>
      </div>
    </section>
  );
}
