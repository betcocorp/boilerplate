import type { Tables, TablesInsert } from '~/types/supabase.public';

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
