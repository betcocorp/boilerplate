import { assertSupabaseNoError as assertNoError } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import {
  extractItemSimilarityScore,
  extractSearchRunMaxSimilarity,
} from './response-payload';
import { extractExpectedTool, parseAgentStepToolTrace } from './tool-routing';
import { COMPLETED_RUN_STATUSES } from './types';
import type {
  LatestFailedTestResultItemView,
  NewTestItemRecord,
  NewTestRecord,
  NewTestResultItemRecord,
  NewTestResultRecord,
  TestItemRecord,
  TestRecord,
  TestResultItemRecord,
  TestResultRecord,
} from './types';

async function fetchAllPages<T>(
  pageSize: number,
  fetcher: (from: number, to: number) => PromiseLike<T[]>,
): Promise<T[]> {
  const all: T[] = [];
  let from = 0;
  while (true) {
    const page = await fetcher(from, from + pageSize - 1);
    all.push(...page);
    if (page.length < pageSize) {
      break;
    }
    from += pageSize;
  }
  return all;
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

export type TestItemSuggestionRow = Pick<
  TestItemRecord,
  | 'expected_result_type'
  | 'expected_canonical_product'
  | 'expected_reason_code'
  | 'source'
  | 'input_payload'
>;

/** Fetches every row for the test (Supabase caps single queries at `max_rows`, often 1000). */
export async function getTestItemsByTestId(testId: string) {
  const supabase = getSupabaseServiceRoleClient();
  return fetchAllPages<TestItemRecord>(TEST_ITEMS_PAGE_SIZE, (from, to) =>
    supabase
      .from('test_items')
      .select('*')
      .eq('test_id', testId)
      .order('row_index', { ascending: true })
      .range(from, to)
      .then((r) => (assertNoError(r) || []) as TestItemRecord[]),
  );
}

/**
 * Lightweight fetch of columns used to build distinct “Add prompt” combobox options
 * (avoids relying on the full table row shape in callers).
 */
export async function getTestItemSuggestionRows(testId: string): Promise<TestItemSuggestionRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  return fetchAllPages<TestItemSuggestionRow>(TEST_ITEMS_PAGE_SIZE, (from, to) =>
    supabase
      .from('test_items')
      .select(
        'expected_result_type, expected_canonical_product, expected_reason_code, source, input_payload',
      )
      .eq('test_id', testId)
      .order('row_index', { ascending: true })
      .range(from, to)
      .then((r) => (assertNoError(r) || []) as TestItemSuggestionRow[]),
  );
}

/**
 * Distinct-value source rows from **all** tests (admin “Add prompt” comboboxes should not depend on which dataset is open).
 */
export async function getGlobalTestItemSuggestionRows(): Promise<TestItemSuggestionRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  return fetchAllPages<TestItemSuggestionRow>(TEST_ITEMS_PAGE_SIZE, (from, to) =>
    supabase
      .from('test_items')
      .select(
        'expected_result_type, expected_canonical_product, expected_reason_code, source, input_payload',
      )
      .order('id', { ascending: true })
      .range(from, to)
      .then((r) => (assertNoError(r) || []) as TestItemSuggestionRow[]),
  );
}

const LEGACY_PROD_LINE_PAGE_SIZE = 1000;

export type LegacyProductLineSuggestionMeta = {
  /** Sorted `ProdLineKey` values for merging into combobox option values (submitted form still uses key). */
  keys: string[];
  /** Human-facing name per key (from `ProdLineDescr`); duplicate names get `Name (ProdLineKey)` suffix. */
  labelByKey: Record<string, string>;
};

function disambiguateProductLineLabels(labelByKey: Record<string, string>): Record<string, string> {
  const byLabel = new Map<string, string[]>();
  for (const [key, label] of Object.entries(labelByKey)) {
    const list = byLabel.get(label);
    if (list) {
      list.push(key);
    } else {
      byLabel.set(label, [key]);
    }
  }

  const out = { ...labelByKey };
  for (const keys of byLabel.values()) {
    if (keys.length <= 1) {
      continue;
    }
    for (const key of keys) {
      out[key] = `${labelByKey[key]} (${key})`;
    }
  }
  return out;
}

/**
 * Legacy product lines for admin test UI: stable keys plus display labels from `ProdLineDescr`.
 */
export async function getLegacyProductLineSuggestionMeta(): Promise<LegacyProductLineSuggestionMeta> {
  const supabase = getSupabaseServiceRoleClient();
  const legacy = supabase.schema('legacy');
  /** First non-empty `ProdLineDescr` per key (pagination order is stable enough with dedupe). */
  const firstDescrByKey = new Map<string, string | null>();
  let from = 0;

  while (true) {
    const result = await legacy
      .from('prod_line')
      .select('ProdLineKey, ProdLineDescr')
      .order('ProdLineKey', { ascending: true })
      .range(from, from + LEGACY_PROD_LINE_PAGE_SIZE - 1);

    const page = (assertNoError(result) || []) as {
      ProdLineKey: string | null;
      ProdLineDescr: string | null;
    }[];

    for (const row of page) {
      const k = typeof row.ProdLineKey === 'string' ? row.ProdLineKey.trim() : '';
      if (!k) {
        continue;
      }
      const d =
        typeof row.ProdLineDescr === 'string' && row.ProdLineDescr.trim()
          ? row.ProdLineDescr.trim()
          : null;
      if (!firstDescrByKey.has(k)) {
        firstDescrByKey.set(k, d);
      } else if (d && firstDescrByKey.get(k) == null) {
        firstDescrByKey.set(k, d);
      }
    }

    if (page.length < LEGACY_PROD_LINE_PAGE_SIZE) {
      break;
    }
    from += LEGACY_PROD_LINE_PAGE_SIZE;
  }

  const raw: Record<string, string> = {};
  for (const [key, descr] of firstDescrByKey) {
    raw[key] = descr ?? key;
  }

  const labelByKey = disambiguateProductLineLabels(raw);
  const keys = Object.keys(labelByKey).sort((a, b) => a.localeCompare(b));

  return { keys, labelByKey };
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

/**
 * Updates one prompt row scoped to `testId` (so a stray id from another dataset
 * cannot be edited). Returns the updated record, or `null` if the id did not
 * belong to this test.
 */
export async function updateTestItemForTest(
  testItemId: string,
  testId: string,
  values: Partial<NewTestItemRecord>,
) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_items')
    .update(values)
    .eq('id', testItemId)
    .eq('test_id', testId)
    .select('*');

  const updated = assertNoError(result) as TestItemRecord[] | null;
  return updated?.[0] ?? null;
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

/** Persists the "Analyze this run" AI insights so they survive page reloads. */
export async function saveTestResultInsights(
  resultId: string,
  insights: NewTestResultRecord['insights'],
) {
  return updateTestResult(resultId, {
    insights,
    insights_generated_at: new Date().toISOString(),
  });
}

/** Reads back the "Generate report" checkpointed progress/state for a run (B0-453). */
export async function getReportState(resultId: string) {
  const result = await getTestResultById(resultId);
  return result.report_state;
}

/** Persists checkpointed "Generate report" progress so scoring can resume across requests. */
export async function saveReportState(
  resultId: string,
  reportState: NewTestResultRecord['report_state'],
) {
  return updateTestResult(resultId, { report_state: reportState });
}

/** Persists the final rendered Markdown eval report once every case has been scored. */
export async function saveReportMarkdown(
  resultId: string,
  markdown: string,
  generatedAt: string,
) {
  return updateTestResult(resultId, {
    report: markdown,
    report_generated_at: generatedAt,
  });
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
    .eq('run_mode', 'full')
    .order('created_at', { ascending: false })
    .limit(limit);

  return (assertNoError(result) || []) as TestResultRecord[];
}

export async function listSearchResultsByTestId(testId: string, limit = 10) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_results')
    .select('*')
    .eq('test_id', testId)
    .eq('run_mode', 'search')
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
const TEST_CASE_METRICS_PAGE_SIZE = 1000;
const TEST_RUNS_PAGE_SIZE = 500;
const COMPLETED_TEST_RUN_STATUSES = COMPLETED_RUN_STATUSES;

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

/**
 * Single-query fetch of every `test_result_items` row across multiple runs.
 * Used to build per-prompt aggregations on the dataset detail page (avoids
 * issuing one query per run).
 */
export async function listAllResultItemsByResultIds(testResultIds: string[]) {
  if (testResultIds.length === 0) {
    return [] as TestResultItemRecord[];
  }

  const supabase = getSupabaseServiceRoleClient();
  return fetchAllPages<TestResultItemRecord>(RESULT_ITEMS_PAGE_SIZE, (from, to) =>
    supabase
      .from('test_result_items')
      .select('*')
      .in('test_result_id', testResultIds)
      .order('created_at', { ascending: true })
      .range(from, to)
      .then((r) => (assertNoError(r) || []) as TestResultItemRecord[]),
  );
}

/** All rows for a run (Supabase default `max_rows` requires pagination beyond ~1000). */
export async function listAllResultItemsByResultId(testResultId: string) {
  const supabase = getSupabaseServiceRoleClient();
  return fetchAllPages<TestResultItemRecord>(RESULT_ITEMS_PAGE_SIZE, (from, to) =>
    supabase
      .from('test_result_items')
      .select('*')
      .eq('test_result_id', testResultId)
      .order('row_index', { ascending: true })
      .range(from, to)
      .then((r) => (assertNoError(r) || []) as TestResultItemRecord[]),
  );
}

export async function getGlobalTestCaseMetrics() {
  const supabase = getSupabaseServiceRoleClient();
  const completedRunRows = await fetchAllPages<{ id: string }>(TEST_RUNS_PAGE_SIZE, (from, to) =>
    supabase
      .from('test_results')
      .select('id')
      .in('status', [...COMPLETED_TEST_RUN_STATUSES])
      .order('created_at', { ascending: true })
      .range(from, to)
      .then((r) => (assertNoError(r) || []) as Array<{ id: string }>),
  );
  const completedRunIds = completedRunRows.map((run) => run.id);

  if (completedRunIds.length === 0) {
    return {
      totalCases: 0,
      passedCases: 0,
      failedCases: 0,
      passRate: 0,
      failRate: 0,
      avgElapsedMs: 0,
      avgSimilarity: null,
      similaritySampleSize: 0,
    };
  }

  let from = 0;
  let totalCases = 0;
  let passedCases = 0;
  let failedCases = 0;
  let elapsedSumMs = 0;
  let similaritySum = 0;
  let similarityCount = 0;

  while (true) {
    const result = await supabase
      .from('test_result_items')
      .select('passed, elapsed_ms, response_payload, status, test_result_id')
      .in('status', ['completed', 'failed'])
      .in('test_result_id', completedRunIds)
      .order('created_at', { ascending: true })
      .range(from, from + TEST_CASE_METRICS_PAGE_SIZE - 1);

    const page = (assertNoError(result) || []) as Array<{
      passed: boolean;
      elapsed_ms: number;
      response_payload: unknown;
      status: string;
      test_result_id: string;
    }>;

    if (page.length === 0) {
      break;
    }

    for (const item of page) {
      totalCases += 1;
      elapsedSumMs += Math.max(0, item.elapsed_ms || 0);
      if (item.passed) {
        passedCases += 1;
      } else {
        failedCases += 1;
      }

      const similarity = extractItemSimilarityScore(item.response_payload);
      if (typeof similarity === 'number') {
        similaritySum += similarity;
        similarityCount += 1;
      }
    }

    if (page.length < TEST_CASE_METRICS_PAGE_SIZE) {
      break;
    }
    from += TEST_CASE_METRICS_PAGE_SIZE;
  }

  return {
    totalCases,
    passedCases,
    failedCases,
    passRate: totalCases > 0 ? passedCases / totalCases : 0,
    failRate: totalCases > 0 ? failedCases / totalCases : 0,
    avgElapsedMs: totalCases > 0 ? elapsedSumMs / totalCases : 0,
    avgSimilarity: similarityCount > 0 ? similaritySum / similarityCount : null,
    similaritySampleSize: similarityCount,
  };
}

type RunSimilarityAccumulator = {
  similaritySum: number;
  similarityCount: number;
};

export async function getGlobalSimilarityFailRateTrend(options?: { maxRuns?: number }) {
  const maxRuns = Math.min(Math.max(options?.maxRuns ?? 30, 2), 200);
  const supabase = getSupabaseServiceRoleClient();

  const runsResult = await supabase
    .from('test_results')
    .select('id, created_at, failed_items, total_items')
    .in('status', [...COMPLETED_TEST_RUN_STATUSES])
    .order('created_at', { ascending: false })
    .limit(maxRuns);

  const runs = (assertNoError(runsResult) || []) as Array<{
    id: string;
    created_at: string;
    failed_items: number;
    total_items: number;
  }>;

  if (runs.length === 0) {
    return [];
  }

  const orderedRuns = [...runs].reverse();
  const runIds = orderedRuns.map((run) => run.id);
  const similarityByRunId = new Map<string, RunSimilarityAccumulator>(
    runIds.map((id) => [id, { similaritySum: 0, similarityCount: 0 }]),
  );

  let from = 0;

  while (true) {
    const result = await supabase
      .from('test_result_items')
      .select('test_result_id, response_payload, status')
      .in('status', ['completed', 'failed'])
      .in('test_result_id', runIds)
      .order('created_at', { ascending: true })
      .range(from, from + TEST_CASE_METRICS_PAGE_SIZE - 1);

    const page = (assertNoError(result) || []) as Array<{
      test_result_id: string;
      response_payload: unknown;
      status: string;
    }>;

    if (page.length === 0) {
      break;
    }

    for (const item of page) {
      const accumulator = similarityByRunId.get(item.test_result_id);
      if (!accumulator) {
        continue;
      }

      const similarity = extractItemSimilarityScore(item.response_payload);
      if (typeof similarity === 'number') {
        accumulator.similaritySum += similarity;
        accumulator.similarityCount += 1;
      }
    }

    if (page.length < TEST_CASE_METRICS_PAGE_SIZE) {
      break;
    }
    from += TEST_CASE_METRICS_PAGE_SIZE;
  }

  return orderedRuns.map((run, index) => {
    const similarity = similarityByRunId.get(run.id);
    return {
      label: `Run ${index + 1}`,
      runCreatedAt: run.created_at,
      avgSimilarity:
        similarity && similarity.similarityCount > 0
          ? similarity.similaritySum / similarity.similarityCount
          : null,
      failRate: run.total_items > 0 ? run.failed_items / run.total_items : 0,
      totalCases: run.total_items,
    };
  });
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

/** Returns the count of passed=true and passed=false rows for a result. */
export async function countPassedAndFailedByResultId(
  testResultId: string,
): Promise<{ passed: number; failed: number }> {
  const supabase = getSupabaseServiceRoleClient();
  const [passedResult, failedResult] = await Promise.all([
    supabase
      .from('test_result_items')
      .select('*', { count: 'exact', head: true })
      .eq('test_result_id', testResultId)
      .eq('passed', true),
    supabase
      .from('test_result_items')
      .select('*', { count: 'exact', head: true })
      .eq('test_result_id', testResultId)
      .eq('passed', false),
  ]);
  return {
    passed: passedResult.count ?? 0,
    failed: failedResult.count ?? 0,
  };
}

/**
 * Returns the set of test_item_ids that already have a result record for this run.
 * Used by executors to skip already-processed items, enabling correct resume and retry behaviour
 * when result records may have gaps (e.g. after deleting errored items for a retry).
 */
export async function getExistingResultItemIds(testResultId: string): Promise<Set<string>> {
  const supabase = getSupabaseServiceRoleClient();
  const ids = new Set<string>();
  let from = 0;
  while (true) {
    const result = await supabase
      .from('test_result_items')
      .select('test_item_id')
      .eq('test_result_id', testResultId)
      .range(from, from + RESULT_ITEMS_PAGE_SIZE - 1);
    if (result.error) throw new Error(result.error.message);
    for (const row of result.data ?? []) {
      ids.add(row.test_item_id);
    }
    if (!result.data || result.data.length < RESULT_ITEMS_PAGE_SIZE) break;
    from += RESULT_ITEMS_PAGE_SIZE;
  }
  return ids;
}

/**
 * Deletes result items that represent execution errors (not evaluation failures):
 *   - status='failed'  — test executor catch block (e.g. TypeError: fetch failed)
 *   - response_payload.error present — search executor catch block
 * Returns the number of rows deleted.
 */
export async function deleteErroredResultItems(testResultId: string): Promise<number> {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_result_items')
    .select('id, status, response_payload')
    .eq('test_result_id', testResultId);
  if (result.error) throw new Error(result.error.message);

  const erroredIds = (result.data ?? [])
    .filter((item) => {
      if (item.status === 'failed') return true;
      const p = item.response_payload;
      return p !== null && typeof p === 'object' && !Array.isArray(p) && 'error' in p;
    })
    .map((item) => item.id);

  if (erroredIds.length === 0) return 0;

  const del = await supabase
    .from('test_result_items')
    .delete()
    .in('id', erroredIds)
    .select('id');
  if (del.error) throw new Error(del.error.message);
  return (del.data ?? []).length;
}

/** Sum of `elapsed_ms` across all result rows for the run (model time per prompt, not wall clock). */
export async function sumResultItemsElapsedMsByResultId(testResultId: string) {
  const supabase = getSupabaseServiceRoleClient();
  let total = 0;
  let from = 0;

  while (true) {
    const result = await supabase
      .from('test_result_items')
      .select('elapsed_ms')
      .eq('test_result_id', testResultId)
      .order('row_index', { ascending: true })
      .range(from, from + RESULT_ITEMS_PAGE_SIZE - 1);

    const rows = (assertNoError(result) || []) as Pick<TestResultItemRecord, 'elapsed_ms'>[];
    for (const row of rows) {
      total += typeof row.elapsed_ms === 'number' && Number.isFinite(row.elapsed_ms) ? row.elapsed_ms : 0;
    }
    if (rows.length < RESULT_ITEMS_PAGE_SIZE) {
      break;
    }
    from += RESULT_ITEMS_PAGE_SIZE;
  }

  return total;
}

/**
 * Averages the per-item max similarity across all completed result rows for a run.
 * Works for both search runs (matches[].similarity) and full agent runs (sources[].similarity).
 */
export async function computeAvgSimilarityForResult(testResultId: string): Promise<number | null> {
  const supabase = getSupabaseServiceRoleClient();
  let sum = 0;
  let count = 0;
  let from = 0;

  while (true) {
    const result = await supabase
      .from('test_result_items')
      .select('response_payload')
      .eq('test_result_id', testResultId)
      .in('status', ['completed', 'failed'])
      .range(from, from + RESULT_ITEMS_PAGE_SIZE - 1);

    const rows = (assertNoError(result) || []) as Pick<TestResultItemRecord, 'response_payload'>[];

    for (const row of rows) {
      const score =
        extractSearchRunMaxSimilarity(row.response_payload) ??
        extractItemSimilarityScore(row.response_payload);
      if (typeof score === 'number') {
        sum += score;
        count += 1;
      }
    }

    if (rows.length < RESULT_ITEMS_PAGE_SIZE) {
      break;
    }
    from += RESULT_ITEMS_PAGE_SIZE;
  }

  return count > 0 ? sum / count : null;
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

const FAILURE_QUEUE_PAGE_SIZE_MAX = 100;
const FAILURE_QUEUE_PAGE_DEFAULT = 25;

function normalizeFailureQueueSearch(value: string) {
  return value
    .trim()
    .replaceAll(',', ' ')
    .replaceAll('%', '')
    .slice(0, 200);
}

function rpcCountToNumber(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

export async function listLatestFailedTestResultItemsPage(options: {
  search: string;
  page: number;
  pageSize: number;
}): Promise<{ rows: LatestFailedTestResultItemView[]; total: number }> {
  const supabase = getSupabaseServiceRoleClient();
  const normalized = normalizeFailureQueueSearch(options.search);
  const pageSize = Math.min(
    Math.max(1, options.pageSize || FAILURE_QUEUE_PAGE_DEFAULT),
    FAILURE_QUEUE_PAGE_SIZE_MAX,
  );
  const page = Math.max(1, options.page);
  const offset = (page - 1) * pageSize;

  const [countRes, pageRes] = await Promise.all([
    supabase.rpc('admin_latest_failures_count', { p_search: normalized }),
    supabase.rpc('admin_latest_failures_page', {
      p_search: normalized,
      p_limit: pageSize,
      p_offset: offset,
    }),
  ]);

  if (countRes.error) {
    throw new Error(countRes.error.message);
  }
  if (pageRes.error) {
    throw new Error(pageRes.error.message);
  }

  const rawRows = pageRes.data;
  const rows = Array.isArray(rawRows)
    ? rawRows
    : rawRows
      ? [rawRows as LatestFailedTestResultItemView]
      : [];

  return {
    rows,
    total: rpcCountToNumber(countRes.data),
  };
}

/** Fetches all latest-failed items (up to 500) for the grouped-by-category view. */
export async function listAllLatestFailedItemsForGroupedView(
  search: string,
): Promise<LatestFailedTestResultItemView[]> {
  const supabase = getSupabaseServiceRoleClient();
  const normalized = normalizeFailureQueueSearch(search);
  const result = await supabase.rpc('admin_latest_failures_page', {
    p_search: normalized,
    p_limit: 500,
    p_offset: 0,
  });
  if (result.error) throw new Error(result.error.message);
  const data = result.data;
  return Array.isArray(data) ? (data as LatestFailedTestResultItemView[]) : [];
}

/** PostgREST `.in()` filter values are URL-encoded; chunk any id list to stay well under any practical URL-length cap. */
const IN_FILTER_CHUNK_SIZE = 150;

export type AgentStepOutputRow = { workflow_run_id: string; output: unknown };

/**
 * B0-383 — the `openai_responses_agent` `workflow_steps` row per workflow run (one per run that
 * reached the agent step; a run that early-declined has none). `output.toolTrace` is the per-call
 * trace the tool-routing report (`~/lib/tests/tool-routing.ts`) is built from — parse it with
 * `parseAgentStepToolTrace` rather than reading `output` directly.
 */
export async function listAgentStepOutputsByWorkflowRunIds(
  workflowRunIds: string[],
): Promise<AgentStepOutputRow[]> {
  if (workflowRunIds.length === 0) {
    return [];
  }

  const supabase = getSupabaseServiceRoleClient();
  const rows: AgentStepOutputRow[] = [];

  for (let i = 0; i < workflowRunIds.length; i += IN_FILTER_CHUNK_SIZE) {
    const chunk = workflowRunIds.slice(i, i + IN_FILTER_CHUNK_SIZE);
    const result = await supabase
      .from('workflow_steps')
      .select('workflow_run_id,output')
      .eq('step_name', 'openai_responses_agent')
      .in('workflow_run_id', chunk);
    assertNoError(result);
    rows.push(...((result.data ?? []) as AgentStepOutputRow[]));
  }

  return rows;
}

export type ToolRoutingQueueRow = {
  resultItemId: string;
  testItemId: string;
  testId: string;
  testName: string;
  rowIndex: number;
  prompt: string;
  expectedTool: string;
  /** Tool names the most recent run for this question actually called; `[]` = none called at all. */
  calledTools: string[];
  runId: string;
  runCreatedAt: string;
};

const TOOL_ROUTING_QUEUE_DEFAULT_LIMIT = 200;

/**
 * B0-383 — misrouted questions for the Failure Queue's "Routing" view: the LATEST run of every
 * test item tagged with `metadata.expected_tool` (see `~/lib/tests/tool-routing.ts`) whose call
 * trace never included that tool. Deliberately keyed off the `metadata->>expected_tool IS NOT NULL`
 * filter rather than scanning every `test_result_item` in the system — this feature is opt-in per
 * item, so until a test author tags items the query touches zero extra rows. Independent of
 * `passed`: a question can pass the pass/fail grader on a decline/refusal and still have called the
 * wrong tool, which is exactly the signal this view exists to surface (unlike
 * `latest_failed_test_result_items`, which is pass/fail only).
 */
export async function listLatestToolRoutingMismatches(
  limit = TOOL_ROUTING_QUEUE_DEFAULT_LIMIT,
): Promise<ToolRoutingQueueRow[]> {
  const supabase = getSupabaseServiceRoleClient();

  const scoredItemsResult = await supabase
    .from('test_items')
    .select('id, test_id, prompt, row_index, metadata')
    .not('metadata->>expected_tool', 'is', null);
  assertNoError(scoredItemsResult);
  const scoredItems = (scoredItemsResult.data ?? []).filter((row) => extractExpectedTool(row.metadata));

  if (scoredItems.length === 0) {
    return [];
  }

  const testIds = [...new Set(scoredItems.map((item) => item.test_id))];
  const testsResult = await supabase.from('tests').select('id,name').in('id', testIds);
  assertNoError(testsResult);
  const testNameById = new Map((testsResult.data ?? []).map((row) => [row.id, row.name]));

  // Latest test_result_item per scored test_item_id — one paginated scan ordered newest-first,
  // keeping only the first (i.e. latest) row seen per test_item_id.
  const testItemIds = scoredItems.map((item) => item.id);
  const latestByTestItemId = new Map<
    string,
    Pick<TestResultItemRecord, 'id' | 'test_item_id' | 'test_result_id' | 'workflow_run_id' | 'created_at'>
  >();
  for (let i = 0; i < testItemIds.length; i += IN_FILTER_CHUNK_SIZE) {
    const chunk = testItemIds.slice(i, i + IN_FILTER_CHUNK_SIZE);
    const result = await supabase
      .from('test_result_items')
      .select('id, test_item_id, test_result_id, workflow_run_id, created_at')
      .in('test_item_id', chunk)
      .order('created_at', { ascending: false });
    assertNoError(result);
    for (const row of result.data ?? []) {
      if (!latestByTestItemId.has(row.test_item_id)) {
        latestByTestItemId.set(row.test_item_id, row);
      }
    }
  }

  const latestRows = [...latestByTestItemId.values()];
  const runIds = [...new Set(latestRows.map((row) => row.test_result_id))];
  const runsResult =
    runIds.length > 0
      ? await supabase.from('test_results').select('id, created_at').in('id', runIds)
      : { data: [], error: null };
  assertNoError(runsResult);
  const runCreatedAtById = new Map((runsResult.data ?? []).map((row) => [row.id, row.created_at]));

  const workflowRunIds = [
    ...new Set(
      latestRows.map((row) => row.workflow_run_id).filter((value): value is string => Boolean(value)),
    ),
  ];
  const agentOutputs = await listAgentStepOutputsByWorkflowRunIds(workflowRunIds);
  const toolTraceByWorkflowRunId = new Map(
    agentOutputs.map((row) => [row.workflow_run_id, parseAgentStepToolTrace(row.output)] as const),
  );

  const mismatches: ToolRoutingQueueRow[] = [];
  for (const item of scoredItems) {
    const expectedTool = extractExpectedTool(item.metadata);
    if (!expectedTool) continue;

    const latest = latestByTestItemId.get(item.id);
    if (!latest) continue; // tagged, but never run yet

    const toolTrace = latest.workflow_run_id
      ? (toolTraceByWorkflowRunId.get(latest.workflow_run_id) ?? null)
      : null;
    const calledTools = (toolTrace ?? []).map((entry) => entry.toolName);
    if (calledTools.includes(expectedTool)) continue; // routed correctly — not a queue row

    mismatches.push({
      resultItemId: latest.id,
      testItemId: item.id,
      testId: item.test_id,
      testName: testNameById.get(item.test_id) ?? 'Unknown test',
      rowIndex: item.row_index,
      prompt: item.prompt,
      expectedTool,
      calledTools,
      runId: latest.test_result_id,
      runCreatedAt: runCreatedAtById.get(latest.test_result_id) ?? latest.created_at,
    });
  }

  return mismatches
    .sort((a, b) => (a.runCreatedAt < b.runCreatedAt ? 1 : a.runCreatedAt > b.runCreatedAt ? -1 : 0))
    .slice(0, limit);
}

export type RoutingComparisonAggregateRow = {
  resultItemId: string;
  testResultId: string;
  rowIndex: number;
  createdAt: string;
  intendedAgentLabel: string | null;
  routingDecision: string | null;
  keywordRoute: string | null;
  llmRoute: string | null;
  routingConfidence: number | null;
};

const ROUTING_COMPARISON_PAGE_SIZE = 500;

/**
 * B0-509 — every `test_result_items` row across ALL tests/runs that carries dual-router
 * instrumentation (`keyword_route IS NOT NULL`, B0-500/501 — the same opt-in filter
 * `listLatestToolRoutingMismatches` uses for its own column). Unlike the per-run
 * `RoutingAccuracyBoard` (B0-502, one `test_result_id`), this powers a system-wide,
 * cross-run rollup (`RoutingComparisonDashboard`), so it is intentionally not scoped to a test or
 * run. `intended_agent_label` / `keyword_route` / `llm_route` / `routing_confidence` /
 * `routing_decision` are plain columns on `test_result_items` (populated at insert time by
 * `buildRoutingComparisonFields`), so no join back to `test_items`/`tests` is needed for the
 * comparison itself.
 */
export async function listRoutingComparisonRows(): Promise<RoutingComparisonAggregateRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  return fetchAllPages<RoutingComparisonAggregateRow>(ROUTING_COMPARISON_PAGE_SIZE, (from, to) =>
    supabase
      .from('test_result_items')
      .select(
        'id, test_result_id, row_index, created_at, intended_agent_label, routing_decision, keyword_route, llm_route, routing_confidence',
      )
      .not('keyword_route', 'is', null)
      .order('created_at', { ascending: true })
      .range(from, to)
      .then((result) => {
        const rows = assertNoError(result) ?? [];
        return rows.map(
          (row): RoutingComparisonAggregateRow => ({
            resultItemId: row.id,
            testResultId: row.test_result_id,
            rowIndex: row.row_index,
            createdAt: row.created_at,
            intendedAgentLabel: row.intended_agent_label,
            routingDecision: row.routing_decision,
            keywordRoute: row.keyword_route,
            llmRoute: row.llm_route,
            routingConfidence: row.routing_confidence,
          }),
        );
      }),
  );
}
