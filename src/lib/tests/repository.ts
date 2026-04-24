import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type {
  NewTestItemRecord,
  NewTestRecord,
  NewTestResultItemRecord,
  NewTestResultRecord,
  TestItemRecord,
  TestRecord,
  TestResultItemRecord,
  TestResultRecord,
} from './types';

function assertNoError<T>(payload: { data: T; error: { message: string } | null }) {
  if (payload.error) {
    throw new Error(payload.error.message);
  }
  return payload.data;
}

export async function createTestRecord(values: NewTestRecord) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase.from('tests').insert(values).select('*').single();
  return assertNoError(result) as TestRecord;
}

export async function updateTestRecord(testId: string, values: Partial<NewTestRecord>) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('tests')
    .update(values)
    .eq('id', testId)
    .select('*')
    .single();
  return assertNoError(result) as TestRecord;
}

export async function insertTestItems(items: NewTestItemRecord[]) {
  if (items.length === 0) {
    return [] as TestItemRecord[];
  }

  const supabase = getSupabaseServiceRoleClient();
  const inserted: TestItemRecord[] = [];

  for (let i = 0; i < items.length; i += 500) {
    const slice = items.slice(i, i + 500);
    const result = await supabase.from('test_items').insert(slice).select('*');
    const data = assertNoError(result);
    inserted.push(...((data || []) as TestItemRecord[]));
  }

  return inserted;
}

export async function listTests() {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('tests')
    .select('*')
    .order('uploaded_at', { ascending: false });

  return (assertNoError(result) || []) as TestRecord[];
}

export async function getTestById(testId: string) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('tests')
    .select('*')
    .eq('id', testId)
    .single();

  return assertNoError(result) as TestRecord;
}

const TEST_ITEMS_PAGE_SIZE = 1000;

/** Fetches every row for the test (Supabase caps single queries at `max_rows`, often 1000). */
export async function getTestItemsByTestId(testId: string) {
  const supabase = getSupabaseServiceRoleClient();
  const all: TestItemRecord[] = [];
  let from = 0;

  while (true) {
    const result = await supabase
      .from('test_items')
      .select('*')
      .eq('test_id', testId)
      .order('row_index', { ascending: true })
      .range(from, from + TEST_ITEMS_PAGE_SIZE - 1);

    const page = (assertNoError(result) || []) as TestItemRecord[];
    all.push(...page);
    if (page.length < TEST_ITEMS_PAGE_SIZE) {
      break;
    }
    from += TEST_ITEMS_PAGE_SIZE;
  }

  return all;
}

/**
 * Lightweight fetch of columns used to build distinct “Add prompt” combobox options
 * (avoids relying on the full table row shape in callers).
 */
export async function getTestItemSuggestionRows(testId: string) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_items')
    .select(
      'expected_result_type, expected_canonical_product, expected_reason_code, input_payload',
    )
    .eq('test_id', testId);

  return (assertNoError(result) || []) as Pick<
    TestItemRecord,
    'expected_result_type' | 'expected_canonical_product' | 'expected_reason_code' | 'input_payload'
  >[];
}

/** Largest `row_index` for the test, or `0` when there are no items. */
export async function getMaxRowIndexForTest(testId: string): Promise<number> {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_items')
    .select('row_index')
    .eq('test_id', testId)
    .order('row_index', { ascending: false })
    .limit(1);

  const rows = assertNoError(result) || [];
  const row = rows[0];
  return typeof row?.row_index === 'number' ? row.row_index : 0;
}

export async function getTestItemById(testItemId: string) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_items')
    .select('*')
    .eq('id', testItemId)
    .single();

  return assertNoError(result) as TestItemRecord;
}

/**
 * Deletes one prompt row scoped to `testId`. Cascades `test_result_items` per FK.
 * Returns whether a row was removed (false if id did not belong to this test).
 */
export async function deleteTestItemForTest(testItemId: string, testId: string) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_items')
    .delete()
    .eq('id', testItemId)
    .eq('test_id', testId)
    .select('id');

  const deleted = assertNoError(result) as { id: string }[] | null;
  if (!deleted?.length) {
    return false;
  }

  const test = await getTestById(testId);
  await updateTestRecord(testId, {
    row_count: Math.max(0, test.row_count - 1),
  });
  return true;
}

export async function createTestResult(values: NewTestResultRecord) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_results')
    .insert(values)
    .select('*')
    .single();
  return assertNoError(result) as TestResultRecord;
}

export async function updateTestResult(
  resultId: string,
  values: Partial<NewTestResultRecord>,
) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_results')
    .update(values)
    .eq('id', resultId)
    .select('*')
    .single();

  return assertNoError(result) as TestResultRecord;
}

export async function claimQueuedTestResultForExecution(resultId: string) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_results')
    .update({ status: 'running' })
    .eq('id', resultId)
    .eq('status', 'queued')
    .select('id');

  const data = assertNoError(result);
  return Array.isArray(data) && data.length > 0;
}

export async function insertTestResultItems(items: NewTestResultItemRecord[]) {
  if (items.length === 0) {
    return [] as TestResultItemRecord[];
  }

  const supabase = getSupabaseServiceRoleClient();
  const inserted: TestResultItemRecord[] = [];

  for (let i = 0; i < items.length; i += 500) {
    const slice = items.slice(i, i + 500);
    const result = await supabase.from('test_result_items').insert(slice).select('*');
    const data = assertNoError(result);
    inserted.push(...((data || []) as TestResultItemRecord[]));
  }

  return inserted;
}

export async function listTestResultsByTestId(testId: string, limit = 10) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_results')
    .select('*')
    .eq('test_id', testId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return (assertNoError(result) || []) as TestResultRecord[];
}

export async function getTestResultById(testResultId: string) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_results')
    .select('*')
    .eq('id', testResultId)
    .single();

  return assertNoError(result) as TestResultRecord;
}

const RESULT_ITEMS_PAGE_SIZE = 500;

export async function listResultItemsByResultId(testResultId: string, limit = 200) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_result_items')
    .select('*')
    .eq('test_result_id', testResultId)
    .order('row_index', { ascending: true })
    .limit(limit);

  return (assertNoError(result) || []) as TestResultItemRecord[];
}

/** All rows for a run (Supabase default `max_rows` requires pagination beyond ~1000). */
export async function listAllResultItemsByResultId(testResultId: string) {
  const supabase = getSupabaseServiceRoleClient();
  const all: TestResultItemRecord[] = [];
  let from = 0;

  while (true) {
    const result = await supabase
      .from('test_result_items')
      .select('*')
      .eq('test_result_id', testResultId)
      .order('row_index', { ascending: true })
      .range(from, from + RESULT_ITEMS_PAGE_SIZE - 1);

    const page = (assertNoError(result) || []) as TestResultItemRecord[];
    all.push(...page);
    if (page.length < RESULT_ITEMS_PAGE_SIZE) {
      break;
    }
    from += RESULT_ITEMS_PAGE_SIZE;
  }

  return all;
}

export async function listResultItemsByTestItemId(testItemId: string, limit = 500) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_result_items')
    .select('*')
    .eq('test_item_id', testItemId)
    .order('created_at', { ascending: false })
    .limit(limit);

  return (assertNoError(result) || []) as TestResultItemRecord[];
}

export async function countResultItemsByResultId(testResultId: string) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_result_items')
    .select('*', { count: 'exact', head: true })
    .eq('test_result_id', testResultId);

  if (result.error) {
    throw new Error(result.error.message);
  }

  return result.count ?? 0;
}

export async function deleteTestById(testId: string) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase.from('tests').delete().eq('id', testId);
  assertNoError(result);
}

export async function deleteTestResultById(testResultId: string) {
  const supabase = getSupabaseServiceRoleClient();

  const itemDelete = await supabase
    .from('test_result_items')
    .delete()
    .eq('test_result_id', testResultId);
  assertNoError(itemDelete);

  const resultDelete = await supabase.from('test_results').delete().eq('id', testResultId);
  assertNoError(resultDelete);
}
