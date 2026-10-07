'use client';

/**
 * B0-761 — interactions by hour of day, ported from c360's "Traffic volume by hour".
 *
 * Densified to all 24 buckets before rendering: the repository only returns hours that actually
 * have rows, and a bar chart that silently omits 3am–7am reads as "quiet overnight" when it really
 * means "no data". The peak hour gets its own fill and the next four ranks a lighter one, so the
 * shape of the working day is legible without reading the axis.
 */

import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from 'recharts';

import { formatInt } from '~/components/admin/projects/format';
import { ChartContainer, ChartTooltip, type ChartConfig } from '~/components/ui/chart';
import type { EventAnalyticsSummary } from '~/lib/event-logging/analytics-repository';

import { AnalyticsTooltipContent } from './chart-tooltip';
import { formatHourRange, formatHourTick, normalizeHour } from './format';
import { AnalyticsPanel } from './panel';

/** #1 by volume, the next four ranks, everything else. */
const PEAK_FILL = 'oklch(0.58 0.15 163.14)';
const RUNNER_UP_FILL = 'oklch(0.87 0.11 168.04)';
const DEFAULT_FILL = 'oklch(0.55 0.16 250)';

const chartConfig = {
  count: { label: 'Events', color: DEFAULT_FILL },
} satisfies ChartConfig;

type HourRow = { hour: number; label: string; count: number };

/** One row per hour so the chart always shows the full day. */
function buildDenseHourSeries(rows: EventAnalyticsSummary['interactionsByHour']): HourRow[] {
  const byHour = new Map<number, number>();
  for (const row of rows) {
    const hour = normalizeHour(row.hour);
    byHour.set(hour, (byHour.get(hour) ?? 0) + (Number.isFinite(row.count) ? row.count : 0));
  }
  return Array.from({ length: 24 }, (_, hour) => ({
    hour,
    label: formatHourTick(hour),
    count: byHour.get(hour) ?? 0,
  }));
}

export function TrafficByHourChart({ data }: { data: EventAnalyticsSummary }) {
  const series = useMemo(
    () => buildDenseHourSeries(data.interactionsByHour),
    [data.interactionsByHour],
  );

  const ranking = useMemo(() => {
    const sorted = [...series].sort((a, b) => b.count - a.count || a.hour - b.hour);
    const peak = sorted[0] ?? { hour: 0, label: formatHourTick(0), count: 0 };
    const runnersUp = new Set(
      sorted
        .slice(1, 5)
        .filter((row) => row.count > 0)
        .map((row) => row.hour),
    );
    return { peak, runnersUp };
  }, [series]);

  const isEmpty = ranking.peak.count === 0;

  return (
    <AnalyticsPanel
      description={
        isEmpty ? (
          `Total interactions by hour of day across the selected ${data.days}-day window.`
        ) : (
          <>
            Total interactions by hour of day across the selected {data.days}-day window. Peak
            activity is around{' '}
            <span className="font-medium text-foreground">
              {formatHourRange(ranking.peak.hour)}
            </span>{' '}
            with {formatInt(ranking.peak.count)} events.
          </>
        )
      }
      emptyMessage="No events recorded yet, so there is no hourly traffic to chart."
      emptyMinHeightClassName="min-h-[280px]"
      isEmpty={isEmpty}
      title="Traffic volume by hour"
    >
      <ChartContainer className="h-[280px] w-full" config={chartConfig}>
        <BarChart data={series} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="label"
            interval={1}
            minTickGap={0}
            tickLine={false}
            tickMargin={8}
          />
          <YAxis allowDecimals={false} axisLine={false} tickLine={false} tickMargin={8} width={48} />
          <ChartTooltip
            content={
              <AnalyticsTooltipContent
                title={(row) =>
                  typeof row.hour === 'number' ? formatHourRange(row.hour) : 'Hour of day'
                }
              />
            }
            cursor={false}
          />
          <Bar dataKey="count" name="Events" radius={[4, 4, 0, 0]}>
            {series.map((row) => (
              <Cell
                fill={
                  row.hour === ranking.peak.hour
                    ? PEAK_FILL
                    : ranking.runnersUp.has(row.hour)
                      ? RUNNER_UP_FILL
                      : DEFAULT_FILL
                }
                key={row.hour}
              />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
    </AnalyticsPanel>
  );
}
