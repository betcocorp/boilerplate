'use client';

/**
 * B0-761 — successful vs failed logins per day, ported from c360's "Login attempts by day".
 *
 * Densified over the whole window with `buildDenseDaySeries` so a quiet weekend renders as a line
 * at zero rather than as a straight segment between the two days either side of it — the difference
 * between "nobody logged in" and "we have no rows" is exactly what this panel is for.
 */

import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';

import { formatInt } from '~/components/admin/projects/format';
import {
  ChartContainer,
  ChartLegend,
  ChartTooltip,
  type ChartConfig,
} from '~/components/ui/chart';
import {
  buildDenseDaySeries,
  type EventAnalyticsSummary,
} from '~/lib/event-logging/analytics-repository';

import { AnalyticsTooltipContent } from './chart-tooltip';
import { formatDayLabel, formatDayTick } from './format';
import { AnalyticsPanel } from './panel';

const SUCCESS_STROKE = 'rgb(22 163 74)';
const FAILURE_STROKE = 'rgb(220 38 38)';

const chartConfig = {
  success: { label: 'Successful logins', color: SUCCESS_STROKE },
  failure: { label: 'Failed logins', color: FAILURE_STROKE },
} satisfies ChartConfig;

export function LoginAttemptsChart({
  data,
  days,
}: {
  data: EventAnalyticsSummary;
  days: number;
}) {
  const series = useMemo(
    () => buildDenseDaySeries(data.loginByDay, days, { success: 0, failure: 0 }),
    [data.loginByDay, days],
  );

  const totals = useMemo(
    () =>
      series.reduce(
        (acc, row) => ({
          success: acc.success + (Number.isFinite(row.success) ? row.success : 0),
          failure: acc.failure + (Number.isFinite(row.failure) ? row.failure : 0),
        }),
        { success: 0, failure: 0 },
      ),
    [series],
  );

  const isEmpty = totals.success === 0 && totals.failure === 0;

  return (
    <AnalyticsPanel
      description={
        isEmpty
          ? 'Daily successful (green) vs failed (red) sign-in events.'
          : `Daily successful (green) vs failed (red) sign-in events. Totals in range: ${formatInt(
              totals.success,
            )} successful, ${formatInt(totals.failure)} failed.`
      }
      emptyMessage="No sign-in events recorded yet."
      emptyMinHeightClassName="min-h-[280px]"
      isEmpty={isEmpty}
      title="Login attempts by day"
    >
      <ChartContainer className="h-[280px] w-full" config={chartConfig}>
        <LineChart data={series} margin={{ top: 8, right: 12, left: 4, bottom: 0 }}>
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
          />
          <ChartLegend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
          <Line
            activeDot={{ r: 4 }}
            dataKey="success"
            dot={{ r: 2, fill: SUCCESS_STROKE }}
            name="Successful logins"
            stroke={SUCCESS_STROKE}
            strokeWidth={2}
            type="monotone"
          />
          <Line
            activeDot={{ r: 4 }}
            dataKey="failure"
            dot={{ r: 2, fill: FAILURE_STROKE }}
            name="Failed logins"
            stroke={FAILURE_STROKE}
            strokeWidth={2}
            type="monotone"
          />
        </LineChart>
      </ChartContainer>
    </AnalyticsPanel>
  );
}
