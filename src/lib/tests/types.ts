import type { Tables, TablesInsert } from '~/types/supabase.public';

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
  inputPayload: Record<string, string>;
  metadata: Record<string, string>;
};
