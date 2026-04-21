'use client';

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type ElapsedTrendDatum = {
  label: string;
  elapsedSeconds: number;
};

type SimilarityStatDatum = {
  label: string;
  value: number;
};

type RunAtAGlanceChartsProps = {
  runId: string;
  initialStatus: string;
  totalItems: number;
  passCount: number;
  failCount: number;
  slowOverTenSecondsCount: number;
  notPassedItemCount: number;
  elapsedTrendData: ElapsedTrendDatum[];
  similarityStatsData: SimilarityStatDatum[];
};

type RunStatusResponse = {
  ok: boolean;
  runId: string;
  status: string;
  completedItems: number;
  totalItems: number;
  progressPercent: number;
  passedItems: number;
  failedItems: number;
  notRunItems: number;
};

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

export function RunAtAGlanceCharts({
  runId,
  initialStatus,
  totalItems,
  passCount,
  failCount,
  slowOverTenSecondsCount,
  notPassedItemCount,
  elapsedTrendData,
  similarityStatsData,
}: RunAtAGlanceChartsProps) {
  const [liveStatus, setLiveStatus] = useState(initialStatus);
  const [livePassCount, setLivePassCount] = useState(passCount);
  const [liveFailCount, setLiveFailCount] = useState(failCount);
  const [liveNotRunCount, setLiveNotRunCount] = useState(
    Math.max(0, totalItems - passCount - failCount),
  );

  useEffect(() => {
    setLiveStatus(initialStatus);
    setLivePassCount(passCount);
    setLiveFailCount(failCount);
    setLiveNotRunCount(Math.max(0, totalItems - passCount - failCount));
  }, [initialStatus, totalItems, passCount, failCount]);

  useEffect(() => {
    const isTerminalStatus =
      liveStatus === 'completed' ||
      liveStatus === 'completed_with_failures' ||
      liveStatus === 'failed' ||
      liveStatus === 'cancelled';
    if (isTerminalStatus) {
      return;
    }

    const poll = async () => {
      try {
        const response = await fetch(`/api/admin/tests/runs/${runId}`, {
          method: 'GET',
          cache: 'no-store',
        });
        if (!response.ok) {
          return;
        }

        const data = (await response.json()) as RunStatusResponse;
        setLiveStatus(data.status);
        setLivePassCount(data.passedItems);
        setLiveFailCount(data.failedItems);
        setLiveNotRunCount(data.notRunItems);
      } catch {
        // Keep polling during long test runs even if one request fails.
      }
    };

    void poll();
    const intervalId = window.setInterval(() => {
      void poll();
    }, 2000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [runId, liveStatus]);

  const completedCount = livePassCount + liveFailCount;
  const passRate = useMemo(
    () => (completedCount > 0 ? (livePassCount / completedCount) * 100 : 0),
    [completedCount, livePassCount],
  );
  const passFailData = useMemo(
    () => [
      { label: 'Pass', count: livePassCount, fill: '#16a34a' },
      { label: 'Fail', count: liveFailCount, fill: '#dc2626' },
      { label: 'Not run', count: liveNotRunCount, fill: '#94a3b8' },
    ],
    [livePassCount, liveFailCount, liveNotRunCount],
  );
  const slowFailSignalsData = useMemo(
    () => [
      {
        label: '>10s elapsed',
        count: slowOverTenSecondsCount,
        fill: '#f59e0b',
      },
      { label: 'Did not pass', count: notPassedItemCount, fill: '#dc2626' },
    ],
    [slowOverTenSecondsCount, notPassedItemCount],
  );
  const slowFailSignalTotal = useMemo(
    () => slowOverTenSecondsCount + notPassedItemCount,
    [slowOverTenSecondsCount, notPassedItemCount],
  );

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">
        At-a-glance charts
      </h2>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <article className="col-span-3 min-w-0 rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Elapsed by prompt order
          </h3>
          <ChartFrame className="mt-4 h-56 min-w-0">
            {({ height, width }) => (
              <LineChart data={elapsedTrendData} height={height} width={width}>
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
                <Tooltip
                  formatter={(value) => {
                    if (typeof value !== 'number') {
                      return 'n/a';
                    }
                    return `${value.toFixed(2)} s`;
                  }}
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
          <h3 className="text-sm font-semibold text-slate-900">
            Pass vs fail vs not run
          </h3>
          <ChartFrame className="mt-4 h-56 min-w-0">
            {({ height, width }) => (
              <PieChart height={height} width={width}>
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
                <Tooltip />
              </PieChart>
            )}
          </ChartFrame>
          <p className="mt-2 text-xs text-slate-500">
            Pass rate (completed items): {passRate.toFixed(1)}%
          </p>
        </article>

        <article className="min-w-0 rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Slow or not-passed signal counts
          </h3>
          <ChartFrame className="mt-4 h-56 min-w-0">
            {({ height, width }) => (
              <PieChart height={height} width={width}>
                <Pie
                  cx="50%"
                  cy="50%"
                  data={slowFailSignalsData}
                  dataKey="count"
                  innerRadius={50}
                  nameKey="label"
                  outerRadius={82}
                >
                  {slowFailSignalsData.map((entry) => (
                    <Cell fill={entry.fill} key={entry.label} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            )}
          </ChartFrame>
          <p className="mt-2 text-xs text-slate-500">
            Combined signal total: {slowFailSignalTotal} (counts may overlap by
            item).
          </p>
        </article>

        <article className="min-w-0 rounded-2xl border border-slate-200 p-5">
          <h3 className="text-sm font-semibold text-slate-900">
            Similarity stats
          </h3>
          <ChartFrame className="mt-4 h-56 min-w-0">
            {({ height, width }) => (
              <BarChart data={similarityStatsData} height={height} width={width}>
                <CartesianGrid strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="label" interval={0} tick={{ fontSize: 11 }} />
                <YAxis
                  domain={[0, 1]}
                  tick={{ fontSize: 11 }}
                  tickFormatter={(value) => `${(value * 100).toFixed(0)}%`}
                />
                <Tooltip
                  formatter={(value) => {
                    if (typeof value !== 'number') {
                      return 'n/a';
                    }
                    return `${(value * 100).toFixed(2)}%`;
                  }}
                />
                <Bar dataKey="value" fill="#a855f7" radius={[8, 8, 0, 0]} />
              </BarChart>
            )}
          </ChartFrame>
        </article>
      </div>
    </section>
  );
}
