import { APP_VERSION } from '~/lib/app-version';
import { assertSupabaseNoError as assertNoError } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import {
  extractItemSimilarityScore,
  extractRuntimeConfig,
  extractSearchRunMaxSimilarity,
} from './response-payload';
import { parseReportState } from './report/schemas';
import { extractExpectedTool, parseAgentStepToolTrace } from './tool-routing';
import { COMPLETED_RUN_STATUSES } from './types';
import type { ReportOverall, ReportStatus } from './report/schemas';
import { JUDGMENT_CONFIDENCE_PROVENANCES } from '~/lib/workflows/product-support/confidence-provenance';
import type {
  LatestFailedTestResultItemView,
  NewTestItemRecord,
  NewTestRecord,
  NewTestResultComparisonRecord,
  NewTestResultItemRecord,
  NewTestResultRecord,
  RunComparisonFix,
  RunComparisonNewFailure,
  RunComparisonVerdict,
  TestItemRecord,
  TestRecord,
  TestRecordWithCompletionCount,
  TestResultComparisonRecord,
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

const INSERT_TEST_ITEMS_CHUNK_SIZE = 500;

export async function insertTestItems(items: NewTestItemRecord[]) {
  if (items.length === 0) {
    return [] as TestItemRecord[];
  }

  const supabase = getSupabaseServiceRoleClient();
  const inserted: TestItemRecord[] = [];

  for (let i = 0; i < items.length; i += INSERT_TEST_ITEMS_CHUNK_SIZE) {
    const slice = items.slice(i, i + INSERT_TEST_ITEMS_CHUNK_SIZE);
    const result = await supabase.from('test_items').insert(slice).select('*');
    // B0-655 — a bad row anywhere in this chunk aborts the whole insert (never partially, silently
    // drops rows), but the raw Postgrest error alone doesn't say WHICH rows. Report the row_index
    // span of the failing chunk so the real cause (a specific malformed row) is findable instead of
    // just "insert failed". Any rows already inserted from earlier chunks are still left in place —
    // the caller (`uploadTestCsvAction` via `runCreatedRecordOrCleanup`) is responsible for deleting
    // the parent `tests` row on failure, which cascades and removes those partial rows too.
    if (result.error) {
      const rowIndexes = slice
        .map((row) => row.row_index)
        .filter((value): value is number => typeof value === 'number');
      const span =
        rowIndexes.length > 0
          ? `row_index ${Math.min(...rowIndexes)}-${Math.max(...rowIndexes)}`
          : `items ${i}-${i + slice.length - 1}`;
      throw new Error(
        `Failed to insert test items for ${span} (chunk starting at offset ${i} of ${items.length}): ${result.error.message}`,
      );
    }
    inserted.push(...((result.data || []) as TestItemRecord[]));
  }

  return inserted;
}

export async function listTests(includeArchived = false) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('tests')
    .select('*')
    .eq('is_archived', includeArchived ? true : false)
    .order('uploaded_at', { ascending: false });

  const tests = (assertNoError(result) || []) as TestRecord[];

  // Both roll-ups are single, whole-table queries folded in memory — never a per-test fan-out
  // (B0-585 decommissioned that). The score query projects only the scalar JSON path so the heavy
  // `report_state.caseScores` prose stays in Postgres.
  const [completionCounts, reportScores, latestRunScores] = await Promise.all([
    supabase
      .from('test_results')
      .select('test_id')
      .in(
        'status',
        COMPLETED_RUN_STATUSES as unknown as string[],
      ),
    supabase
      .from('test_results')
      .select('test_id, overall_avg:report_state->overall->>avg')
      .eq('report_state->>status', 'completed'),
    supabase
      .from('test_results')
      .select('test_id, overall_avg:report_state->overall->>avg, created_at')
      .eq('report_state->>status', 'completed')
      .order('created_at', { ascending: false }),
  ]);

  const countsByTestId = new Map<string, number>();
  const countData = assertNoError(completionCounts) || [];
  for (const row of countData as Array<{ test_id: string }>) {
    countsByTestId.set(row.test_id, (countsByTestId.get(row.test_id) ?? 0) + 1);
  }

  // B0-630 — PostgREST returns the `->>` projection as a string (or null), so parse and guard.
  const scoreTotalsByTestId = new Map<string, { sum: number; count: number }>();
  const scoreData = assertNoError(reportScores) || [];
  for (const row of scoreData as Array<{ test_id: string; overall_avg: string | null }>) {
    if (typeof row.overall_avg !== 'string' || row.overall_avg.trim() === '') {
      continue;
    }
    const avg = Number(row.overall_avg);
    if (!Number.isFinite(avg)) {
      continue;
    }
    const totals = scoreTotalsByTestId.get(row.test_id) ?? { sum: 0, count: 0 };
    totals.sum += avg;
    totals.count += 1;
    scoreTotalsByTestId.set(row.test_id, totals);
  }

  // Latest and previous run scores per test (first two results after ordering by created_at
  // DESC). The previous score is only used to derive `latest_run_score_delta` below — never
  // rendered on its own.
  const latestRunScoreByTestId = new Map<string, number | null>();
  const previousRunScoreByTestId = new Map<string, number>();
  const latestScoreData = assertNoError(latestRunScores) || [];
  const seenCountByTestId = new Map<string, number>();
  for (const row of latestScoreData as Array<{ test_id: string; overall_avg: string | null }>) {
    const seenCount = seenCountByTestId.get(row.test_id) ?? 0;
    seenCountByTestId.set(row.test_id, seenCount + 1);
    if (seenCount >= 2) {
      continue; // Already found the latest and previous scores for this test
    }

    const avg =
      typeof row.overall_avg === 'string' && row.overall_avg.trim() !== ''
        ? Number(row.overall_avg)
        : NaN;
    const roundedAvg = Number.isFinite(avg) ? Math.round(avg * 10) / 10 : null;

    if (seenCount === 0) {
      latestRunScoreByTestId.set(row.test_id, roundedAvg);
    } else if (roundedAvg !== null) {
      previousRunScoreByTestId.set(row.test_id, roundedAvg);
    }
  }

  return tests.map((test) => {
    const totals = scoreTotalsByTestId.get(test.id);
    const latestRunScore = latestRunScoreByTestId.get(test.id) ?? null;
    const previousRunScore = previousRunScoreByTestId.get(test.id);
    return {
      ...test,
      completed_runs_count: countsByTestId.get(test.id) ?? 0,
      // Rounded to the single decimal the UI renders, so the displayed number and the letter
      // grade derived from it can never disagree at a boundary (an unrounded 89.96 would
      // otherwise render as "90.0/100 (B)").
      avg_report_score:
        totals && totals.count > 0
          ? Math.round((totals.sum / totals.count) * 10) / 10
          : null,
      scored_runs_count: totals?.count ?? 0,
      latest_run_score: latestRunScore,
      latest_run_score_delta:
        latestRunScore !== null && previousRunScore !== undefined
          ? Math.round((latestRunScore - previousRunScore) * 10) / 10
          : null,
    };
  }) as TestRecordWithCompletionCount[];
}

export async function listArchivedTests() {
  return listTests(true);
}

export async function archiveTest(testId: string) {
  return updateTestRecord(testId, { is_archived: true });
}

export async function unarchiveTest(testId: string) {
  return updateTestRecord(testId, { is_archived: false });
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
    // B0-575 — choke point: every run row carries app_version even if a future caller
    // forgets to pass it. An explicit value (e.g. a replayed import) still wins.
    .insert({ app_version: APP_VERSION, ...values })
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

/** Reads back the post-mortem comparison for a run (B0-312). Null when none has been started. */
export async function getRunComparisonByResultId(resultId: string) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_result_comparisons')
    .select('*')
    .eq('test_result_id', resultId)
    .maybeSingle();

  return assertNoError(result) as TestResultComparisonRecord | null;
}

/**
 * B0-312/311 — starts a comparison job by inserting the 'generating' row. A plain INSERT (not
 * upsert) against the `test_result_id` UNIQUE constraint, so a concurrent/duplicate call for the
 * same run fails with a unique-violation instead of silently clobbering the first caller's row —
 * this is what makes `startRunComparison` (`~/lib/tests/run-comparison.ts`) idempotent without a
 * separate locking scheme.
 */
export async function createGeneratingRunComparison(
  resultId: string,
  previousResultId: string,
): Promise<{ created: true; row: TestResultComparisonRecord } | { created: false }> {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_result_comparisons')
    .insert({
      test_result_id: resultId,
      previous_test_result_id: previousResultId,
      status: 'generating',
    })
    .select('*')
    .single();

  if (result.error) {
    if (result.error.code === '23505') {
      return { created: false };
    }
    throw new Error(result.error.message);
  }

  return { created: true, row: result.data as TestResultComparisonRecord };
}

/** Same insert-not-upsert idempotency as `createGeneratingRunComparison`, for the no-baseline case. */
export async function createNoBaselineRunComparison(
  resultId: string,
): Promise<{ created: true } | { created: false }> {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase.from('test_result_comparisons').insert({
    test_result_id: resultId,
    previous_test_result_id: null,
    status: 'no_baseline',
  });

  if (result.error) {
    if (result.error.code === '23505') {
      return { created: false };
    }
    throw new Error(result.error.message);
  }

  return { created: true };
}

async function updateRunComparisonByResultId(
  resultId: string,
  values: Partial<NewTestResultComparisonRecord>,
) {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('test_result_comparisons')
    .update(values)
    .eq('test_result_id', resultId)
    .select('*')
    .single();

  return assertNoError(result) as TestResultComparisonRecord;
}

/** Persists the finished B0-314 LLM analysis and flips the row to 'ready'. */
export async function saveRunComparisonReady(
  resultId: string,
  data: {
    verdict: RunComparisonVerdict;
    verdictSummary: string;
    currentPassRate: number;
    previousPassRate: number;
    scoreDelta: number;
    newFailures: RunComparisonNewFailure[];
    fixes: RunComparisonFix[];
  },
) {
  return updateRunComparisonByResultId(resultId, {
    status: 'ready',
    verdict: data.verdict,
    verdict_summary: data.verdictSummary,
    current_pass_rate: data.currentPassRate,
    previous_pass_rate: data.previousPassRate,
    score_delta: data.scoreDelta,
    new_failures: data.newFailures as unknown as NewTestResultComparisonRecord['new_failures'],
    fixes: data.fixes as unknown as NewTestResultComparisonRecord['fixes'],
    error_message: null,
  });
}

/** Flips an in-progress comparison row to 'failed' so the run-detail page can show the error state. */
export async function saveRunComparisonFailed(resultId: string, errorMessage: string) {
  return updateRunComparisonByResultId(resultId, {
    status: 'failed',
    error_message: errorMessage,
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

  /**
   * B0-575 — choke point: every harness result row carries `app_version`. The known
   * writers (runner.ts, search-run-executor.ts) already stamp it, but the NULL rows that
   * postdate B0-472 came from builds that missed the stamp — defaulting here means a
   * future writer cannot reopen that hole. An explicit value still wins.
   */
  const stamped = items.map((item) => ({ app_version: APP_VERSION, ...item }));

  for (let i = 0; i < stamped.length; i += 500) {
    const slice = stamped.slice(i, i + 500);
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

/**
 * B0-313 — the run immediately preceding `currentResultId` for post-mortem comparison: the most
 * recent OTHER completed run (`completed`/`completed_with_failures`, `run_mode='full'`) on the same
 * test, strictly older than the current run's `created_at`. Returns null when none exists — a
 * "no baseline" run (e.g. the first-ever run of a dataset) is a normal, clean outcome, not an error.
 */
export async function getPreviousCompletedTestResult(
  testId: string,
  currentResultId: string,
): Promise<TestResultRecord | null> {
  const supabase = getSupabaseServiceRoleClient();
  const current = await getTestResultById(currentResultId);

  const result = await supabase
    .from('test_results')
    .select('*')
    .eq('test_id', testId)
    .eq('run_mode', 'full')
    .in('status', [...COMPLETED_RUN_STATUSES])
    .neq('id', currentResultId)
    .lt('created_at', current.created_at)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return assertNoError(result) as TestResultRecord | null;
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

/** One row of the cross-dataset report index (B0-687). */
export type ReportRunRow = {
  runId: string;
  testId: string;
  testName: string;
  /** When the run itself started — the "date run" the index sorts and renders by. */
  startedAt: string;
  reportGeneratedAt: string | null;
  reportStatus: ReportStatus | null;
  /** Overall 0–100 score, present only once the report finished scoring (B0-609). */
  score: number | null;
  grade: ReportOverall['grade'] | null;
  /** Session email of whoever started the run, `api-client` for a service-token run, or null. */
  triggeredBy: string | null;
  /** Model tag from run_options (e.g., 'gpt-4.1', 'gpt-4o-mini', null for unrecorded runs). */
  modelTag: string | null;
  /** Router type from run_options ('llm', 'semantic', 'keyword', or null for settings-driven). */
  routerType: string | null;
  /** App version recorded at run time (B0-733). */
  appVersion: string | null;
};

const REPORT_RUNS_PAGE_SIZE = 500;

/**
 * B0-687 — every run that has an eval report, across all datasets, newest run first.
 *
 * Reports were previously reachable only by drilling into one dataset at a time. The filter is
 * "has a `report_state`" rather than "has a `report_generated_at`" on purpose: a report that is
 * still scoring or that failed is exactly the one an admin needs to find, and dropping those rows
 * would hide them entirely. Score/grade come from the persisted `report_state.overall` (B0-609),
 * never recomputed from per-item data, so this page and `/admin/tests/[testId]` can't disagree.
 *
 * B0-688 — archived datasets are EXCLUDED: an archived test set disappears from this index the
 * same way it disappears from `/admin/tests`. The filter rides on the existing `tests!inner`
 * embed, so it is a join predicate applied in Postgres rather than a post-fetch filter in JS —
 * which also keeps the paging honest (a client-side filter would make each page's row count
 * mean something different from the rows returned).
 */
export async function listAllReportRuns(): Promise<ReportRunRow[]> {
  const supabase = getSupabaseServiceRoleClient();

  type EmbeddedTest = { id: string; name: string; is_archived: boolean };
  type RawRow = {
    id: string;
    test_id: string;
    started_at: string;
    report_generated_at: string | null;
    report_state: unknown;
    triggered_by: string | null;
    run_options: unknown;
    app_version: string | null;
    tests: EmbeddedTest | EmbeddedTest[] | null;
  };

  // Paged rather than a bare select so a growing history can never be silently truncated at
  // PostgREST's 1000-row cap (there are ~40 reported runs today).
  const rows = await fetchAllPages<RawRow>(REPORT_RUNS_PAGE_SIZE, async (from, to) => {
    const result = await supabase
      .from('test_results')
      .select(
        'id, test_id, started_at, report_generated_at, report_state, triggered_by, run_options, app_version, tests!inner(id, name, is_archived)',
      )
      .not('report_state', 'is', null)
      .eq('tests.is_archived', false)
      .order('started_at', { ascending: false })
      .range(from, to);

    return (assertNoError(result) || []) as unknown as RawRow[];
  });

  // B0-733: For runs where routerType is null (settings-driven), query the items to find the
  // actual routing method used. Collect run IDs where we need this data.
  const runIdsNeedingRoutingDecision = rows
    .filter((row) => {
      const runOptions =
        row.run_options && typeof row.run_options === 'object' && !Array.isArray(row.run_options)
          ? (row.run_options as Record<string, unknown>)
          : {};
      const routerType = typeof runOptions.routerType === 'string' ? runOptions.routerType : null;
      return routerType === null;
    })
    .map((row) => row.id);

  // Fetch one routing_decision per run (we just need to know what method was used, not count them)
  const actualRoutingByRunId = new Map<string, string>();
  if (runIdsNeedingRoutingDecision.length > 0) {
    const result = await supabase
      .from('test_result_items')
      .select('test_result_id, routing_decision')
      .in('test_result_id', runIdsNeedingRoutingDecision)
      .not('routing_decision', 'is', null)
      .limit(runIdsNeedingRoutingDecision.length); // One per run is enough

    const items = (assertNoError(result) || []) as Array<{
      test_result_id: string;
      routing_decision: string | null;
    }>;

    for (const item of items) {
      if (
        item.routing_decision &&
        typeof item.routing_decision === 'string' &&
        !actualRoutingByRunId.has(item.test_result_id)
      ) {
        actualRoutingByRunId.set(item.test_result_id, item.routing_decision);
      }
    }
  }

  return rows.map((row) => {
    const test = Array.isArray(row.tests) ? row.tests[0] : row.tests;
    const state = parseReportState(row.report_state);
    const overall = state?.status === 'completed' ? state.overall : null;

    const runOptions =
      row.run_options && typeof row.run_options === 'object' && !Array.isArray(row.run_options)
        ? (row.run_options as Record<string, unknown>)
        : {};
    const modelTag = typeof runOptions.modelTag === 'string' ? runOptions.modelTag : null;
    let routerType = typeof runOptions.routerType === 'string' ? runOptions.routerType : null;

    // If routerType is null (settings-driven), use the actual routing method from items
    if (routerType === null && actualRoutingByRunId.has(row.id)) {
      routerType = actualRoutingByRunId.get(row.id) ?? null;
    }

    return {
      runId: row.id,
      testId: row.test_id,
      testName: test?.name ?? '(deleted dataset)',
      startedAt: row.started_at,
      reportGeneratedAt: row.report_generated_at,
      reportStatus: state?.status ?? null,
      score: typeof overall?.avg === 'number' ? overall.avg : null,
      grade: overall?.grade ?? null,
      triggeredBy: row.triggered_by,
      modelTag,
      routerType,
      appVersion: row.app_version,
    };
  });
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

/**
 * B0-492 — CI's `avg_confidence` gate used to average every item's `confidence` regardless of
 * provenance: a regex constant (`decline_gate_constant`, `validator_bypassed_heuristic`) sitting in
 * the same mean as an actual model judgment (`validator_judged`). This computes the average over
 * ONLY `validator_judged` items (see `JUDGMENT_CONFIDENCE_PROVENANCES`), and reports how many items that was
 * over so a reader can tell "no judgment items ran" apart from "the judgment average is 0".
 *
 * B0-495 — filters on the generated `confidence_provenance` column and selects only the generated
 * `confidence` column (both stored/indexed — see `test_result_items_confidence_provenance_confidence_idx`),
 * instead of fetching every row's full `response_payload` JSON and parsing it in JS. `EXPLAIN`
 * confirms an index-only scan for this exact filter+column shape.
 */
export async function computeAvgJudgmentConfidenceForResult(
  testResultId: string,
): Promise<{ avg: number | null; itemCount: number }> {
  const supabase = getSupabaseServiceRoleClient();
  let sum = 0;
  let count = 0;
  let from = 0;

  while (true) {
    const result = await supabase
      .from('test_result_items')
      .select('confidence')
      .eq('test_result_id', testResultId)
      .in('status', ['completed', 'failed'])
      .in('confidence_provenance', [...JUDGMENT_CONFIDENCE_PROVENANCES])
      .not('confidence', 'is', null)
      .range(from, from + RESULT_ITEMS_PAGE_SIZE - 1);

    const rows = (assertNoError(result) || []) as Pick<TestResultItemRecord, 'confidence'>[];

    for (const row of rows) {
      if (typeof row.confidence === 'number') {
        sum += row.confidence;
        count += 1;
      }
    }

    if (rows.length < RESULT_ITEMS_PAGE_SIZE) {
      break;
    }
    from += RESULT_ITEMS_PAGE_SIZE;
  }

  return { avg: count > 0 ? sum / count : null, itemCount: count };
}

/**
 * B0-494 — a run executed under the B0-452 master confidence-gate kill switch
 * (`BEX_DISABLE_CONFIDENCE_GATING`) has fictional confidence caps: the gate detected something but
 * was told not to act on it. CI must not silently let such a run satisfy `confidence_floor`, so the
 * `/gate` endpoint calls this to check whether ANY item in the run recorded
 * `runtimeConfig.confidenceGatingDisabled === true` before trusting `avg_confidence` at all.
 */
export async function anyResultItemHasConfidenceGatingDisabled(
  testResultId: string,
): Promise<boolean> {
  const supabase = getSupabaseServiceRoleClient();
  let from = 0;

  while (true) {
    const result = await supabase
      .from('test_result_items')
      .select('response_payload')
      .eq('test_result_id', testResultId)
      .in('status', ['completed', 'failed'])
      .range(from, from + RESULT_ITEMS_PAGE_SIZE - 1);

    const rows = (assertNoError(result) || []) as Pick<TestResultItemRecord, 'response_payload'>[];

    if (rows.some((row) => extractRuntimeConfig(row.response_payload)?.confidenceGatingDisabled)) {
      return true;
    }

    if (rows.length < RESULT_ITEMS_PAGE_SIZE) {
      break;
    }
    from += RESULT_ITEMS_PAGE_SIZE;
  }

  return false;
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

/**
 * B0-790 — the `orchestration_planner` `workflow_steps` row per workflow run (the ONE step every
 * run has, per `run-product-support-workflow.ts`). `output.gates` may contain a `signals_analysis`
 * entry — parse it with `parseSignalsAnalysisGate` (`~/lib/tests/signal-accuracy.ts`) rather than
 * reading `output` directly. Sibling of `listAgentStepOutputsByWorkflowRunIds` above, same
 * chunked-`.in()` shape, different `step_name`.
 */
export async function listOrchestrationPlannerStepOutputsByWorkflowRunIds(
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
      .eq('step_name', 'orchestration_planner')
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
 * test item tagged with `expected_tool` (see `~/lib/tests/tool-routing.ts`) whose call
 * trace never included that tool. Deliberately keyed off the `expected_tool IS NOT NULL`
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
    .select('id, test_id, prompt, row_index, expected_tool')
    .not('expected_tool', 'is', null);
  assertNoError(scoredItemsResult);
  const scoredItems = (scoredItemsResult.data ?? []).filter((row) => extractExpectedTool(row.expected_tool));

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
    const expectedTool = extractExpectedTool(item.expected_tool);
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
  /** B0-524 — null on rows predating the latency columns. */
  keywordRouteLatencyMs: number | null;
  llmRouteLatencyMs: number | null;
  /** B0-652 — null on rows predating the semantic-router columns, or where the router wasn't reached. */
  semanticRoute: string | null;
  semanticConfidence: number | null;
  semanticMargin: number | null;
  semanticPath: string | null;
  semanticRouteLatencyMs: number | null;
  semanticEmbeddingMs: number | null;
  semanticScoringMs: number | null;
  routingAgreement: string | null;
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
 *
 * B0-652 adds the `semantic_*` / `routing_agreement` columns to the same projection. The
 * `keyword_route IS NOT NULL` filter is deliberately NOT changed to key off `semantic_route`:
 * every row already collected under the two-router instrumentation must keep flowing to the
 * dashboard, with its semantic fields simply null.
 */
export async function listRoutingComparisonRows(): Promise<RoutingComparisonAggregateRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  return fetchAllPages<RoutingComparisonAggregateRow>(ROUTING_COMPARISON_PAGE_SIZE, (from, to) =>
    supabase
      .from('test_result_items')
      .select(
        'id, test_result_id, row_index, created_at, intended_agent_label, routing_decision, keyword_route, llm_route, routing_confidence, keyword_route_latency_ms, llm_route_latency_ms, semantic_route, semantic_confidence, semantic_margin, semantic_path, semantic_route_latency_ms, semantic_embedding_ms, semantic_scoring_ms, routing_agreement',
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
            keywordRouteLatencyMs: row.keyword_route_latency_ms,
            llmRouteLatencyMs: row.llm_route_latency_ms,
            semanticRoute: row.semantic_route,
            semanticConfidence: row.semantic_confidence,
            semanticMargin: row.semantic_margin,
            semanticPath: row.semantic_path,
            semanticRouteLatencyMs: row.semantic_route_latency_ms,
            semanticEmbeddingMs: row.semantic_embedding_ms,
            semanticScoringMs: row.semantic_scoring_ms,
            routingAgreement: row.routing_agreement,
          }),
        );
      }),
  );
}
