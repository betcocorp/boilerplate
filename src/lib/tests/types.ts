import type { Tables, TablesInsert } from '~/types/supabase.public';
import type { ExpectedCriterion } from './criteria-schemas';

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
};
export type TestItemRecord = Tables<'test_items'>;
export type TestResultRecord = Tables<'test_results'>;
export type TestResultItemRecord = Tables<'test_result_items'>;
export type LatestFailedTestResultItemView = Tables<'latest_failed_test_result_items'>;

export type NewTestRecord = TablesInsert<'tests'>;
export type NewTestItemRecord = TablesInsert<'test_items'>;
export type NewTestResultRecord = TablesInsert<'test_results'>;
export type NewTestResultItemRecord = TablesInsert<'test_result_items'>;

export type ParsedCsvRow = {
  rowIndex: number;
  prompt: string;
  expectedShouldAnswer: boolean | null;
  expectedResultType: string | null;
  expectedCanonicalProduct: string | null;
  expectedReasonCode: string | null;
  source: string | null;
  priority: number | null;
  idealResponse: string | null;
  expectedConcepts: string | null;
  minimumConcepts: string | null;
  /** B0-615 — parsed from the `expected_criteria` CSV cell's tiered mini-syntax. Empty array when absent. */
  expectedCriteria: ExpectedCriterion[];
  expectedSources: string | null;
  shouldCite: boolean | null;
  inputPayload: Record<string, string>;
  metadata: Record<string, string>;
};
