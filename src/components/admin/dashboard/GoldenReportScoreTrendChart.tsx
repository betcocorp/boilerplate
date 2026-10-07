'use client';

/**
 * B0-749 — client half of the golden-set report-score trend panel: one line, one point per EST
 * day, y-axis fixed 0-100. Days with no scored golden run have no plotted point (never a 0), but
 * the line still connects across them (`connectNulls`) so a run of gap days doesn't fragment the
 * trend into disconnected segments — a shaded `ReferenceArea` band marks each such day (same
 * convention as `TokensPerDayChart`) so "no data" is still visible, just not a broken line.
 */

import { CartesianGrid, Line, LineChart, ReferenceArea, XAxis, YAxis } from 'recharts';

import { ChartContainer, ChartTooltip, type ChartConfig } from '~/components/ui/chart';
import { cn } from '~/lib/utils';
import type { GoldenReportScoreDayPoint } from '~/lib/tests/golden-report-score-trend';

const chartConfig: ChartConfig = {
  score: { label: 'Golden report score', color: 'rgb(37 99 235)' },
};

/** Real minus sign (U+2212) so a negative change renders with a proper minus, not a hyphen. */
const MINUS = '−';

function formatDayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'EST' });
}

function formatChangePct(changePct: number): string {
  if (changePct === 0) return '0.0%';
  const sign = changePct > 0 ? '+' : MINUS;
  return `${sign}${Math.abs(changePct).toFixed(1)}%`;
}

type TooltipPayloadEntry = {
  value?: number | string;
  payload?: GoldenReportScoreDayPoint;
};

function GoldenReportScoreTooltip({
  active,
  payload,
  label,
}: {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string | number;
}) {
  if (!active || !payload?.length) {
    return null;
  }
  const datum = payload[0]?.payload;
  const day = typeof label === 'string' ? label : String(label ?? '');

  if (!datum || datum.score === null) {
    return (
      <div className="rounded-lg border border-border/60 bg-background px-3 py-2 text-xs shadow-sm">
        <p className="font-medium">{formatDayLabel(day)}</p>
        <p className="mt-1 text-muted-foreground">
          No scored golden-set runs — empty slot, not a zero score.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border/60 bg-background px-3 py-2 text-xs shadow-sm">
      <p className="font-medium">{formatDayLabel(day)}</p>
      <div className="mt-1 flex items-center justify-between gap-3">
        <span className="text-muted-foreground">Score</span>
        <span className="font-medium tabular-nums text-foreground">{datum.score}/100</span>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="text-muted-foreground">Vs prior day</span>
        <span
          className={cn(
            'font-medium tabular-nums',
            datum.changePct === null
              ? 'text-muted-foreground'
              : datum.changePct > 0
                ? 'text-emerald-600'
                : datum.changePct < 0
                  ? 'text-rose-600'
                  : 'text-muted-foreground',
          )}
        >
          {datum.changePct === null ? 'no prior-day data' : formatChangePct(datum.changePct)}
        </span>
      </div>
    </div>
  );
}

export function GoldenReportScoreTrendChart({ points }: { points: GoldenReportScoreDayPoint[] }) {
  return (
    <ChartContainer className="h-72 w-full" config={chartConfig}>
      <LineChart data={points} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          axisLine={false}
          dataKey="date"
          interval="preserveStartEnd"
          tickFormatter={formatDayLabel}
          tickLine={false}
          tickMargin={8}
        />
        <YAxis
          axisLine={false}
          domain={[0, 100]}
          tickLine={false}
          tickMargin={8}
          width={32}
        />
        {/* Shaded band = a day with no scored golden-set run (see tooltip). */}
        {points
          .filter((point) => point.score === null)
          .map((point) => (
            <ReferenceArea
              fill="rgb(148 163 184)"
              fillOpacity={0.12}
              key={point.date}
              x1={point.date}
              x2={point.date}
            />
          ))}
        <ChartTooltip content={<GoldenReportScoreTooltip />} />
        <Line
          activeDot={{ r: 5 }}
          connectNulls
          dataKey="score"
          dot={{ r: 3 }}
          // Recharts' path-draw-in animation stalls after the first sub-path when connectNulls
          // has to bridge an actual gap in the data — the fix is to skip the animation, not the
          // connect.
          isAnimationActive={false}
          stroke="var(--color-score)"
          strokeWidth={2}
          type="monotone"
        />
      </LineChart>
    </ChartContainer>
  );
}
