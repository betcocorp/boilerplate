'use client';

/**
 * B0-761 — c360's "Top five page mix": share of volume among the busiest page-view events.
 *
 * Slice labels are omitted on purpose — page event names are long dotted strings that overlap into
 * illegibility at this size — so the name, count and unique-user count live in the tooltip.
 */

import { useMemo } from 'react';
import { Cell, Pie, PieChart } from 'recharts';

import { formatInt } from '~/components/admin/projects/format';
import { ChartContainer, ChartTooltip, type ChartConfig } from '~/components/ui/chart';
import type { EventAnalyticsSummary } from '~/lib/event-logging/analytics-repository';

import { AnalyticsPanel } from './panel';

const SLICE_COLORS = [
  'oklch(0.55 0.18 250)',
  'oklch(0.55 0.14 160)',
  'oklch(0.65 0.16 45)',
  'oklch(0.5 0.12 300)',
  'oklch(0.55 0.1 200)',
] as const;

type Slice = { name: string; users: number; value: number };

const chartConfig = {
  value: { label: 'Views' },
} satisfies ChartConfig;

function MixTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload?: unknown; value?: number | string }>;
}) {
  if (!active || !payload?.length) return null;
  const slice = payload[0]?.payload as Partial<Slice> | undefined;
  const views = typeof slice?.value === 'number' ? slice.value : Number(payload[0]?.value ?? 0);
  const users = typeof slice?.users === 'number' ? slice.users : 0;
  return (
    <div className="max-w-xs rounded-lg border border-border/60 bg-background px-3 py-2 text-xs shadow-sm">
      <p className="font-mono leading-snug font-medium wrap-break-word text-foreground">
        {slice?.name ?? 'Page'}
      </p>
      <p className="mt-1 tabular-nums text-muted-foreground">
        {formatInt(Number.isFinite(views) ? views : 0)} {views === 1 ? 'view' : 'views'}
      </p>
      <p className="tabular-nums text-muted-foreground">
        {formatInt(users)} {users === 1 ? 'user' : 'users'}
      </p>
    </div>
  );
}

export function TopPageMixChart({ data }: { data: EventAnalyticsSummary }) {
  const slices = useMemo<Slice[]>(
    () =>
      data.topPages
        .slice(0, 5)
        .filter((row) => row.count > 0)
        .map((row) => ({ name: row.event, users: row.userCount, value: row.count })),
    [data.topPages],
  );

  return (
    <AnalyticsPanel
      className="xl:col-span-2"
      description="Share of volume among the busiest page-view events. Hover a slice for the page name, events, and unique users."
      emptyMessage="No page-view events recorded yet."
      emptyMinHeightClassName="min-h-[280px]"
      isEmpty={slices.length === 0}
      title="Top five page mix"
    >
      <ChartContainer className="h-[280px] w-full" config={chartConfig}>
        <PieChart margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
          <Pie
            cx="50%"
            cy="50%"
            data={slices}
            dataKey="value"
            innerRadius={48}
            label={false}
            nameKey="name"
            outerRadius={76}
            paddingAngle={2}
          >
            {slices.map((slice, index) => (
              <Cell fill={SLICE_COLORS[index % SLICE_COLORS.length]} key={slice.name} />
            ))}
          </Pie>
          <ChartTooltip content={<MixTooltip />} />
        </PieChart>
      </ChartContainer>
    </AnalyticsPanel>
  );
}
