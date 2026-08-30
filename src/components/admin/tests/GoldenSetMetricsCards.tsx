import { gradeFromScore } from '~/lib/tests/report/metrics';
import type { GoldenSetMetrics } from '~/lib/tests/golden-set-metrics';

const EM_DASH = '—';

function formatMs(ms: number | null): string {
  if (ms === null) return EM_DASH;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatPercent(percent: number | null): string {
  if (percent === null) return EM_DASH;
  return `${percent.toFixed(1)}%`;
}

function formatScore(score: number | null): string {
  if (score === null) return EM_DASH;
  return `${score.toFixed(1)}/100 (${gradeFromScore(score)})`;
}

interface GoldenSetMetricsCardsProps {
  metrics: GoldenSetMetrics;
}

export function GoldenSetMetricsCards({ metrics }: GoldenSetMetricsCardsProps) {
  if (metrics.goldenSetCount === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      {/* Card 1: Total failing prompts */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
          Failing prompts
        </p>
        <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">
          {metrics.totalFailingPrompts}
        </p>
        <p className="mt-1 text-xs text-slate-500">
          across {metrics.goldenSetCount} golden set{metrics.goldenSetCount === 1 ? '' : 's'}
        </p>
      </div>

      {/* Card 2: Average score */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
          Avg score
        </p>
        <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">
          {formatScore(metrics.averageScore)}
        </p>
        <p className="mt-1 text-xs text-slate-500">golden set average</p>
      </div>

      {/* Card 3: Score change percentage */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
          Score change
        </p>
        <p className="mt-2 text-2xl font-semibold tabular-nums text-slate-900">
          {metrics.scoreChangePercent !== null
            ? `${metrics.scoreChangePercent > 0 ? '+' : ''}${metrics.scoreChangePercent.toFixed(1)}%`
            : EM_DASH}
        </p>
        <p className="mt-1 text-xs text-slate-500">vs previous run</p>
      </div>

      {/* Card 4: Pass % avg + TTFT/Elapsed avg */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
          Performance
        </p>
        <div className="mt-2 space-y-1.5">
          <div>
            <p className="text-sm font-semibold text-slate-900">
              {formatPercent(metrics.averagePassPercent)} pass rate
            </p>
          </div>
          <div className="pt-1 text-xs text-slate-600">
            <span className="text-slate-500">
              TTFT: {formatMs(metrics.averageTtft)} · Elapsed: {formatMs(metrics.averageElapsed)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
