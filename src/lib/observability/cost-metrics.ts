/**
 * B0-566 — cost-metrics data access for the `/admin/cost` dashboard (epic B0-562).
 *
 * Reads the B0-565 SQL views (`cost_by_model_per_day`, `cost_by_model_per_month`,
 * `cost_comparison_yoy`), which already do the token→$ aggregation in Postgres. Shared by both the
 * `GET /api/bex/cost/metrics` route and the dashboard's server component, so the two never drift.
 */

import { unstable_cache } from 'next/cache';

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export const COST_TIME_RANGES = ['1d', '1w', '1m', '3m', '6m', '1y'] as const;
export type CostTimeRange = (typeof COST_TIME_RANGES)[number];

export const COST_GROUP_BY_VALUES = ['day', 'month'] as const;
export type CostGroupBy = (typeof COST_GROUP_BY_VALUES)[number];

export type CostMetricsPoint = {
  bucket: string;
  modelId: string;
  stepCount: number;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
};

export type CostYoyPoint = {
  month: string;
  modelId: string;
  currentTotalTokens: number;
  currentCostUsd: number;
  priorYearTotalTokens: number | null;
  priorYearCostUsd: number | null;
  yoyCostChangePct: number | null;
};

export type CostMetricsInput = {
  timeRange: CostTimeRange;
  groupBy: CostGroupBy;
  compareYoY: boolean;
  startDate?: string;
  endDate?: string;
};

export type CostMetricsResult = {
  timeRange: CostTimeRange;
  groupBy: CostGroupBy;
  startDate: string;
  endDate: string;
  points: CostMetricsPoint[];
  yoy: CostYoyPoint[] | null;
  /** Distinct workflow_runs with at least one cost-tracked step in [startDate, endDate]. */
  runCount: number;
};

/** Approximate day-span per button; only used to derive a default window, never for YoY math (the `cost_comparison_yoy` view aligns on exact calendar months). */
const TIME_RANGE_DAYS: Record<CostTimeRange, number> = {
  '1d': 1,
  '1w': 7,
  '1m': 30,
  '3m': 90,
  '6m': 182,
  '1y': 365,
};

/** Exported for testing; `now` is injectable so the resolved window is deterministic in tests. */
export function resolveCostWindow(
  input: Pick<CostMetricsInput, 'timeRange' | 'startDate' | 'endDate'>,
  now: Date = new Date(),
): { startDate: string; endDate: string } {
  const endDate = input.endDate ?? now.toISOString().slice(0, 10);
  if (input.startDate) {
    return { startDate: input.startDate, endDate };
  }
  const start = new Date(`${endDate}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - TIME_RANGE_DAYS[input.timeRange]);
  return { startDate: start.toISOString().slice(0, 10), endDate };
}

type CostViewRow = {
  bucket: string | null;
  model_id: string | null;
  step_count: number | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  cached_prompt_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_usd: number | null;
};

function toPoint(row: CostViewRow): CostMetricsPoint | null {
  if (!row.bucket || !row.model_id) {
    return null;
  }
  return {
    bucket: row.bucket,
    modelId: row.model_id,
    stepCount: Number(row.step_count ?? 0),
    promptTokens: Number(row.prompt_tokens ?? 0),
    completionTokens: Number(row.completion_tokens ?? 0),
    cachedPromptTokens: Number(row.cached_prompt_tokens ?? 0),
    totalTokens: Number(row.total_tokens ?? 0),
    estimatedCostUsd: Number(row.estimated_cost_usd ?? 0),
  };
}

async function fetchCostPoints(params: {
  groupBy: CostGroupBy;
  startDate: string;
  endDate: string;
}): Promise<CostMetricsPoint[]> {
  const supabase = getSupabaseServiceRoleClient();
  const table = params.groupBy === 'month' ? 'cost_by_model_per_month' : 'cost_by_model_per_day';
  const { data, error } = await supabase
    .from(table)
    .select('*')
    .gte('bucket', `${params.startDate}T00:00:00.000Z`)
    .lte('bucket', `${params.endDate}T23:59:59.999Z`)
    .order('bucket', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? [])
    .map((row) => toPoint(row as CostViewRow))
    .filter((point): point is CostMetricsPoint => point !== null);
}

async function fetchYoyPoints(params: {
  startDate: string;
  endDate: string;
}): Promise<CostYoyPoint[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('cost_comparison_yoy')
    .select('*')
    .gte('month', `${params.startDate}T00:00:00.000Z`)
    .lte('month', `${params.endDate}T23:59:59.999Z`)
    .order('month', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? [])
    .filter((row) => row.model_id !== null && row.month !== null)
    .map((row) => ({
      month: row.month as string,
      modelId: row.model_id as string,
      currentTotalTokens: Number(row.current_total_tokens ?? 0),
      currentCostUsd: Number(row.current_cost_usd ?? 0),
      priorYearTotalTokens:
        row.prior_year_total_tokens === null ? null : Number(row.prior_year_total_tokens),
      priorYearCostUsd: row.prior_year_cost_usd === null ? null : Number(row.prior_year_cost_usd),
      yoyCostChangePct: row.yoy_cost_change_pct === null ? null : Number(row.yoy_cost_change_pct),
    }));
}

async function fetchCoveredRunCount(params: { startDate: string; endDate: string }): Promise<number> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase.rpc('cost_covered_run_count', {
    p_start: `${params.startDate}T00:00:00.000Z`,
    p_end: `${params.endDate}T23:59:59.999Z`,
  });

  if (error) {
    throw new Error(error.message);
  }

  return data ?? 0;
}

async function loadCostMetrics(input: CostMetricsInput): Promise<CostMetricsResult> {
  const { startDate, endDate } = resolveCostWindow(input);
  const [points, yoy, runCount] = await Promise.all([
    fetchCostPoints({ groupBy: input.groupBy, startDate, endDate }),
    input.compareYoY ? fetchYoyPoints({ startDate, endDate }) : Promise.resolve(null),
    fetchCoveredRunCount({ startDate, endDate }),
  ]);

  return {
    timeRange: input.timeRange,
    groupBy: input.groupBy,
    startDate,
    endDate,
    points,
    yoy,
    runCount,
  };
}

/**
 * B0-583 — additive reads for the Bex Health "Tokens per day" panel. Same `cost_by_model_per_day`
 * view `getCostMetrics` uses, exposed with an explicit day window so the panel can also fetch the
 * preceding equal-length window for its cache-hit delta. Deliberately uncached: the health page is
 * request-rendered and small. Existing `/admin/cost` exports are untouched.
 */
export async function fetchDailyCostPoints(window: {
  startDate: string;
  endDate: string;
}): Promise<CostMetricsPoint[]> {
  return fetchCostPoints({
    groupBy: 'day',
    startDate: window.startDate,
    endDate: window.endDate,
  });
}

/**
 * B0-583 — distinct workflow runs with at least one cost-tracked step in the window (the
 * `cost_covered_run_count` RPC). This is the honest denominator for "tokens per run": it counts
 * exactly the runs whose tokens appear in `cost_by_model_per_day`.
 */
export async function fetchCostCoveredRunCount(window: {
  startDate: string;
  endDate: string;
}): Promise<number> {
  return fetchCoveredRunCount({ startDate: window.startDate, endDate: window.endDate });
}

/** 1h cache — cost data changes with every workflow run, but a dashboard refresh doesn't need to. */
const getCachedCostMetrics = unstable_cache(loadCostMetrics, ['bex-cost-metrics'], {
  revalidate: 3600,
});

export async function getCostMetrics(input: CostMetricsInput): Promise<CostMetricsResult> {
  return getCachedCostMetrics(input);
}
