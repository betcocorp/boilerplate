'use client';

import {
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

type TrendRun = {
  startedAtLabel: string;
  passRate: number;
  elapsedSeconds: number;
  status: string;
};

type TestHistoricalTrendsChartsProps = {
  runs: TrendRun[];
};

const STATUS_COLORS = ['#16a34a', '#0ea5e9', '#f59e0b', '#ef4444', '#6366f1', '#64748b'];

export function TestHistoricalTrendsCharts({ runs }: TestHistoricalTrendsChartsProps) {
  const statusCounts = runs.reduce<Record<string, number>>((acc, run) => {
    acc[run.status] = (acc[run.status] || 0) + 1;
    return acc;
  }, {});
  const statusData = Object.entries(statusCounts).map(([label, count]) => ({
    label,
    count,
  }));

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="mb-5 flex items-end justify-between gap-3">
        <h2 className="text-lg font-semibold text-slate-900">Historical performance trends</h2>
        <p className="text-xs text-slate-500">Based on the last {runs.length} runs</p>
      </div>
      {runs.length === 0 ? (
        <p className="text-sm text-slate-500">Run the dataset to start seeing trend charts.</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-3">
          <article className="rounded-2xl border border-slate-200 p-5">
            <h3 className="text-sm font-semibold text-slate-900">Pass rate trend</h3>
            <p className="mt-1 text-xs text-slate-500">
              Newest: {runs[runs.length - 1]?.passRate.toFixed(1)}%
            </p>
            <div className="mt-4 h-56">
              <ResponsiveContainer height="100%" width="100%">
                <LineChart data={runs}>
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
              </ResponsiveContainer>
            </div>
          </article>

          <article className="rounded-2xl border border-slate-200 p-5">
            <h3 className="text-sm font-semibold text-slate-900">Runtime trend</h3>
            <p className="mt-1 text-xs text-slate-500">
              Newest: {runs[runs.length - 1]?.elapsedSeconds.toFixed(2)} s
            </p>
            <div className="mt-4 h-56">
              <ResponsiveContainer height="100%" width="100%">
                <LineChart data={runs}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="startedAtLabel" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(value) => `${value}s`} />
                  <Tooltip
                    formatter={(value) =>
                      typeof value === 'number' ? `${value.toFixed(2)} s` : `${value ?? ''}`
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
              </ResponsiveContainer>
            </div>
          </article>

          <article className="rounded-2xl border border-slate-200 p-5">
            <h3 className="text-sm font-semibold text-slate-900">Run status mix</h3>
            <div className="mt-4 h-56">
              <ResponsiveContainer height="100%" width="100%">
                <PieChart>
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
              </ResponsiveContainer>
            </div>
          </article>
        </div>
      )}
    </section>
  );
}
