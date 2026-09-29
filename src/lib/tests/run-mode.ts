/**
 * B0-1100 / B0-1105 / B0-1110 — the one place `test_results.run_mode` values are named.
 *
 * The database enforces the same set (`test_results_run_mode_check`, migration
 * `20260929150000_add_partial_run_columns_to_test_results_b0_1100.sql`), so an unknown mode can be
 * written by neither side. Every reader that feeds a golden or aggregate metric must scope itself
 * with {@link METRIC_ELIGIBLE_RUN_MODES}; every runner that treats a run as a chat run (executor,
 * stalled-run sweeper) must use {@link CHAT_RUN_MODES}. Never inline a `run_mode` string literal in
 * a `test_results` query — import from here so the sets cannot drift.
 */

export const RUN_MODES = ['full', 'search', 'partial'] as const;
export type RunMode = (typeof RUN_MODES)[number];

export function isRunMode(value: unknown): value is RunMode {
  return typeof value === 'string' && (RUN_MODES as readonly string[]).includes(value);
}

/**
 * Runs that may be aggregated into ANY golden-set metric, rollup, trend, alert or report index.
 * `partial` runs are by construction biased low (they re-run only the items that were already
 * failing) and `search` runs never ran a chat model, so only `full` qualifies. Tom's
 * non-negotiable for B0-1099: this list is the entire answer, nowhere else decides.
 */
export const METRIC_ELIGIBLE_RUN_MODES = ['full'] as const satisfies readonly RunMode[];
export type MetricEligibleRunMode = (typeof METRIC_ELIGIBLE_RUN_MODES)[number];

export function isMetricEligibleRunMode(value: string): value is MetricEligibleRunMode {
  return (METRIC_ELIGIBLE_RUN_MODES as readonly string[]).includes(value);
}

/** The narrowest slice of a PostgREST filter builder the chokepoint needs. */
type RunModeFilterable<T> = {
  in(column: 'run_mode', values: readonly string[]): T;
};

/**
 * B0-1105 — THE run_mode predicate for every `test_results` reader that feeds a golden-set metric,
 * rollup, trend, alert or report index. Apply it to the builder (`onlyMetricEligibleRuns(
 * supabase.from('test_results').select(...))`) instead of writing `.eq('run_mode', 'full')` inline;
 * the regression test `run-mode-metric-chokepoint.test.ts` fails on any metric reader that skips
 * it and on any `run_mode` literal that appears outside this module.
 */
export function onlyMetricEligibleRuns<T extends RunModeFilterable<T>>(query: T): T {
  return query.in('run_mode', [...METRIC_ELIGIBLE_RUN_MODES]);
}

/**
 * Runs that execute the chat pipeline item by item (as opposed to a retrieval-only `search` run).
 * The executor, the report grader and the stalled-run sweeper treat these alike; a `partial` run
 * is a chat run over a scoped item list (`test_results.item_scope`), nothing more.
 */
export const CHAT_RUN_MODES = ['full', 'partial'] as const satisfies readonly RunMode[];
export type ChatRunMode = (typeof CHAT_RUN_MODES)[number];

export function isChatRunMode(value: string): value is ChatRunMode {
  return (CHAT_RUN_MODES as readonly string[]).includes(value);
}
