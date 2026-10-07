/**
 * B0-583 — "Tokens per day" panel for `/admin` (epic B0-569; moved from the retired `/admin/bex/health`).
 *
 * Async server component. All bars come from the `cost_by_model_per_day` view (B0-565) via the
 * additive `fetchDailyCostPoints` export in `~/lib/observability/cost-metrics` — no new scan of
 * `workflow_steps` or `final_output`. Points are aggregated ACROSS models per EST day.
 *
 * The cache-hit rate is `Σ cached_prompt_tokens / Σ prompt_tokens` over the window — the same
 * definition the live-traffic card uses, so the two agree for the same window. Its delta is
 * against the preceding equal-length window and is absent (not zero) when that window has no data.
 *
 * `version` is accepted but ignored: the cost view has no version dimension; the prop is part of
 * the shared health-panel contract so the page composes every panel uniformly.
 */

import {
  fetchCostCoveredRunCount,
  fetchDailyCostPoints,
  type CostMetricsPoint,
} from '~/lib/observability/cost-metrics';

import { ProvenanceFooter } from './ProvenanceFooter';
import { TokensPerDayChart, type TokensPerDayDatum } from './TokensPerDayChart';

import type { HealthPanelProps } from '~/lib/bex-health/search-params';

/** B0-584 — verified against `fetchDailyCostPoints` / `fetchCostCoveredRunCount`; keep in sync with them. */
const TOKENS_SOURCES = [
  'Bars & cache-hit rate: cost_by_model_per_day view, summed per EST day across models',
  'Tokens-per-run denominator: cost_covered_run_count RPC — runs with ≥1 cost-tracked step, exactly the runs the view aggregates',
  'The version selector does NOT apply to this panel — the cost view has no version dimension',
];

const DAY_MS = 24 * 60 * 60 * 1000;

const integerFormatter = new Intl.NumberFormat('en-US');
const percentFormatter = new Intl.NumberFormat('en-US', {
  style: 'percent',
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Every EST day from `fromDay` to `toDay` inclusive, as `YYYY-MM-DD`. */
function enumerateDays(fromDay: string, toDay: string): string[] {
  const days: string[] = [];
  const end = Date.parse(`${toDay}T00:00:00.000Z`);
  for (let t = Date.parse(`${fromDay}T00:00:00.000Z`); t <= end; t += DAY_MS) {
    days.push(utcDay(new Date(t)));
  }
  return days;
}

type DayTotals = { prompt: number; cached: number; completion: number; total: number };

/** Collapses per-model view rows into per-day totals, keyed by EST day. */
function aggregateByDay(points: CostMetricsPoint[]): Map<string, DayTotals> {
  const byDay = new Map<string, DayTotals>();
  for (const point of points) {
    const day = point.bucket.slice(0, 10);
    const totals = byDay.get(day) ?? { prompt: 0, cached: 0, completion: 0, total: 0 };
    totals.prompt += point.promptTokens;
    totals.cached += point.cachedPromptTokens;
    totals.completion += point.completionTokens;
    totals.total += point.totalTokens;
    byDay.set(day, totals);
  }
  return byDay;
}

/** `Σ cached / Σ prompt`, or null when the window has no prompt tokens to divide by. */
function cacheHitRate(points: CostMetricsPoint[]): number | null {
  let prompt = 0;
  let cached = 0;
  for (const point of points) {
    prompt += point.promptTokens;
    cached += point.cachedPromptTokens;
  }
  return prompt > 0 ? cached / prompt : null;
}

export async function TokensPerDayPanel(props: HealthPanelProps) {
  const fromDay = utcDay(props.window.from);
  const toDay = utcDay(props.window.to);
  const days = enumerateDays(fromDay, toDay);

  // Preceding window of equal length, ending the day before this window starts.
  const priorToMs = Date.parse(`${fromDay}T00:00:00.000Z`) - DAY_MS;
  const priorTo = utcDay(new Date(priorToMs));
  const priorFrom = utcDay(new Date(priorToMs - (days.length - 1) * DAY_MS));

  let points: CostMetricsPoint[];
  let priorPoints: CostMetricsPoint[];
  let runCount: number;
  try {
    [points, priorPoints, runCount] = await Promise.all([
      fetchDailyCostPoints({ startDate: fromDay, endDate: toDay }),
      fetchDailyCostPoints({ startDate: priorFrom, endDate: priorTo }),
      fetchCostCoveredRunCount({ startDate: fromDay, endDate: toDay }),
    ]);
  } catch (error) {
    return (
      <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6">
        <p className="text-sm font-semibold text-destructive">Tokens per day</p>
        <p className="mt-1 text-sm text-destructive">
          {error instanceof Error ? error.message : 'Unable to load token metrics.'}
        </p>
      </section>
    );
  }

  const byDay = aggregateByDay(points);
  const data: TokensPerDayDatum[] = days.map((day) => {
    const totals = byDay.get(day);
    if (!totals) {
      return { day, promptUncached: 0, cached: 0, completion: 0, noRuns: true };
    }
    return {
      day,
      promptUncached: Math.max(totals.prompt - totals.cached, 0),
      cached: totals.cached,
      completion: totals.completion,
      noRuns: false,
    };
  });

  const windowTotalTokens = points.reduce((sum, point) => sum + point.totalTokens, 0);
  // Denominator = runs with ≥1 cost-tracked step (the `cost_covered_run_count` RPC): exactly the
  // runs whose tokens the view aggregates, so the ratio never mixes populations.
  const tokensPerRun = runCount > 0 ? Math.round(windowTotalTokens / runCount) : null;

  const currentRate = cacheHitRate(points);
  const priorRate = priorPoints.length > 0 ? cacheHitRate(priorPoints) : null;
  // Delta in percentage points; absent (not zero) when either window can't produce a rate.
  const cacheHitDeltaPts =
    currentRate !== null && priorRate !== null ? (currentRate - priorRate) * 100 : null;

  const emptyDayCount = data.filter((datum) => datum.noRuns).length;

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm sm:p-8">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-950">Tokens per day</h2>
          <p className="mt-1 text-sm text-slate-600">
            One stacked bar per EST day — prompt (uncached), cached prompt, and completion tokens,
            from <code>cost_by_model_per_day</code> across all models.
          </p>
        </div>
      </div>

      <div className="mt-6">
        <TokensPerDayChart data={data} />
      </div>

      <dl className="mt-6 flex flex-wrap gap-x-8 gap-y-3 border-t border-slate-200 pt-4 text-sm">
        <div>
          <dt className="text-slate-500">Window total</dt>
          <dd className="font-medium text-slate-950">
            {integerFormatter.format(windowTotalTokens)} tokens
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Tokens per run</dt>
          <dd className="font-medium text-slate-950">
            {tokensPerRun !== null
              ? `${integerFormatter.format(tokensPerRun)} (${integerFormatter.format(runCount)} runs)`
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-slate-500">Cache-hit rate</dt>
          <dd className="font-medium text-slate-950">
            {currentRate !== null ? percentFormatter.format(currentRate) : '—'}
            {cacheHitDeltaPts !== null ? (
              <span className="ml-1.5 font-normal text-slate-500">
                ({cacheHitDeltaPts >= 0 ? '+' : ''}
                {cacheHitDeltaPts.toFixed(1)} pts vs preceding {days.length}d)
              </span>
            ) : (
              <span className="ml-1.5 font-normal text-slate-500">
                (no preceding-window data)
              </span>
            )}
          </dd>
        </div>
      </dl>

      <p className="mt-3 text-xs text-slate-500">
        {emptyDayCount > 0
          ? `${emptyDayCount} shaded ${emptyDayCount === 1 ? 'day is an empty slot' : 'days are empty slots'} — no cost-tracked runs that day, not low volume.`
          : 'Shaded slots (none in this window) would mark days with no cost-tracked runs, as distinct from low volume.'}
      </p>

      <ProvenanceFooter sources={TOKENS_SOURCES} />
    </section>
  );
}
