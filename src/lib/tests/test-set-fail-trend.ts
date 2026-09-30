import { assertSupabaseNoError as assertNoError } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { FailTrendRunRow } from './report-fail-trend';
import { onlyMetricEligibleRuns } from './run-mode';

/**
 * B0-1015 — fail-count history for the trend card above "Test sets" on `/admin/tests`.
 *
 * ## Why this is not `listAllReportRuns`
 * That reader (B0-687, used by `/admin/tests/reports`) additionally fans out over
 * `test_result_items` to average TTFT and elapsed time per run — work this page has no use for,
 * on the one page whose per-test fan-outs were deliberately decommissioned (B0-585). This is the
 * whole history as ONE query over `test_results`, projecting only the five fields the fold reads.
 *
 * ## Which runs are plotted
 * Exactly the population the "Fails" column reads (`listTests`): non-archived datasets, runs
 * whose `report_state.status` is `completed`, and only metric-eligible run modes
 * (`onlyMetricEligibleRuns`, B0-1103 — a `partial` run is never a point). That equality is the
 * point — the last point of a series is the same number as that dataset's "Fails" cell in the
 * table directly below the chart, so the two can never appear to disagree.
 *
 * `started_at` is the X value (matching `ReportRunRow.startedAt`), while `listTests` orders its
 * latest-run lookup by `created_at`. The two differ only by the queue-to-start gap, and never
 * reorder runs of the same dataset in practice — a run cannot start before the one that produced
 * it was created.
 */

const FAIL_TREND_PAGE_SIZE = 500;

type RawRow = {
  id: string;
  test_id: string;
  started_at: string;
  failed_items: number | null;
  tests: { name: string } | { name: string }[] | null;
};

export async function listTestSetFailTrendRuns(options?: {
  /** When true, only datasets flagged `is_golden` — mirrors the page's "only golden" toggle. */
  onlyGolden?: boolean;
}): Promise<FailTrendRunRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const rows: RawRow[] = [];

  // Paged so a growing history can never be silently truncated at PostgREST's 1000-row cap.
  for (let from = 0; ; from += FAIL_TREND_PAGE_SIZE) {
    let query = onlyMetricEligibleRuns(
      supabase
        .from('test_results')
        .select('id, test_id, started_at, failed_items, tests!inner(name, is_archived, is_golden)'),
    )
      .eq('report_state->>status', 'completed')
      .eq('tests.is_archived', false)
      .order('started_at', { ascending: false })
      .range(from, from + FAIL_TREND_PAGE_SIZE - 1);

    if (options?.onlyGolden) {
      query = query.eq('tests.is_golden', true);
    }

    const page = (assertNoError(await query) || []) as unknown as RawRow[];
    rows.push(...page);
    if (page.length < FAIL_TREND_PAGE_SIZE) {
      break;
    }
  }

  return rows.map((row) => {
    const test = Array.isArray(row.tests) ? row.tests[0] : row.tests;
    return {
      runId: row.id,
      testId: row.test_id,
      testName: test?.name ?? '(deleted dataset)',
      startedAt: row.started_at,
      failCount: typeof row.failed_items === 'number' ? row.failed_items : null,
    };
  });
}
