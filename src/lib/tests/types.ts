import type { Json, Tables, TablesInsert } from '~/types/supabase.public';
import type { MultiTurnScenario } from './multi-turn';

export const TERMINAL_RUN_STATUSES = [
  'completed',
  'completed_with_failures',
  'failed',
  'cancelled',
] as const;

export type TerminalRunStatus = (typeof TERMINAL_RUN_STATUSES)[number];

export function isTerminalRunStatus(status: string): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/** Runs that finished executing all items (as opposed to still running, failed to run, or cancelled). */
export const COMPLETED_RUN_STATUSES = ['completed', 'completed_with_failures'] as const;

export function isCompletedRunStatus(status: string): boolean {
  return (COMPLETED_RUN_STATUSES as readonly string[]).includes(status);
}

export type TestRecord = Tables<'tests'>;
export type TestRecordWithCompletionCount = TestRecord & {
  completed_runs_count: number;
  /**
   * B0-630 — mean of `report_state->overall->>avg` across this dataset's completed reports,
   * rounded to one decimal (the precision the UI renders, so the number and its derived letter
   * grade always agree). `null` when no run has a completed report carrying a score —
   * pre-B0-609 reports omit the key entirely.
   */
  avg_report_score: number | null;
  /** B0-630 — how many runs contributed to `avg_report_score`. */
  scored_runs_count: number;
  /** Latest run's report score, rounded to one decimal. */
  latest_run_score: number | null;
  /**
   * `latest_run_score` minus the score of the completed run immediately before it, rounded to
   * one decimal. `null` when there's no latest score, no scored previous run to compare against,
   * or only one scored run exists.
   */
  latest_run_score_delta: number | null;
  /** `test_results.failed_items` for the latest completed report run; `null` when there is none. */
  latest_run_failed_items: number | null;
  /** `run_options.modelTag` (generation model) for the latest completed report run; `null` when unrecorded or there is none. */
  latest_run_model_tag: string | null;
};
export type TestItemRecord = Tables<'test_items'>;
export type TestResultRecord = Tables<'test_results'>;
export type TestResultItemRecord = Tables<'test_result_items'>;
export type LatestFailedTestResultItemView = Tables<'latest_failed_test_result_items'>;
/** B0-312 — post-mortem comparison of a run against the previous completed run on the same test. */
export type TestResultComparisonRecord = Tables<'test_result_comparisons'>;

export type NewTestRecord = TablesInsert<'tests'>;
export type NewTestItemRecord = TablesInsert<'test_items'>;
export type NewTestResultRecord = TablesInsert<'test_results'>;
export type NewTestResultItemRecord = TablesInsert<'test_result_items'>;
export type NewTestResultComparisonRecord = TablesInsert<'test_result_comparisons'>;

/** B0-312 — `test_result_comparisons.status` values. */
export const RUN_COMPARISON_STATUSES = ['generating', 'ready', 'failed', 'no_baseline'] as const;
export type RunComparisonStatus = (typeof RUN_COMPARISON_STATUSES)[number];

/** B0-314 — `test_result_comparisons.verdict` values (set only once `status` is 'ready'). */
export const RUN_COMPARISON_VERDICTS = ['improved', 'regressed', 'flat'] as const;
export type RunComparisonVerdict = (typeof RUN_COMPARISON_VERDICTS)[number];

/** One entry of `test_result_comparisons.new_failures` — a case that passed previously and fails now. */
export type RunComparisonNewFailure = {
  resultItemId: string;
  testItemId: string;
  rowIndex: number;
  prompt: string;
  errorMessage: string | null;
  /** Null until the B0-314 LLM analysis stage fills it in. */
  cause: string | null;
  fix: string | null;
};

/** One entry of `test_result_comparisons.fixes` — a case that failed previously and passes now. */
export type RunComparisonFix = {
  resultItemId: string;
  testItemId: string;
  rowIndex: number;
  prompt: string;
  errorMessage: string | null;
};

export type ParsedCsvRow = {
  rowIndex: number;
  prompt: string;
  /** B0-993 — product line keys, one per element and stored verbatim; empty when unconstrained. */
  expectedCanonicalProducts: string[];
  expectedReasonCode: string | null;
  source: string | null;
  priority: number | null;
  idealResponse: string | null;
  /**
   * B0-931 — `expected_concepts` and `minimum_concepts` are `text[]` columns.
   * One element per phrase, split structurally by `splitPhraseCell` (`./csv`) and stored verbatim.
   * Empty array when the cell is absent, blank, or an empty-cell marker.
   */
  expectedConcepts: string[];
  minimumConcepts: string[];
  /** B0-931 — `rag.document.id` uuids. Non-uuid tokens land in {@link ParsedCsvRow.warnings}. */
  expectedSources: string[];
  shouldCite: boolean | null;
  expectedTool: string | null;
  /** B0-790 — ground truth for the signals-accuracy harness. Same support level as expectedTool. */
  expectedSurfaceType: string | null;
  expectedBrandFamily: string | null;
  expectedSetting: string | null;
  /** B0-537 — the `multi_turn_json` cell's scenario, or null for an ordinary single-turn row. */
  multiTurnScenario: MultiTurnScenario | null;
  /**
   * B0-537 — values are strings for every CSV column except the `multi_turn` scenario object the
   * `multi_turn_json` cell contributes, hence `Json` rather than `string`.
   */
  inputPayload: Record<string, Json>;
  metadata: Record<string, string>;
  /**
   * B0-931 — row-level import problems the uploader must see (currently: `expected_sources`
   * tokens that are not `rag.document.id` uuids). Empty when the row parsed cleanly. A warning
   * never rejects the row — the rest of it still imports.
   */
  warnings: string[];
};
