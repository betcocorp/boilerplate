'use client';

import { useMemo } from 'react';
import {
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
  ChartContainer,
  type ChartConfig,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
} from '~/components/ui/chart';
import { formatSimilarityValue } from '~/lib/tests/format';
import { formatDurationSeconds } from '~/lib/utils/time';

export type SimilarityTrendPoint = {
  /** Short axis label, e.g. "Apr 28, 2:15 PM". */
  label: string;
  /** Source run id (kept for future drill-throughs). */
  runId: string;
  min: number | null;
  max: number | null;
  avg: number | null;
};

export type ElapsedTrendPoint = {
  label: string;
  runId: string;
  /** Seconds (null when no `timingBreakdown.searchMs` was recorded). */
  ragSeconds: number | null;
  /** Seconds (null when the run did not record an elapsed value). */
  promptSeconds: number | null;
  /** Seconds to first streamed token/chunk; null for legacy rows or no observed delta. */
  ttftSeconds: number | null;
};

type ItemAtAGlanceChartsProps = {
  /** Total runs of this prompt that produced a recorded outcome (passed or failed). */
  runCount: number;
  passCount: number;
  failCount: number;
  /** Mean of the per-run similarity min/max/avg across runs that recorded similarity. */
  similarityAverages: {
    avgMin: number;
    avgMax: number;
    avgAvg: number;
    sampleSize: number;
  } | null;
  /** Mean RAG search time in ms across runs that recorded `timingBreakdown.searchMs`. */
  avgRagSearchMs: number | null;
  ragSampleSize: number;
  /** Mean wall-clock prompt elapsed time across all aggregated runs. */
  avgPromptElapsedMs: number | null;
  promptSampleSize: number;
  /** Per-run similarity values, ordered oldest → newest. */
  similarityTrend: SimilarityTrendPoint[];
  /** Per-run RAG / prompt elapsed times, ordered oldest → newest. */
  elapsedTrend: ElapsedTrendPoint[];
};

const chartConfig = {
  count: { label: 'Count', color: '#16a34a' },
  min: { label: 'Min', color: '#0ea5e9' },
  max: { label: 'Max', color: '#dc2626' },
  avg: { label: 'Avg', color: '#a855f7' },
  ragSeconds: { label: 'RAG search', color: '#0ea5e9' },
  promptSeconds: { label: 'Total prompt', color: '#a855f7' },
  ttftSeconds: { label: 'Time to first token', color: '#f59e0b' },
} satisfies ChartConfig;

function formatSecondsValue(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${value.toFixed(2)} s`
    : 'n/a';
}

export function ItemAtAGlanceCharts({
  runCount,
  passCount,
  failCount,
  similarityAverages,
  avgRagSearchMs,
  ragSampleSize,
  avgPromptElapsedMs,
  promptSampleSize,
  similarityTrend,
  elapsedTrend,
}: ItemAtAGlanceChartsProps) {
  const passFailData = useMemo(
    () => [
      { label: 'Pass', count: passCount, fill: '#16a34a' },
      { label: 'Fail', count: failCount, fill: '#dc2626' },
    ],
    [passCount, failCount],
  );
  const passRatePercent = useMemo(
    () => (runCount > 0 ? (passCount / runCount) * 100 : 0),
    [passCount, runCount],
  );

  const hasSimilarityTrend = useMemo(
    () =>
      similarityTrend.some(
        (point) =>
          typeof point.min === 'number' ||
          typeof point.max === 'number' ||
          typeof point.avg === 'number',
      ),
    [similarityTrend],
  );
  const hasElapsedTrend = useMemo(
    () =>
      elapsedTrend.some(
        (point) =>
          typeof point.ragSeconds === 'number' ||
          typeof point.promptSeconds === 'number' ||
          typeof point.ttftSeconds === 'number',
      ),
    [elapsedTrend],
  );

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold text-slate-900">
          At-a-glance charts
        </h2>
        <p className="text-xs text-slate-500">
          Aggregated over {runCount} historical run{runCount === 1 ? '' : 's'} of
          this prompt.
        </p>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <article className="min-w-0 rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900">Pass vs fail</h3>
          {runCount === 0 ? (
            <p className="mt-4 text-sm text-slate-500">
              No completed runs of this prompt yet.
            </p>
          ) : (
            <>
              <ChartContainer
                className="mt-4 h-56 w-full min-w-0"
                config={chartConfig}
              >
                <PieChart>
                  <Pie
                    cx="50%"
                    cy="50%"
                    data={passFailData}
                    dataKey="count"
                    innerRadius={50}
                    nameKey="label"
                    outerRadius={82}
                  >
                    {passFailData.map((entry) => (
                      <Cell fill={entry.fill} key={entry.label} />
                    ))}
                  </Pie>
                  <ChartTooltip content={<ChartTooltipContent />} />
                </PieChart>
              </ChartContainer>
              <p className="mt-2 text-xs text-slate-500">
                Pass rate: {passRatePercent.toFixed(1)}% ({passCount} of{' '}
                {runCount})
              </p>
            </>
          )}
        </article>

        <article className="min-w-0 rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Similarity trend (per-run min / max / avg)
          </h3>
          {!hasSimilarityTrend ? (
            <p className="mt-4 text-sm text-slate-500">
              No retrieval similarity scores recorded for this prompt yet.
            </p>
          ) : (
            <>
              <ChartContainer
                className="mt-4 h-56 w-full min-w-0"
                config={chartConfig}
              >
                <LineChart data={similarityTrend}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="label"
                    interval="preserveStartEnd"
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    domain={[0, 1]}
                    tick={{ fontSize: 11 }}
                    tickFormatter={(value) =>
                      typeof value === 'number'
                        ? `${(value * 100).toFixed(0)}%`
                        : `${value ?? ''}`
                    }
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(label) => `Run: ${label}`}
                        formatter={(value) => formatSimilarityValue(typeof value === 'number' ? value : null)}
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Line
                    connectNulls
                    dataKey="min"
                    dot={false}
                    stroke="var(--color-min)"
                    strokeWidth={2}
                    type="monotone"
                  />
                  <Line
                    connectNulls
                    dataKey="max"
                    dot={false}
                    stroke="var(--color-max)"
                    strokeWidth={2}
                    type="monotone"
                  />
                  <Line
                    connectNulls
                    dataKey="avg"
                    dot={false}
                    stroke="var(--color-avg)"
                    strokeWidth={2}
                    type="monotone"
                  />
                </LineChart>
              </ChartContainer>
              {similarityAverages ? (
                <p className="mt-2 text-xs text-slate-500">
                  Avg of avg: {(similarityAverages.avgAvg * 100).toFixed(1)}% ·
                  Avg max: {(similarityAverages.avgMax * 100).toFixed(1)}% · Avg
                  min: {(similarityAverages.avgMin * 100).toFixed(1)}% (
                  {similarityAverages.sampleSize} run
                  {similarityAverages.sampleSize === 1 ? '' : 's'} with scores)
                </p>
              ) : null}
            </>
          )}
        </article>

        <article className="min-w-0 rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Elapsed time trend (RAG vs total prompt)
          </h3>
          {!hasElapsedTrend ? (
            <p className="mt-4 text-sm text-slate-500">
              No timing data recorded for this prompt yet.
            </p>
          ) : (
            <>
              <ChartContainer
                className="mt-4 h-56 w-full min-w-0"
                config={chartConfig}
              >
                <LineChart data={elapsedTrend}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="label"
                    interval="preserveStartEnd"
                    tick={{ fontSize: 11 }}
                  />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickFormatter={(value) =>
                      typeof value === 'number' ? `${value}s` : `${value ?? ''}`
                    }
                  />
                  <ChartTooltip
                    content={
                      <ChartTooltipContent
                        labelFormatter={(label) => `Run: ${label}`}
                        formatter={formatSecondsValue}
                      />
                    }
                  />
                  <ChartLegend content={<ChartLegendContent />} />
                  <Line
                    connectNulls
                    dataKey="ragSeconds"
                    dot={false}
                    stroke="var(--color-ragSeconds)"
                    strokeWidth={2}
                    type="monotone"
                  />
                  <Line
                    connectNulls
                    dataKey="promptSeconds"
                    dot={false}
                    stroke="var(--color-promptSeconds)"
                    strokeWidth={2}
                    type="monotone"
                  />
                  <Line
                    connectNulls
                    dataKey="ttftSeconds"
                    dot={false}
                    stroke="var(--color-ttftSeconds)"
                    strokeWidth={2}
                    type="monotone"
                  />
                </LineChart>
              </ChartContainer>
              <p className="mt-2 text-xs text-slate-500">
                Avg RAG search: {formatDurationSeconds(avgRagSearchMs)} ·{' '}
                {ragSampleSize} sample{ragSampleSize === 1 ? '' : 's'} · Avg
                total prompt: {formatDurationSeconds(avgPromptElapsedMs)} ·{' '}
                {promptSampleSize} sample{promptSampleSize === 1 ? '' : 's'}
              </p>
            </>
          )}
        </article>
      </div>
    </section>
  );
}
