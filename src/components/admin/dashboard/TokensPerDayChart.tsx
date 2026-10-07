'use client';

/**
 * B0-583 — client half of the "Tokens per day" panel: one stacked bar per EST day, split
 * prompt (uncached) / cached prompt / completion. `cached` is carved OUT of the prompt segment
 * (prompt − cached), so a bar's height is the day's true total tokens with no double counting.
 *
 * Days with no cost-tracked runs are rendered as shaded empty slots (ReferenceArea band) rather
 * than invisible zero-height bars, so "no runs" reads differently from "low volume"; the custom
 * tooltip states the same distinction.
 */

import {
  Bar,
  BarChart,
  CartesianGrid,
  ReferenceArea,
  XAxis,
  YAxis,
} from 'recharts';

import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  type ChartConfig,
} from '~/components/ui/chart';

export type TokensPerDayDatum = {
  /** EST day, `YYYY-MM-DD`. */
  day: string;
  /** `prompt_tokens − cached_prompt_tokens`, clamped at 0. */
  promptUncached: number;
  /** `cached_prompt_tokens`. */
  cached: number;
  /** `completion_tokens`. */
  completion: number;
  /** True when `cost_by_model_per_day` has no row for this day — an empty slot, not low volume. */
  noRuns: boolean;
};

const chartConfig: ChartConfig = {
  promptUncached: { label: 'Prompt (uncached)', color: 'rgb(37 99 235)' },
  cached: { label: 'Cached prompt', color: 'rgb(139 92 246)' },
  completion: { label: 'Completion', color: 'rgb(16 185 129)' },
};

const SERIES_KEYS = ['promptUncached', 'cached', 'completion'] as const;

const integerFormatter = new Intl.NumberFormat('en-US');
const compactFormatter = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

function formatDayLabel(day: string): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime())
    ? day
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'EST' });
}

type TooltipPayloadEntry = {
  dataKey?: string | number;
  value?: number | string;
  color?: string;
  payload?: TokensPerDayDatum;
};

/** Custom tooltip so a no-run day says so explicitly instead of showing three zero rows. */
function TokensTooltip({
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

  if (datum?.noRuns) {
    return (
      <div className="rounded-lg border border-border/60 bg-background px-3 py-2 text-xs shadow-sm">
        <p className="font-medium">{formatDayLabel(day)}</p>
        <p className="mt-1 text-muted-foreground">
          No runs recorded — empty slot, not low volume.
        </p>
      </div>
    );
  }

  const total = datum ? datum.promptUncached + datum.cached + datum.completion : 0;

  return (
    <div className="rounded-lg border border-border/60 bg-background px-3 py-2 text-xs shadow-sm">
      <p className="mb-1 font-medium">{formatDayLabel(day)}</p>
      <div className="space-y-1">
        {payload
          .filter((entry) => SERIES_KEYS.includes(entry.dataKey as (typeof SERIES_KEYS)[number]))
          .map((entry) => {
            const key = String(entry.dataKey);
            return (
              <div className="flex items-center justify-between gap-3" key={key}>
                <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                  <span
                    className="inline-block h-2 w-2 rounded-full"
                    style={{ backgroundColor: entry.color ?? `var(--color-${key})` }}
                  />
                  {chartConfig[key]?.label ?? key}
                </span>
                <span className="font-medium text-foreground">
                  {integerFormatter.format(Number(entry.value ?? 0))}
                </span>
              </div>
            );
          })}
        <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-1">
          <span className="text-muted-foreground">Total</span>
          <span className="font-medium text-foreground">{integerFormatter.format(total)}</span>
        </div>
      </div>
    </div>
  );
}

export function TokensPerDayChart({ data }: { data: TokensPerDayDatum[] }) {
  return (
    <ChartContainer className="h-72 w-full" config={chartConfig}>
      <BarChart data={data} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis
          axisLine={false}
          dataKey="day"
          interval="preserveStartEnd"
          tickFormatter={formatDayLabel}
          tickLine={false}
          tickMargin={8}
        />
        <YAxis
          axisLine={false}
          tickFormatter={(value: number) => compactFormatter.format(value)}
          tickLine={false}
          tickMargin={8}
          width={56}
        />
        {/* Shaded band = a day with no cost-tracked runs (see tooltip/footer). */}
        {data
          .filter((datum) => datum.noRuns)
          .map((datum) => (
            <ReferenceArea
              fill="rgb(148 163 184)"
              fillOpacity={0.12}
              key={datum.day}
              x1={datum.day}
              x2={datum.day}
            />
          ))}
        <ChartTooltip content={<TokensTooltip />} />
        <ChartLegend content={<ChartLegendContent />} />
        <Bar dataKey="promptUncached" fill="var(--color-promptUncached)" stackId="tokens" />
        <Bar dataKey="cached" fill="var(--color-cached)" stackId="tokens" />
        <Bar dataKey="completion" fill="var(--color-completion)" stackId="tokens" />
      </BarChart>
    </ChartContainer>
  );
}
