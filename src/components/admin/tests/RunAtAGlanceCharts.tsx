'use client';

import { type MouseEvent, useMemo } from 'react';
import type { ActiveDotProps, DotItemDotProps } from 'recharts';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  XAxis,
  YAxis,
} from 'recharts';

import {
  type ChartConfig,
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart';
import { cn } from '~/lib/utils';

type ElapsedTrendDatum = {
  label: string;
  elapsedSeconds: number;
  /** Seconds to first streamed token/chunk; null for legacy rows or no observed delta. */
  ttftSeconds: number | null;
  /** When omitted, dot renders neutral (e.g. stale client data). */
  passed?: boolean;
  /** Links chart point → `run-item-result-${id}` row on the run details page */
  resultItemId?: string;
};

type SimilarityTrendDatum = {
  label: string;
  /** null when the item has no similarity score */
  similarity: number | null;
  passed?: boolean;
  resultItemId?: string;
};

type SimilarityStatDatum = {
  label: string;
  value: number;
};

type SimilarityBuckets = {
  high: number;
  mid: number;
  low: number;
  avgThreshold: number;
  minThreshold: number;
  maxThreshold: number;
};

type RunAtAGlanceChartsProps = {
  elapsedTrendData: ElapsedTrendDatum[];
  similarityTrendData: SimilarityTrendDatum[];
  similarityStatsData: SimilarityStatDatum[];
  similarityBuckets: SimilarityBuckets;
};

const chartConfig = {
  elapsedSeconds: { label: 'Elapsed', color: '#0ea5e9' },
  ttftSeconds: { label: 'Time to first token', color: '#f59e0b' },
  similarity: { label: 'Similarity', color: '#a855f7' },
  count: { label: 'Count', color: '#16a34a' },
  value: { label: 'Similarity', color: '#a855f7' },
} satisfies ChartConfig;

function scrollToRunItemRow(resultItemId: string) {
  const el = document.getElementById(`run-item-result-${resultItemId}`);
  el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function ElapsedTrendDatumDotSvg(
  dotProps: ActiveDotProps | DotItemDotProps,
  variant: 'idle' | 'active',
) {
  const cx = dotProps.cx as number | undefined;
  const cy = dotProps.cy as number | undefined;
  const payload = dotProps.payload as ElapsedTrendDatum | undefined;
  const id = payload?.resultItemId;

  if (cx == null || cy == null || Number.isNaN(cx) || Number.isNaN(cy) || !id) {
    return null;
  }

  const rawR = dotProps.r;
  const r =
    typeof rawR === 'number' && Number.isFinite(rawR)
      ? rawR
      : typeof rawR === 'string'
        ? Number.parseFloat(rawR)
        : 5;
  const radius = typeof r === 'number' && Number.isFinite(r) ? r : 5;

  /* Larger invisible target so hover works before the visible dot appears */
  const hitRadius = Math.max(radius + 10, 14);

  const outcome =
    payload?.passed === true
      ? 'passed'
      : payload?.passed === false
        ? 'failed'
        : 'unknown';
  const dotFill =
    payload?.passed === true
      ? '#16a34a'
      : payload?.passed === false
        ? '#dc2626'
        : '#94a3b8';
  const label = `Scroll to item ${payload?.label ?? ''} in Item-level results (${outcome})`;

  const visibleOpacity =
    variant === 'active'
      ? 'opacity-100'
      : 'opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100';

  return (
    <g aria-label={label} className={cn('group outline-none')}>
      <circle
        className={cn(id ? 'cursor-pointer' : undefined)}
        cx={cx}
        cy={cy}
        fill="transparent"
        pointerEvents="auto"
        r={hitRadius}
        onClick={(event: MouseEvent<SVGCircleElement>) => {
          if (!id) {
            return;
          }
          event.stopPropagation();
          scrollToRunItemRow(id);
        }}
      />
      <circle
        className={cn('stroke-white pointer-events-none', visibleOpacity)}
        cx={cx}
        cy={cy}
        fill={dotFill}
        pointerEvents="none"
        r={radius}
        strokeWidth={1}
      />
    </g>
  );
}

/** Normal points — Recharts passes {@link DotItemDotProps}. */
function ElapsedTrendDatumDot(dotProps: DotItemDotProps) {
  return ElapsedTrendDatumDotSvg(dotProps, 'idle');
}

/**
 * Tooltip/active point — keep the marker visible so it does not flash hidden during chart hover.
 */
function ElapsedTrendActiveDatumDot(dotProps: ActiveDotProps) {
  return ElapsedTrendDatumDotSvg(dotProps, 'active');
}

export function RunAtAGlanceCharts({
  elapsedTrendData,
  similarityTrendData,
  similarityStatsData,
  similarityBuckets,
}: RunAtAGlanceChartsProps) {
  const similarityCoverageData = useMemo(() => {
    const withScore = similarityTrendData.filter(
      (d) => d.similarity !== null,
    ).length;
    const withoutScore = similarityTrendData.length - withScore;
    return [
      { label: 'Had similarity', count: withScore, fill: '#a855f7' },
      { label: 'No similarity', count: withoutScore, fill: '#cbd5e1' },
    ];
  }, [similarityTrendData]);
  const similarityCoverageRate = useMemo(() => {
    if (similarityTrendData.length === 0) return 0;
    return (
      (similarityCoverageData[0]!.count / similarityTrendData.length) * 100
    );
  }, [similarityTrendData, similarityCoverageData]);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">
        At-a-glance charts
      </h2>
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-4">
        <article className="min-w-0 rounded-2xl border border-slate-200 p-5 col-span-4">
          <h3 className="text-sm font-semibold text-slate-900">
            Elapsed by prompt order (seconds)
          </h3>
          {elapsedTrendData.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              No item timings yet for this run.
            </p>
          ) : (
            <ChartContainer
              className="mt-4 h-56 w-full min-w-0"
              config={chartConfig}
            >
              <LineChart data={elapsedTrendData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  interval={0}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(value, index) =>
                    typeof index === 'number'
                      ? index % 10 === 0
                        ? `${index}`
                        : ''
                      : value
                  }
                />
                <YAxis
                  tick={{ fontSize: 11 }}
                  tickFormatter={(value) => `${value}s`}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) =>
                        typeof value === 'number' && Number.isFinite(value)
                          ? `${value.toFixed(2)} s`
                          : 'n/a'
                      }
                    />
                  }
                />
                <ChartLegend content={<ChartLegendContent />} />
                <Line
                  activeDot={ElapsedTrendActiveDatumDot}
                  dataKey="elapsedSeconds"
                  dot={ElapsedTrendDatumDot}
                  stroke="var(--color-elapsedSeconds)"
                  strokeWidth={2}
                  type="monotone"
                />
                <Line
                  dataKey="ttftSeconds"
                  stroke="var(--color-ttftSeconds)"
                  strokeWidth={2}
                  type="monotone"
                  dot={false}
                  connectNulls
                  activeDot={{ r: 4 }}
                />
              </LineChart>
            </ChartContainer>
          )}
        </article>

        <article className="min-w-0 rounded-2xl border border-slate-200 p-5 col-span-4">
          <h3 className="text-sm font-semibold text-slate-900">
            Similarity by prompt order
          </h3>
          {similarityTrendData.length === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              No similarity scores yet for this run.
            </p>
          ) : (
            <ChartContainer
              className="mt-4 h-56 w-full min-w-0"
              config={chartConfig}
            >
              <LineChart data={similarityTrendData}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="label"
                  interval={0}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(value, index) =>
                    typeof index === 'number'
                      ? index % 10 === 0
                        ? `${index}`
                        : ''
                      : value
                  }
                />
                <YAxis
                  domain={[0, 1]}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(value) => `${(value * 100).toFixed(0)}%`}
                />
                <ChartTooltip
                  content={
                    <ChartTooltipContent
                      formatter={(value) =>
                        typeof value === 'number' && Number.isFinite(value)
                          ? `${(value * 100).toFixed(2)}%`
                          : 'n/a'
                      }
                    />
                  }
                />
                <Line
                  activeDot={ElapsedTrendActiveDatumDot}
                  connectNulls={false}
                  dataKey="similarity"
                  dot={ElapsedTrendDatumDot}
                  stroke="var(--color-similarity)"
                  strokeWidth={2}
                  type="monotone"
                />
              </LineChart>
            </ChartContainer>
          )}
        </article>

        <article className="min-w-0 rounded-2xl border border-slate-200 p-5 col-span-4 lg:col-span-2">
          <h3 className="text-sm font-semibold text-slate-900">
            Similarity coverage
          </h3>
          <ChartContainer
            className="mt-4 h-56 w-full min-w-0"
            config={chartConfig}
          >
            <PieChart>
              <Pie
                cx="50%"
                cy="50%"
                data={similarityCoverageData}
                dataKey="count"
                innerRadius={50}
                nameKey="label"
                outerRadius={82}
              >
                {similarityCoverageData.map((entry) => (
                  <Cell fill={entry.fill} key={entry.label} />
                ))}
              </Pie>
              <ChartTooltip content={<ChartTooltipContent />} />
            </PieChart>
          </ChartContainer>
          <p className="mt-2 text-xs text-slate-500">
            {similarityCoverageData[0]!.count} of {similarityTrendData.length}{' '}
            items returned a similarity score (
            {similarityCoverageRate.toFixed(1)}%).
          </p>
        </article>

        <article className="min-w-0 rounded-2xl border border-slate-200 p-5 col-span-4 lg:col-span-2">
          <h3 className="text-sm font-semibold text-slate-900">
            Similarity stats
          </h3>
          <ChartContainer
            className="mt-4 h-56 w-full min-w-0"
            config={chartConfig}
          >
            <BarChart data={similarityStatsData}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="label" interval={0} tick={{ fontSize: 11 }} />
              <YAxis
                domain={[0, 1]}
                tick={{ fontSize: 11 }}
                tickFormatter={(value) => `${(value * 100).toFixed(0)}%`}
              />
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    formatter={(value) =>
                      typeof value === 'number'
                        ? `${(value * 100).toFixed(2)}%`
                        : 'n/a'
                    }
                  />
                }
              />
              <Bar
                dataKey="value"
                fill="var(--color-value)"
                radius={[8, 8, 0, 0]}
              />
            </BarChart>
          </ChartContainer>
          <dl className="mt-2 flex gap-4 text-xs text-slate-500">
            <div className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-full bg-violet-500" />
              <dt>
                High ({(similarityBuckets.avgThreshold * 100).toFixed(0)}%–
                {(similarityBuckets.maxThreshold * 100).toFixed(0)}%)
              </dt>
              <dd className="font-medium text-slate-700">
                {similarityBuckets.high}
              </dd>
            </div>
            <div className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-full bg-violet-300" />
              <dt>
                Mid ({(similarityBuckets.minThreshold * 100).toFixed(0)}%–
                {(similarityBuckets.avgThreshold * 100).toFixed(0)}%)
              </dt>
              <dd className="font-medium text-slate-700">
                {similarityBuckets.mid}
              </dd>
            </div>
            <div className="flex items-center gap-1">
              <span className="inline-block size-2 rounded-full bg-slate-300" />
              <dt>
                Low (0%–{(similarityBuckets.minThreshold * 100).toFixed(0)}%)
              </dt>
              <dd className="font-medium text-slate-700">
                {similarityBuckets.low}
              </dd>
            </div>
          </dl>
        </article>
      </div>
    </section>
  );
}
