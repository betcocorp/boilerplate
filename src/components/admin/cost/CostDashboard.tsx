'use client';

import { useMemo, useState, useTransition } from 'react';
import { Bar, BarChart, CartesianGrid, Legend, XAxis, YAxis } from 'recharts';

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '~/components/ui/card';
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from '~/components/ui/chart';
import { Switch } from '~/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group';
import type {
  CostGroupBy,
  CostMetricsResult,
  CostTimeRange,
} from '~/lib/observability/cost-metrics';
import { COST_TIME_RANGES } from '~/lib/observability/cost-metrics';

const TIME_RANGE_LABELS: Record<CostTimeRange, string> = {
  '1d': '1D',
  '1w': '1W',
  '1m': '1M',
  '3m': '3M',
  '6m': '6M',
  '1y': '1Y',
};

/** 3m+ produces too many daily points to read; bucket those ranges by month instead. */
function defaultGroupByFor(timeRange: CostTimeRange): CostGroupBy {
  return timeRange === '3m' || timeRange === '6m' || timeRange === '1y' ? 'month' : 'day';
}

const MODEL_COLORS = [
  'rgb(37 99 235)',
  'rgb(16 185 129)',
  'rgb(217 119 6)',
  'rgb(139 92 246)',
  'rgb(220 38 38)',
];

const currencyFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

const integerFormatter = new Intl.NumberFormat('en-US');

function formatBucketLabel(bucket: string, groupBy: CostGroupBy): string {
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) {
    return bucket;
  }
  return groupBy === 'month'
    ? date.toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function buildChartData(metrics: CostMetricsResult) {
  const byBucket = new Map<string, Record<string, number | string>>();
  for (const point of metrics.points) {
    const row = byBucket.get(point.bucket) ?? { bucket: point.bucket };
    row[point.modelId] = point.estimatedCostUsd;
    byBucket.set(point.bucket, row);
  }
  return [...byBucket.values()].sort((a, b) =>
    String(a.bucket).localeCompare(String(b.bucket)),
  );
}

function buildChartConfig(metrics: CostMetricsResult): ChartConfig {
  const modelIds = [...new Set(metrics.points.map((p) => p.modelId))].sort();
  const config: ChartConfig = {};
  modelIds.forEach((modelId, index) => {
    config[modelId] = { label: modelId, color: MODEL_COLORS[index % MODEL_COLORS.length] };
  });
  return config;
}

function summarize(metrics: CostMetricsResult) {
  let totalCostUsd = 0;
  let totalTokens = 0;
  const byModel = new Map<string, { costUsd: number; tokens: number }>();

  for (const point of metrics.points) {
    totalCostUsd += point.estimatedCostUsd;
    totalTokens += point.totalTokens;
    const existing = byModel.get(point.modelId) ?? { costUsd: 0, tokens: 0 };
    existing.costUsd += point.estimatedCostUsd;
    existing.tokens += point.totalTokens;
    byModel.set(point.modelId, existing);
  }

  return {
    totalCostUsd,
    totalTokens,
    byModel: [...byModel.entries()]
      .map(([modelId, v]) => ({ modelId, ...v }))
      .sort((a, b) => b.costUsd - a.costUsd),
  };
}

async function fetchMetrics(params: {
  timeRange: CostTimeRange;
  groupBy: CostGroupBy;
  compareYoY: boolean;
}): Promise<CostMetricsResult> {
  const search = new URLSearchParams({
    timeRange: params.timeRange,
    groupBy: params.groupBy,
    compareYoY: String(params.compareYoY),
  });
  const res = await fetch(`/api/bex/cost/metrics?${search.toString()}`);
  if (!res.ok) {
    throw new Error(`Failed to load cost metrics (${res.status})`);
  }
  const body = (await res.json()) as { ok: true; metrics: CostMetricsResult } | { error: string };
  if ('error' in body) {
    throw new Error(body.error);
  }
  return body.metrics;
}

export function CostDashboard({ initial }: { initial: CostMetricsResult }) {
  const [metrics, setMetrics] = useState(initial);
  const [timeRange, setTimeRange] = useState<CostTimeRange>(initial.timeRange);
  const [compareYoY, setCompareYoY] = useState(initial.yoy !== null);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const chartData = useMemo(() => buildChartData(metrics), [metrics]);
  const chartConfig = useMemo(() => buildChartConfig(metrics), [metrics]);
  const summary = useMemo(() => summarize(metrics), [metrics]);

  function refetch(next: { timeRange: CostTimeRange; compareYoY: boolean }) {
    startTransition(async () => {
      try {
        const groupBy = defaultGroupByFor(next.timeRange);
        const result = await fetchMetrics({ ...next, groupBy });
        setMetrics(result);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load cost metrics.');
      }
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <ToggleGroup
          type="single"
          variant="outline"
          value={timeRange}
          onValueChange={(value) => {
            if (!value) return;
            const next = value as CostTimeRange;
            setTimeRange(next);
            refetch({ timeRange: next, compareYoY });
          }}
        >
          {COST_TIME_RANGES.map((range) => (
            <ToggleGroupItem key={range} value={range} aria-label={TIME_RANGE_LABELS[range]}>
              {TIME_RANGE_LABELS[range]}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <Switch
            checked={compareYoY}
            onCheckedChange={(checked) => {
              setCompareYoY(checked);
              refetch({ timeRange, compareYoY: checked });
            }}
          />
          Compare year-over-year
        </label>
      </div>

      {error && (
        <p className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader>
            <CardDescription>Total cost</CardDescription>
            <CardTitle className="text-2xl">
              {currencyFormatter.format(summary.totalCostUsd)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Total tokens</CardDescription>
            <CardTitle className="text-2xl">
              {integerFormatter.format(summary.totalTokens)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>Runs covered</CardDescription>
            <CardTitle className="text-2xl">
              {integerFormatter.format(metrics.runCount)}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader>
            <CardDescription>By model</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-1 text-sm">
            {summary.byModel.length === 0 ? (
              <span className="text-muted-foreground">No data for this range</span>
            ) : (
              summary.byModel.map((m) => (
                <div key={m.modelId} className="flex items-center justify-between gap-4">
                  <span className="text-muted-foreground">{m.modelId}</span>
                  <span>{currencyFormatter.format(m.costUsd)}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <div className="rounded-3xl border border-border/60 p-4">
        <p className="mb-2 text-sm font-medium">
          Estimated cost by model ({metrics.groupBy === 'month' ? 'monthly' : 'daily'})
        </p>
        <ChartContainer className={`h-72 w-full ${isPending ? 'opacity-60' : ''}`} config={chartConfig}>
          <BarChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="bucket"
              tickFormatter={(value: string) => formatBucketLabel(value, metrics.groupBy)}
              tickLine={false}
              axisLine={false}
              tickMargin={8}
            />
            <YAxis tickLine={false} axisLine={false} tickMargin={8} width={64} />
            <ChartTooltip content={<ChartTooltipContent />} />
            <Legend />
            {Object.keys(chartConfig).map((modelId) => (
              <Bar
                key={modelId}
                dataKey={modelId}
                stackId="cost"
                fill={`var(--color-${modelId})`}
              />
            ))}
          </BarChart>
        </ChartContainer>
      </div>

      {compareYoY && (
        <div className="rounded-3xl border border-border/60 p-4">
          <p className="mb-2 text-sm font-medium">Year-over-year comparison</p>
          {!metrics.yoy || metrics.yoy.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No prior-year data in this window.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              {metrics.yoy.map((point) => (
                <div
                  key={`${point.month}-${point.modelId}`}
                  className="flex items-center justify-between gap-4 text-sm"
                >
                  <span className="text-muted-foreground">
                    {formatBucketLabel(point.month, 'month')} · {point.modelId}
                  </span>
                  <span>
                    {currencyFormatter.format(point.currentCostUsd)}
                    {point.priorYearCostUsd !== null && (
                      <span className="ml-2 text-muted-foreground">
                        vs {currencyFormatter.format(point.priorYearCostUsd)}{' '}
                        {point.yoyCostChangePct !== null &&
                          `(${point.yoyCostChangePct >= 0 ? '+' : ''}${(point.yoyCostChangePct * 100).toFixed(1)}%)`}
                      </span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
