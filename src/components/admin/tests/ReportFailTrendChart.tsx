'use client';

import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';

import {
  ChartContainer,
  ChartTooltip,
  type ChartConfig,
} from '~/components/ui/chart';
import {
  formatFailChange,
  type ReportFailPoint,
  type ReportFailTrend,
} from '~/lib/tests/report-fail-trend';
import { cn } from '~/lib/utils';
import { formatDate, formatRunChartAxisLabel } from '~/lib/utils/time';

/**
 * Same shared-time-axis chart as `ReportMetricTrendChart`, generalized for a plain fail count
 * instead of a millisecond-valued metric — the Y axis auto-scales to whole numbers, with no unit
 * suffix on values.
 */

/** Same palette as the score/metric trend charts so a dataset's color reads the same everywhere. */
const SERIES_COLORS = [
  '#0ea5e9',
  '#16a34a',
  '#f59e0b',
  '#ef4444',
  '#8b5cf6',
  '#ec4899',
  '#14b8a6',
  '#f97316',
  '#6366f1',
  '#84cc16',
  '#06b6d4',
  '#d946ef',
  '#be123c',
  '#0f766e',
  '#a16207',
  '#4338ca',
] as const;

function seriesKey(index: number): string {
  return `s${index}`;
}

function axisLabel(timestamp: number): string {
  return formatRunChartAxisLabel(new Date(timestamp).toISOString());
}

/** One row per distinct timestamp; a series' value is set only where that dataset actually ran. */
type ChartRow = { timestamp: number } & Record<string, number | undefined>;

type TooltipPayloadItem = {
  dataKey?: string | number;
  value?: number | string;
  color?: string;
  payload?: { timestamp?: number };
};

function ReportFailTooltip({
  active,
  payload,
  label,
  config,
  pointLookup,
}: {
  active?: boolean;
  payload?: TooltipPayloadItem[];
  label?: string | number;
  config: ChartConfig;
  pointLookup: Map<string, ReportFailPoint>;
}) {
  const rows = (payload ?? []).filter(
    (item) => item.dataKey != null && typeof item.value === 'number',
  );

  if (!active || rows.length === 0) {
    return null;
  }

  const timestamp = rows[0].payload?.timestamp ?? Number(label);
  const heading = Number.isFinite(timestamp) ? axisLabel(timestamp) : '';

  return (
    <div className="rounded-lg border border-border/60 bg-background px-3 py-2 text-xs shadow-sm">
      {heading ? <p className="mb-1.5 font-medium">{heading}</p> : null}
      <div className="space-y-1.5">
        {rows.map((item) => {
          const key = String(item.dataKey);
          const point = pointLookup.get(`${key}:${timestamp}`);
          const name = config[key]?.label ?? key;
          const change = point?.change ?? null;

          return (
            <div key={key}>
              <div className="flex items-center justify-between gap-4">
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{
                      backgroundColor: item.color || config[key]?.color,
                    }}
                  />
                  {name}
                </span>
                <span className="font-medium tabular-nums text-foreground">
                  {item.value}
                </span>
              </div>
              <p className="pl-3.5 text-[11px] text-muted-foreground">
                {point ? formatDate(point.startedAt) : heading}
                {change ? ` · ${formatFailChange(change)}` : ''}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ReportFailTrendChart({
  trend,
  title,
  emptyMessage,
}: {
  trend: ReportFailTrend;
  title: string;
  emptyMessage: string;
}) {
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => new Set());

  const chartConfig = useMemo<ChartConfig>(() => {
    const config: ChartConfig = {};
    trend.series.forEach((series, index) => {
      config[seriesKey(index)] = {
        label: series.testName,
        color: SERIES_COLORS[index % SERIES_COLORS.length],
      };
    });
    return config;
  }, [trend.series]);

  const rows = useMemo<ChartRow[]>(() => {
    const byTimestamp = new Map<number, ChartRow>();
    trend.series.forEach((series, index) => {
      const key = seriesKey(index);
      for (const point of series.points) {
        let row = byTimestamp.get(point.timestamp);
        if (!row) {
          row = { timestamp: point.timestamp };
          byTimestamp.set(point.timestamp, row);
        }
        row[key] = point.value;
      }
    });
    return [...byTimestamp.values()].sort((a, b) => a.timestamp - b.timestamp);
  }, [trend.series]);

  const pointLookup = useMemo(() => {
    const lookup = new Map<string, ReportFailPoint>();
    trend.series.forEach((series, index) => {
      for (const point of series.points) {
        lookup.set(`${seriesKey(index)}:${point.timestamp}`, point);
      }
    });
    return lookup;
  }, [trend.series]);

  function toggleSeries(key: string) {
    setHiddenKeys((previous) => {
      const next = new Set(previous);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  if (trend.series.length === 0) {
    return (
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <p className="mt-2 text-sm text-slate-500">{emptyMessage}</p>
      </section>
    );
  }

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <p className="mt-1 text-xs text-slate-500">
            {trend.series.length} dataset{trend.series.length === 1 ? '' : 's'}{' '}
            · {trend.plottedRunCount} run
            {trend.plottedRunCount === 1 ? '' : 's'} plotted.
            {trend.missingRunCount > 0
              ? ` ${trend.missingRunCount} run${trend.missingRunCount === 1 ? '' : 's'} ${
                  trend.missingRunCount === 1 ? 'is' : 'are'
                } not plotted because ${
                  trend.missingRunCount === 1 ? 'it has' : 'they have'
                } no recorded fail count.`
              : ''}
          </p>
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          {trend.series.map((series, index) => {
            const key = seriesKey(index);
            const color = SERIES_COLORS[index % SERIES_COLORS.length];
            const isHidden = hiddenKeys.has(key);
            const change = series.latestChange;

            return (
              <button
                aria-pressed={!isHidden}
                className={cn(
                  'inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 text-xs transition',
                  isHidden
                    ? 'border-slate-200 bg-slate-50 text-slate-400'
                    : 'border-slate-200 bg-white text-slate-700 shadow-sm hover:bg-slate-50',
                )}
                key={key}
                onClick={() => toggleSeries(key)}
                title={
                  isHidden
                    ? `${series.testName} — hidden. Click to show on the chart.`
                    : `${series.testName} — latest ${series.latestValue} fail${series.latestValue === 1 ? '' : 's'}. Click to hide.`
                }
                type="button"
              >
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: isHidden ? '#cbd5e1' : color }}
                />
                <span
                  className="min-w-0 truncate font-medium w-18 truncate"
                  title={series.testName}
                >
                  {series.testName}
                </span>
                <span className="tabular-nums text-slate-500">
                  {series.latestValue}
                </span>
                <span
                  className={cn(
                    'tabular-nums',
                    isHidden
                      ? 'text-slate-400'
                      : change === null
                        ? 'text-slate-400'
                        : change.delta > 0
                          ? 'text-rose-600'
                          : change.delta < 0
                            ? 'text-emerald-600'
                            : 'text-slate-500',
                  )}
                >
                  {change ? formatFailChange(change) : '—'}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <ChartContainer
        className="mt-5 h-80 w-full min-w-0 max-h-[200px] overflow-y-auto"
        config={chartConfig}
      >
        <LineChart data={rows}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="timestamp"
            domain={['dataMin', 'dataMax']}
            minTickGap={40}
            scale="time"
            tick={{ fontSize: 11 }}
            tickFormatter={(value) =>
              typeof value === 'number' ? axisLabel(value) : ''
            }
            type="number"
          />
          <YAxis
            allowDecimals={false}
            domain={[0, 'auto']}
            tick={{ fontSize: 11 }}
          />
          <ChartTooltip
            content={
              <ReportFailTooltip
                config={chartConfig}
                pointLookup={pointLookup}
              />
            }
          />
          {trend.series.map((series, index) => {
            const key = seriesKey(index);
            if (hiddenKeys.has(key)) {
              return null;
            }
            return (
              <Line
                activeDot={{ r: 5 }}
                connectNulls
                dataKey={key}
                dot={{ r: 3 }}
                key={key}
                name={series.testName}
                stroke={SERIES_COLORS[index % SERIES_COLORS.length]}
                strokeWidth={2}
                type="monotone"
              />
            );
          })}
        </LineChart>
      </ChartContainer>
    </section>
  );
}
