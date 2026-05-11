'use client';

import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';

import {
  ChartContainer,
  type ChartConfig,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart';
import { formatSimilarityPercent } from '~/lib/tests/format';

export type SimilarityFailRateTrendPoint = {
  label: string;
  runCreatedAt: string;
  avgSimilarity: number | null;
  failRate: number;
  totalCases: number;
};

const chartConfig = {
  avgSimilarity: {
    label: 'Avg similarity',
    color: 'rgb(37 99 235)',
  },
  failRate: {
    label: 'Avg fail rate',
    color: 'rgb(239 68 68)',
  },
} satisfies ChartConfig;

export function SimilarityFailRateTrendChart({
  points,
}: {
  points: SimilarityFailRateTrendPoint[];
}) {
  return (
    <div className="mt-8">
      <ChartContainer className="h-60 w-full" config={chartConfig}>
        <LineChart data={points} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tickMargin={8} />
          <YAxis
            domain={[0, 1]}
            tickFormatter={(value) =>
              typeof value === 'number' ? `${(value * 100).toFixed(0)}%` : `${value ?? ''}`
            }
            tickLine={false}
            axisLine={false}
            tickMargin={8}
          />
          <ChartTooltip
            content={
              <ChartTooltipContent
                labelFormatter={(label) => {
                  const point = points.find((p) => p.label === label);
                  if (!point) {
                    return `Run: ${label}`;
                  }
                  return `Run: ${label} · ${new Date(point.runCreatedAt).toLocaleDateString()}`;
                }}
                formatter={(value) => formatSimilarityPercent(typeof value === 'number' ? value : null)}
              />
            }
          />
          <Line
            type="monotone"
            dataKey="avgSimilarity"
            connectNulls={false}
            dot={false}
            stroke="var(--color-avgSimilarity)"
            strokeWidth={2}
          />
          <Line
            type="monotone"
            dataKey="failRate"
            dot={false}
            stroke="var(--color-failRate)"
            strokeWidth={2}
          />
        </LineChart>
      </ChartContainer>
      <p className="mt-3 text-xs text-muted-foreground">
        Tracks monthly averages; includes {points.reduce((sum, p) => sum + p.totalCases, 0)} test
        cases in range.
      </p>
    </div>
  );
}
