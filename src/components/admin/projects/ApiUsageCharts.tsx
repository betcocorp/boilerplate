'use client';

import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '~/components/ui/chart';
import type { DailyPoint } from '~/lib/api/analytics-repository';

const requestsConfig = {
  requests: { label: 'Requests', color: 'rgb(37 99 235)' },
} satisfies ChartConfig;

const tokensConfig = {
  tokens: { label: 'LLM tokens', color: 'rgb(16 185 129)' },
} satisfies ChartConfig;

const shortDate = (d: string) => d.slice(5); // MM-DD

function UsageAreaChart({
  data,
  dataKey,
  config,
  colorVar,
}: {
  data: DailyPoint[];
  dataKey: 'requests' | 'tokens';
  config: ChartConfig;
  colorVar: string;
}) {
  return (
    <ChartContainer className="h-52 w-full" config={config}>
      <AreaChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="date" tickFormatter={shortDate} tickLine={false} axisLine={false} tickMargin={8} />
        <YAxis tickLine={false} axisLine={false} tickMargin={8} width={48} allowDecimals={false} />
        <ChartTooltip content={<ChartTooltipContent />} />
        <Area type="monotone" dataKey={dataKey} stroke={colorVar} fill={colorVar} fillOpacity={0.15} strokeWidth={2} />
      </AreaChart>
    </ChartContainer>
  );
}

export function ApiUsageCharts({ daily }: { daily: DailyPoint[] }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-3xl border border-border/60 p-4">
        <p className="mb-2 text-sm font-medium">Requests per day</p>
        <UsageAreaChart data={daily} dataKey="requests" config={requestsConfig} colorVar="var(--color-requests)" />
      </div>
      <div className="rounded-3xl border border-border/60 p-4">
        <p className="mb-2 text-sm font-medium">LLM tokens per day</p>
        <UsageAreaChart data={daily} dataKey="tokens" config={tokensConfig} colorVar="var(--color-tokens)" />
      </div>
    </div>
  );
}
