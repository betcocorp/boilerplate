'use client';

/**
 * B0-761 — the shared "one line per user, per day" chart behind both top-user panels
 * (`TopUsersLoginChart` and `TopUsersPageViewsChart`). c360 had this logic inlined twice inside a
 * 983-line file; here it is written once and the two panels differ only in copy and data.
 *
 * Two deliberate choices worth keeping:
 *
 * 1. **Function `dataKey`s.** A user key is a `userId` or an EMAIL, and recharts treats a string
 *    `dataKey` containing a dot as a deep object path — `tbird@betco.com` would resolve
 *    `row.tbird@betco` then `.com` and silently plot nothing. Reading the cell through a closure
 *    sidesteps the path syntax entirely.
 * 2. **A sanitised `ChartConfig`.** `ChartContainer` turns every config key into a `--color-<key>`
 *    CSS custom property, and an email is not a valid custom-property name, so the config is keyed
 *    `user0…user9` while the human label rides along for the legend and tooltip.
 */

import { useMemo } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';

import { ChartContainer, ChartLegend, ChartTooltip, type ChartConfig } from '~/components/ui/chart';
import {
  pivotUserDaySeries,
  type UserDayMetricRow,
} from '~/lib/event-logging/analytics-repository';

import { AnalyticsTooltipContent } from './chart-tooltip';
import { formatDayLabel, truncateEvent } from './format';
import { AnalyticsPanel } from './panel';

/** Ten visually distinct strokes; the pivot returns at most ten users. */
const USER_LINE_COLORS = [
  'rgb(37 99 235)',
  'rgb(22 163 74)',
  'rgb(234 88 12)',
  'rgb(147 51 234)',
  'rgb(219 39 119)',
  'rgb(8 145 178)',
  'rgb(180 83 9)',
  'rgb(79 70 229)',
  'rgb(13 148 136)',
  'rgb(220 38 38)',
] as const;

type PivotRow = Record<string, string | number>;

/** Recharts needs a per-row label field; the pivot may name it `dayLabel` or only give us `date`. */
const BUCKET_LABEL_FIELD = '__bucketLabel';

export function UserDaySeriesChart({
  days,
  description,
  emptyMessage,
  rows,
  title,
}: {
  days: number;
  description: string;
  emptyMessage: string;
  rows: UserDayMetricRow[];
  title: string;
}) {
  const { chartRows, series } = useMemo(() => {
    const pivot = pivotUserDaySeries(rows, days);
    // The pivot's per-user cell key is not part of its published shape: prefer the raw user key when
    // the row carries it, and fall back to the positional `s<i>` naming otherwise.
    const sample: PivotRow = pivot.data[0] ?? {};
    const resolved = pivot.users.slice(0, USER_LINE_COLORS.length).map((user, index) => ({
      cellKey: Object.prototype.hasOwnProperty.call(sample, user.userKey)
        ? user.userKey
        : `s${index}`,
      color: USER_LINE_COLORS[index % USER_LINE_COLORS.length],
      configKey: `user${index}`,
      label: truncateEvent(user.label || user.userKey, 28),
      userKey: user.userKey,
    }));

    return {
      chartRows: pivot.data.map((row) => ({
        ...row,
        [BUCKET_LABEL_FIELD]: formatDayLabel(String(row.dayLabel ?? row.date ?? '')),
      })),
      series: resolved,
    };
  }, [days, rows]);

  const chartConfig = useMemo(
    () =>
      Object.fromEntries(
        series.map((entry) => [entry.configKey, { label: entry.label, color: entry.color }]),
      ) satisfies ChartConfig,
    [series],
  );

  return (
    <AnalyticsPanel
      description={description}
      emptyMessage={emptyMessage}
      emptyMinHeightClassName="min-h-[320px]"
      isEmpty={series.length === 0 || chartRows.length === 0}
      title={title}
    >
      <ChartContainer className="h-[320px] w-full" config={chartConfig}>
        <LineChart data={chartRows} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
          <CartesianGrid vertical={false} />
          <XAxis
            axisLine={false}
            dataKey={BUCKET_LABEL_FIELD}
            interval="preserveStartEnd"
            minTickGap={28}
            tickLine={false}
            tickMargin={8}
          />
          <YAxis allowDecimals={false} axisLine={false} tickLine={false} tickMargin={8} width={48} />
          <ChartTooltip
            content={
              <AnalyticsTooltipContent
                hideZeroRows
                maxRows={10}
                sortByValue
                title={(row) => String(row[BUCKET_LABEL_FIELD] ?? '')}
              />
            }
          />
          <ChartLegend wrapperStyle={{ fontSize: 11, lineHeight: 1.35, paddingTop: 8 }} />
          {series.map((entry) => (
            <Line
              activeDot={{ r: 4 }}
              dataKey={(row: PivotRow) => {
                const value = row[entry.cellKey];
                return typeof value === 'number' && Number.isFinite(value) ? value : 0;
              }}
              dot={{ r: 2 }}
              key={entry.userKey}
              name={entry.label}
              stroke={entry.color}
              strokeWidth={2}
              type="monotone"
            />
          ))}
        </LineChart>
      </ChartContainer>
    </AnalyticsPanel>
  );
}
