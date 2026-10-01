import { ROUTING_TEST_ROUTER_LABELS } from './constants';
import type {
  RoutingTestRouterType,
  RoutingTestRunRecord,
} from './types';

/**
 * B0-698 — pure aggregation over the persisted run history (`public.routing_test_runs`) that backs
 * the charts above the run-history table. Everything here is derived from rows the page already
 * loads via `listRoutingTestRuns()`; there is no extra query and no new column.
 *
 * Accuracy is always recomputed as `passed_items / total_items` (there is no persisted `accuracy`
 * column), matching how `RoutingTestRunHistory` derives the score column below — so a chart figure
 * and a table row can never disagree.
 */

/** Every router type, in the order the workbench select and the charts present them. */
export const ROUTING_TEST_ROUTER_TYPES: readonly RoutingTestRouterType[] = [
  'keyword',
  'semantic',
  'llm',
] as const;

/** 0-1 accuracy fraction for one persisted run. `0` when the run scored no items. */
export function routingTestRunAccuracy(run: RoutingTestRunRecord): number {
  return run.total_items === 0 ? 0 : run.passed_items / run.total_items;
}

/** Rolled-up view of every run recorded for one router type. */
export type RoutingTestRouterSummary = {
  routerType: RoutingTestRouterType;
  label: string;
  runCount: number;
  /** Mean of each run's own accuracy fraction (0-1). `0` when the router has no runs. */
  avgAccuracy: number;
  /** Accuracy fraction of this router's most recent run, or `null` when it has none. */
  latestAccuracy: number | null;
  /** Highest single-run accuracy fraction, or `null` when the router has no runs. */
  bestAccuracy: number | null;
  /** Mean `avg_item_duration_ms` across runs that recorded one; `null` when none did. */
  avgItemDurationMs: number | null;
  totalDegradedItems: number;
};

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * One summary per router type, ALWAYS all three — a router nobody has run yet still gets a row so
 * the comparison charts show its absence rather than silently dropping a bar.
 */
export function buildRoutingTestRouterSummaries(
  runs: readonly RoutingTestRunRecord[],
): RoutingTestRouterSummary[] {
  return ROUTING_TEST_ROUTER_TYPES.map((routerType) => {
    // Newest first, matching `listRoutingTestRuns()`; re-sorted here so the summary never depends
    // on the caller's ordering.
    const routerRuns = runs
      .filter((run) => run.router_type === routerType)
      .sort((a, b) => b.ran_at.localeCompare(a.ran_at));

    const accuracies = routerRuns.map(routingTestRunAccuracy);
    const itemDurations = routerRuns
      .map((run) => run.avg_item_duration_ms)
      .filter((value): value is number => value !== null);

    return {
      routerType,
      label: ROUTING_TEST_ROUTER_LABELS[routerType],
      runCount: routerRuns.length,
      avgAccuracy: mean(accuracies),
      latestAccuracy: accuracies[0] ?? null,
      bestAccuracy: accuracies.length === 0 ? null : Math.max(...accuracies),
      avgItemDurationMs:
        itemDurations.length === 0 ? null : Math.round(mean(itemDurations)),
      totalDegradedItems: routerRuns.reduce(
        (sum, run) => sum + run.degraded_items,
        0,
      ),
    };
  });
}

/**
 * One point per run, oldest first. Each point carries the accuracy under its OWN router's key and
 * `null` under the other two, so a `connectNulls` line per router traces only that router's runs
 * instead of zig-zagging through its neighbours' scores.
 */
export type RoutingTestTrendPoint = {
  runId: string;
  ranAt: string;
  /** 1-based position in the chronological run history — the x-axis label. */
  label: string;
  routerType: RoutingTestRouterType;
  keyword: number | null;
  semantic: number | null;
  llm: number | null;
};

export function buildRoutingTestAccuracyTrend(
  runs: readonly RoutingTestRunRecord[],
): RoutingTestTrendPoint[] {
  return [...runs]
    .sort((a, b) => a.ran_at.localeCompare(b.ran_at))
    .map((run, index) => {
      const accuracyPercent = Math.round(routingTestRunAccuracy(run) * 100);
      return {
        runId: run.id,
        ranAt: run.ran_at,
        label: `${index + 1}`,
        routerType: run.router_type,
        keyword: run.router_type === 'keyword' ? accuracyPercent : null,
        semantic: run.router_type === 'semantic' ? accuracyPercent : null,
        llm: run.router_type === 'llm' ? accuracyPercent : null,
      };
    });
}

/** The headline numbers rendered as a stat strip above the charts. */
export type RoutingTestAggregate = {
  totalRuns: number;
  /** Items scored across every run (not distinct prompts — a prompt run twice counts twice). */
  totalItems: number;
  totalPassedItems: number;
  /** Pooled accuracy: passed items over scored items across ALL runs, not a mean of means. */
  overallAccuracy: number;
  totalDegradedItems: number;
  /** Router with the highest `avgAccuracy` among those that have runs; `null` when none do. */
  bestRouter: RoutingTestRouterSummary | null;
};

export function buildRoutingTestAggregate(
  runs: readonly RoutingTestRunRecord[],
  summaries: readonly RoutingTestRouterSummary[],
): RoutingTestAggregate {
  const totalItems = runs.reduce((sum, run) => sum + run.total_items, 0);
  const totalPassedItems = runs.reduce((sum, run) => sum + run.passed_items, 0);

  const ranked = summaries
    .filter((summary) => summary.runCount > 0)
    .sort((a, b) => b.avgAccuracy - a.avgAccuracy);

  return {
    totalRuns: runs.length,
    totalItems,
    totalPassedItems,
    overallAccuracy: totalItems === 0 ? 0 : totalPassedItems / totalItems,
    totalDegradedItems: runs.reduce((sum, run) => sum + run.degraded_items, 0),
    bestRouter: ranked[0] ?? null,
  };
}

/** Whole-percent display for a 0-1 accuracy fraction — the format every chart axis/tooltip uses. */
export function formatRoutingTestPercent(accuracy: number): string {
  return `${Math.round(accuracy * 100)}%`;
}
