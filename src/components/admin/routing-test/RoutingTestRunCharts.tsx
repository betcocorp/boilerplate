'use client';

import { useMemo } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
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
import {
  ROUTING_TEST_ACCURACY_TONE_CLASSES,
  ROUTING_TEST_ROUTER_COLORS,
} from '~/lib/routing-test/constants';
import {
  buildRoutingTestAccuracyTrend,
  buildRoutingTestAggregate,
  buildRoutingTestRouterSummaries,
  formatRoutingTestPercent,
} from '~/lib/routing-test/run-analytics';
import { routingTestAccuracyTone } from '~/lib/routing-test/scoring';
import type { RoutingTestRunRecord } from '~/lib/routing-test/types';

type RoutingTestRunChartsProps = {
  /** The same run rows the history table below renders — newest first (`listRoutingTestRuns()`). */
  runs: RoutingTestRunRecord[];
};

const chartConfig = {
  avgAccuracy: { label: 'Average', color: '#0ea5e9' },
  latestAccuracy: { label: 'Latest run', color: '#94a3b8' },
  avgItemDurationMs: { label: 'Avg item', color: '#f59e0b' },
  keyword: { label: 'Keyword', color: ROUTING_TEST_ROUTER_COLORS.keyword },
  semantic: { label: 'Semantic', color: ROUTING_TEST_ROUTER_COLORS.semantic },
  llm: { label: 'LLM', color: ROUTING_TEST_ROUTER_COLORS.llm },
} satisfies ChartConfig;

function formatPercentTick(value: number): string {
  return `${value}%`;
}

/**
 * B0-698 — the three comparison charts between the page title card and the run-history table:
 * accuracy per router, accuracy across the run history, and per-item latency per router. Every
 * figure is derived client-side from the persisted run rows (see `~/lib/routing-test/run-analytics`)
 * — nothing here re-scores anything, so a chart can never disagree with the table below it.
 *
 * The caller only renders this when at least one run exists; the run-history section owns the
 * zero-runs empty state.
 */
export function RoutingTestRunCharts({ runs }: RoutingTestRunChartsProps) {
  const summaries = useMemo(
    () => buildRoutingTestRouterSummaries(runs),
    [runs],
  );
  const aggregate = useMemo(
    () => buildRoutingTestAggregate(runs, summaries),
    [runs, summaries],
  );
  const trend = useMemo(() => buildRoutingTestAccuracyTrend(runs), [runs]);

  // Recharts works in whole percents here so the axis, tooltip and stat strip all read the same.
  const accuracyByRouter = useMemo(
    () =>
      summaries.map((summary) => ({
        label: summary.label,
        runCount: summary.runCount,
        avgAccuracy: Math.round(summary.avgAccuracy * 100),
        latestAccuracy:
          summary.latestAccuracy === null
            ? null
            : Math.round(summary.latestAccuracy * 100),
      })),
    [summaries],
  );

  const latencyByRouter = useMemo(
    () =>
      summaries.map((summary) => ({
        label: summary.label,
        avgItemDurationMs: summary.avgItemDurationMs ?? 0,
        fill: ROUTING_TEST_ROUTER_COLORS[summary.routerType],
      })),
    [summaries],
  );

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-slate-900">
            Router comparison
          </h2>
          <p className="text-sm text-slate-600">
            Aggregated across every recorded run below.
          </p>
        </div>
        <dl className="flex flex-wrap gap-6">
          <div>
            <dt className="text-xs text-slate-500">Runs</dt>
            <dd className="text-lg font-semibold text-slate-900">
              {aggregate.totalRuns}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Overall accuracy</dt>
            <dd
              className={`text-lg font-semibold ${ROUTING_TEST_ACCURACY_TONE_CLASSES[routingTestAccuracyTone(aggregate.overallAccuracy)]}`}
            >
              {formatRoutingTestPercent(aggregate.overallAccuracy)}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Best router</dt>
            <dd className="text-lg font-semibold text-slate-900">
              {aggregate.bestRouter
                ? `${aggregate.bestRouter.label} · ${formatRoutingTestPercent(aggregate.bestRouter.avgAccuracy)}`
                : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-slate-500">Degraded items</dt>
            <dd className="text-lg font-semibold text-slate-900">
              {aggregate.totalDegradedItems}
            </dd>
          </div>
        </dl>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <article className="min-w-0 rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Accuracy by router
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Average of every run vs the most recent run.
          </p>
          <ChartContainer
            className="mt-4 h-56 w-full min-w-0"
            config={chartConfig}
          >
            <BarChart data={accuracyByRouter}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" interval={0} tick={{ fontSize: 11 }} />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 11 }}
                tickFormatter={formatPercentTick}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) =>
                      typeof value === 'number' ? `${value}%` : 'no runs'
                    }
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              <Bar
                dataKey="avgAccuracy"
                fill="var(--color-avgAccuracy)"
                radius={[8, 8, 0, 0]}
              />
              <Bar
                dataKey="latestAccuracy"
                fill="var(--color-latestAccuracy)"
                radius={[8, 8, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
        </article>

        <article className="min-w-0 rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Avg item latency by router
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Mean classification time per prompt — the cost side of accuracy.
          </p>
          <ChartContainer
            className="mt-4 h-56 w-full min-w-0"
            config={chartConfig}
          >
            <BarChart data={latencyByRouter}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" interval={0} tick={{ fontSize: 11 }} />
              <YAxis
                tick={{ fontSize: 11 }}
                tickFormatter={(value) => `${value}ms`}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) =>
                      typeof value === 'number' ? `${value} ms` : 'n/a'
                    }
                  />
                }
              />
              <Bar dataKey="avgItemDurationMs" radius={[8, 8, 0, 0]}>
                {latencyByRouter.map((entry) => (
                  <Cell fill={entry.fill} key={entry.label} />
                ))}
              </Bar>
            </BarChart>
          </ChartContainer>
        </article>

        <article className="min-w-0 rounded-2xl border border-slate-200 p-5 lg:col-span-2">
          <h3 className="text-sm font-semibold text-slate-900">
            Accuracy across runs
          </h3>
          <p className="mt-1 text-xs text-slate-500">
            Every recorded run in order, oldest first — one line per router.
          </p>
          <ChartContainer
            className="mt-4 h-56 w-full min-w-0"
            config={chartConfig}
          >
            <LineChart data={trend}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" interval={0} tick={{ fontSize: 11 }} />
              <YAxis
                domain={[0, 100]}
                tick={{ fontSize: 11 }}
                tickFormatter={formatPercentTick}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) =>
                      typeof value === 'number' ? `${value}%` : 'n/a'
                    }
                  />
                }
              />
              <ChartLegend content={<ChartLegendContent />} />
              {/* connectNulls joins each router's own runs across the gaps left by the others. */}
              <Line
                connectNulls
                dataKey="keyword"
                dot={{ r: 3 }}
                stroke="var(--color-keyword)"
                strokeWidth={2}
                type="monotone"
              />
              <Line
                connectNulls
                dataKey="semantic"
                dot={{ r: 3 }}
                stroke="var(--color-semantic)"
                strokeWidth={2}
                type="monotone"
              />
              <Line
                connectNulls
                dataKey="llm"
                dot={{ r: 3 }}
                stroke="var(--color-llm)"
                strokeWidth={2}
                type="monotone"
              />
            </LineChart>
          </ChartContainer>
        </article>
      </div>
    </section>
  );
}
