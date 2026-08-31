'use client';

/** B0-761 — c360's "Events per day": total event volume per calendar day, gaps filled with zeros. */

import { useMemo } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import { ChartContainer, ChartTooltip, type ChartConfig } from '~/components/ui/chart';
import {
  buildDenseDaySeries,
  type EventAnalyticsSummary,
} from '~/lib/event-logging/analytics-repository';

import { AnalyticsTooltipContent } from './chart-tooltip';
import { formatDayLabel, formatDayTick } from './format';
import { AnalyticsPanel } from './panel';

const chartConfig = {
  count: { label: 'Events', color: 'oklch(0.45 0.15 250)' },
} satisfies ChartConfig;

export function EventsPerDayChart({
  data,
  days,
}: {
  data: EventAnalyticsSummary;
  days: number;
}) {
  const series = useMemo(
    () => buildDenseDaySeries(data.byDay, days, { count: 0 }),
    [data.byDay, days],
  );

  const isEmpty = series.every((row) => !row.count);

  return (
    <AnalyticsPanel
      className="xl:col-span-3"
      description="Daily counts over the selected range."
      emptyMessage="No events recorded yet."
      emptyMinHeightClassName="min-h-[280px]"
      isEmpty={isEmpty}
      title="Events per day"
    >
      <ChartContainer className="h-[280px] w-full" config={chartConfig}>
        <BarChart data={series} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            axisLine={false}
            dataKey="date"
            interval="preserveStartEnd"
            minTickGap={24}
            tickFormatter={formatDayTick}
            tickLine={false}
            tickMargin={8}
          />
          <YAxis allowDecimals={false} axisLine={false} tickLine={false} tickMargin={8} width={48} />
          <ChartTooltip
            content={
              <AnalyticsTooltipContent title={(row) => formatDayLabel(String(row.date ?? ''))} />
            }
            cursor={false}
          />
          <Bar dataKey="count" fill="var(--color-count)" name="Events" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ChartContainer>
    </AnalyticsPanel>
  );
}
