'use client';

/**
 * B0-580 — client half of a golden-set tier card: the pass-rate sparkline over the selected
 * window. A day with no golden-set run carries `rate: null` and `connectNulls={false}` keeps
 * it a GAP in the line — never a zero.
 */

import { Line, LineChart, YAxis } from 'recharts';

import { ChartContainer, type ChartConfig } from '~/components/ui/chart';

export type TierSparklinePoint = {
  /** UTC day, `YYYY-MM-DD`. */
  day: string;
  /** Pass rate in percent (0–100), or null on a gap day (no golden-set run). */
  rate: number | null;
};

const chartConfig: ChartConfig = {
  rate: { label: 'Pass rate', color: 'rgb(37 99 235)' },
};

export function TierSparkline({ data }: { data: TierSparklinePoint[] }) {
  return (
    <ChartContainer className="h-14 w-full" config={chartConfig}>
      <LineChart data={data} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
        <YAxis domain={[0, 100]} hide />
        <Line
          connectNulls={false}
          dataKey="rate"
          dot={false}
          isAnimationActive={false}
          stroke="var(--color-rate)"
          strokeWidth={2}
          type="monotone"
        />
      </LineChart>
    </ChartContainer>
  );
}
