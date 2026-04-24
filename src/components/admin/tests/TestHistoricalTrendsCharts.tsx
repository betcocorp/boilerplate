'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import {
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type TrendRun = {
  avgSimilarity: number | null;
  startedAtLabel: string;
  passRate: number;
  elapsedSeconds: number;
  status: string;
};

type TestHistoricalTrendsChartsProps = {
  runs: TrendRun[];
};

/** Matches `h-56` — explicit px avoids ResponsiveContainer measuring `-1` in CSS grid. */
const CHART_HEIGHT_PX = 224;

const STATUS_COLORS = ['#16a34a', '#0ea5e9', '#f59e0b', '#ef4444', '#6366f1', '#64748b'];

type ChartSize = {
  width: number;
  height: number;
};

function ChartFrame({
  className,
  children,
}: {
  className: string;
  children: (size: ChartSize) => ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<ChartSize>({ width: 0, height: 0 });

  useEffect(() => {
    const element = containerRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const nextWidth = Math.max(0, Math.floor(element.clientWidth));
      const nextHeight = Math.max(0, Math.floor(element.clientHeight));
      setSize({ width: nextWidth, height: nextHeight });
    };

    updateSize();
    const observer = new ResizeObserver(() => {
      updateSize();
    });
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <div className={className} ref={containerRef}>
      {size.width > 0 && size.height > 0 ? children(size) : null}
    </div>
  );
}

function formatElapsedDuration(seconds: number) {
  if (seconds >= 3600) {
    return `${(seconds / 3600).toFixed(1)} h`;
  }

  if (seconds > 60) {
    return `${(seconds / 60).toFixed(1)} m`;
  }

  return `${seconds.toFixed(1)} s`;
}

export function TestHistoricalTrendsCharts({ runs }: TestHistoricalTrendsChartsProps) {
  const statusCounts = runs.reduce<Record<string, number>>((acc, run) => {
    acc[run.status] = (acc[run.status] || 0) + 1;
    return acc;
  }, {});
  const statusData = Object.entries(statusCounts).map(([label, count]) => ({
    label,
    count,
  }));
  const similarityValues = runs
    .map((run) => run.avgSimilarity)
    .filter((value): value is number => typeof value === 'number');
  const overallAvgSimilarity =
    similarityValues.length > 0
      ? similarityValues.reduce((sum, value) => sum + value, 0) /
        similarityValues.length
      : null;

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="mb-5 flex items-end justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900">Historical performance trends</h2>
        <p className="text-xs text-slate-500">Based on the last {runs.length} runs</p>
      </div>
      {runs.length === 0 ? (
        <p className="text-sm text-slate-500">Run the dataset to start seeing trend charts.</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2 xl:grid-cols-4">
          <article className="min-w-0 rounded-2xl border border-slate-200 p-5">
            <h3 className="text-sm font-semibold text-slate-900">Pass rate trend</h3>
            <p className="mt-1 text-xs text-slate-500">
              Newest: {runs[runs.length - 1]?.passRate.toFixed(1)}%
            </p>
            <ChartFrame className="mt-4 h-56 min-w-0">
              {({ height, width }) => (
                <LineChart data={runs} height={height} width={width}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="startedAtLabel" tick={{ fontSize: 11 }} />
                  <YAxis
                    domain={[0, 100]}
                    tick={{ fontSize: 11 }}
                    tickFormatter={(value) => `${value}%`}
                  />
                  <Tooltip
                    formatter={(value) =>
                      typeof value === 'number' ? `${value.toFixed(1)}%` : `${value ?? ''}`
                    }
                    labelFormatter={(label) => `Run date: ${label}`}
                  />
                  <Line
                    dataKey="passRate"
                    dot={false}
                    stroke="#16a34a"
                    strokeWidth={2}
                    type="monotone"
                  />
                </LineChart>
              )}
            </ChartFrame>
          </article>

          <article className="min-w-0 rounded-2xl border border-slate-200 p-5">
            <h3 className="text-sm font-semibold text-slate-900">Runtime trend</h3>
            <p className="mt-1 text-xs text-slate-500">
              Newest:{' '}
              {runs[runs.length - 1]
                ? formatElapsedDuration(runs[runs.length - 1].elapsedSeconds)
                : 'n/a'}
            </p>
            <ChartFrame className="mt-4 h-56 min-w-0">
              {({ height, width }) => (
                <LineChart data={runs} height={height} width={width}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="startedAtLabel" tick={{ fontSize: 11 }} />
                  <YAxis
                    tick={{ fontSize: 11 }}
                    tickFormatter={(value) =>
                      typeof value === 'number'
                        ? formatElapsedDuration(value)
                        : `${value ?? ''}`
                    }
                  />
                  <Tooltip
                    formatter={(value) =>
                      typeof value === 'number'
                        ? formatElapsedDuration(value)
                        : `${value ?? ''}`
                    }
                    labelFormatter={(label) => `Run date: ${label}`}
                  />
                  <Line
                    dataKey="elapsedSeconds"
                    dot={false}
                    stroke="#0ea5e9"
                    strokeWidth={2}
                    type="monotone"
                  />
                </LineChart>
              )}
            </ChartFrame>
          </article>

          <article className="min-w-0 rounded-2xl border border-slate-200 p-5">
            <h3 className="text-sm font-semibold text-slate-900">Run status mix</h3>
            <ChartFrame className="mt-4 h-56 min-w-0">
              {({ height, width }) => (
                <PieChart height={height} width={width}>
                  <Pie
                    cx="50%"
                    cy="50%"
                    data={statusData}
                    dataKey="count"
                    innerRadius={45}
                    nameKey="label"
                    outerRadius={78}
                  >
                    {statusData.map((entry, index) => (
                      <Cell
                        fill={STATUS_COLORS[index % STATUS_COLORS.length]}
                        key={`${entry.label}-${index}`}
                      />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              )}
            </ChartFrame>
          </article>

          <article className="min-w-0 rounded-2xl border border-slate-200 p-5">
            <h3 className="text-sm font-semibold text-slate-900">
              Average similarity trend
            </h3>
            <p className="mt-1 text-xs text-slate-500">
              Avg over all runs:{' '}
              {typeof overallAvgSimilarity === 'number'
                ? `${(overallAvgSimilarity * 100).toFixed(1)}%`
                : 'n/a'}
            </p>
            <ChartFrame className="mt-4 h-56 min-w-0">
              {({ height, width }) => (
                <LineChart data={runs} height={height} width={width}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="startedAtLabel" tick={{ fontSize: 11 }} />
                  <YAxis
                    domain={[0, 1]}
                    tick={{ fontSize: 11 }}
                    tickFormatter={(value) =>
                      typeof value === 'number'
                        ? `${(value * 100).toFixed(0)}%`
                        : `${value ?? ''}`
                    }
                  />
                  <Tooltip
                    formatter={(value) =>
                      typeof value === 'number'
                        ? `${(value * 100).toFixed(1)}%`
                        : 'n/a'
                    }
                    labelFormatter={(label) => `Run date: ${label}`}
                  />
                  <Line
                    dataKey="avgSimilarity"
                    dot={false}
                    stroke="#a855f7"
                    strokeWidth={2}
                    type="monotone"
                  />
                </LineChart>
              )}
            </ChartFrame>
          </article>
        </div>
      )}
    </section>
  );
}
