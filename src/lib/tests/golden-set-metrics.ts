/**
 * Calculate aggregate metrics for golden test sets (used on /admin/tests).
 * Metrics include: total failing prompts from the latest run's report, average score, score
 * change vs the previous run, and performance stats — all scoped to the LATEST completed run
 * of each golden test, never summed across a test's full run history.
 */

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import { listTests } from '~/lib/tests/repository';
import { listGoldenCandidateRuns, type GoldenRunRow } from '~/lib/tests/golden-set';

export type GoldenSetMetrics = {
  totalFailingPrompts: number;
  averageScore: number | null;
  /** Point delta (like the Recent runs table's Score column), not a percentage. */
  scoreChangePoints: number | null;
  averagePassPercent: number | null;
  averageTtft: number | null;
  averageElapsed: number | null;
  goldenSetCount: number;
};

const EMPTY_METRICS: Omit<GoldenSetMetrics, 'goldenSetCount'> = {
  totalFailingPrompts: 0,
  averageScore: null,
  scoreChangePoints: null,
  averagePassPercent: null,
  averageTtft: null,
  averageElapsed: null,
};

/** The latest completed run per test_id, from a desc-sorted run list. */
function resolveLatestRuns(runs: GoldenRunRow[]): Map<string, GoldenRunRow> {
  const latestByTestId = new Map<string, GoldenRunRow>();
  for (const run of runs) {
    const existing = latestByTestId.get(run.test_id);
    // `listGoldenCandidateRuns` orders by created_at desc, but compare defensively.
    if (!existing || run.created_at > existing.created_at) {
      latestByTestId.set(run.test_id, run);
    }
  }
  return latestByTestId;
}

export async function calculateGoldenSetMetrics(): Promise<GoldenSetMetrics> {
  const allTests = await listTests();
  const goldenTests = allTests.filter((t) => t.is_golden);

  if (goldenTests.length === 0) {
    return { ...EMPTY_METRICS, goldenSetCount: 0 };
  }

  const goldenTestIds = goldenTests.map((t) => t.id);

  // Every completed, metric-eligible run of every golden test — used only to resolve, per test,
  // its latest run (pass %, elapsed, TTFT). Never aggregated over directly.
  const runs = await listGoldenCandidateRuns(goldenTestIds);

  if (runs.length === 0) {
    return { ...EMPTY_METRICS, goldenSetCount: goldenTests.length };
  }

  const latestRunIds = Array.from(resolveLatestRuns(runs).values()).map((r) => r.id);

  const supabase = getSupabaseServiceRoleClient();

  // Failing prompts: sum of `latest_run_failed_items` (B0-896) — the same field the "Test sets"
  // table's Fails column renders, resolved by `listTests` from each test's latest reported run.
  // B0-1105 invariant: `listTests` and `listGoldenCandidateRuns` are both scoped by
  // `onlyMetricEligibleRuns` (`~/lib/tests/run-mode.ts`), so a `partial` run can never be the
  // "latest" run here or anywhere else; the total is read from `listTests` rather than the run
  // list above only so it stays the same number the visible Fails column shows.
  const totalFailingPrompts = goldenTests.reduce(
    (sum, t) => sum + (t.latest_run_failed_items ?? 0),
    0,
  );

  // Fetch result items scoped to the latest runs only, for pass % / elapsed / TTFT.
  const resultItems: Array<{ passed: boolean }> = await supabase
    .from('test_result_items')
    .select('passed')
    .in('test_result_id', latestRunIds)
    .then((result) => (result.error ? [] : result.data ?? []));

  const resultItemsWithMetrics: Array<{ elapsed_ms: number | null; ttft_ms: number | null }> =
    await supabase
      .from('test_result_items')
      .select('elapsed_ms, ttft_ms')
      .in('test_result_id', latestRunIds)
      .then((result) => (result.error ? [] : result.data ?? []));

  // Average score: the "Avg Score" column (avg_report_score, itself an avg across each test's
  // scored runs) averaged across golden tests — matches the Uploaded tests table by design.
  const scoredTests = goldenTests.filter((t) => t.avg_report_score !== null);
  const averageScore =
    scoredTests.length > 0
      ? scoredTests.reduce((sum, t) => sum + (t.avg_report_score ?? 0), 0) / scoredTests.length
      : null;

  // Pass percentage, from the latest run's result items only.
  const totalItems = resultItems.length;
  const passedItems = resultItems.filter((item) => item.passed).length;
  const averagePassPercent = totalItems > 0 ? (passedItems / totalItems) * 100 : null;

  // Elapsed / TTFT averages, from the latest run's result items only.
  const itemsWithElapsed = resultItemsWithMetrics.filter((r) => r.elapsed_ms !== null);
  const averageElapsed =
    itemsWithElapsed.length > 0
      ? itemsWithElapsed.reduce((sum, r) => sum + (Number(r.elapsed_ms) || 0), 0) /
        itemsWithElapsed.length
      : null;

  const itemsWithTtft = resultItemsWithMetrics.filter((r) => r.ttft_ms !== null);
  const averageTtft =
    itemsWithTtft.length > 0
      ? itemsWithTtft.reduce((sum, r) => sum + (Number(r.ttft_ms) || 0), 0) / itemsWithTtft.length
      : null;

  // Score change: the SUM of every golden set's "Last run" change — the same
  // `latest_run_score_delta` the Test sets table renders per row (latest scored run vs. the scored
  // run before it, unscored runs skipped; see `listTests`). Summing keeps the card reconcilable
  // with the table by eye: add the column, get the card. A set with no comparable previous run
  // contributes nothing rather than 0. Previously this averaged only sets whose two most recent
  // COMPLETED runs were both scored, which — after a burst of runs whose reports failed to grade —
  // reduced the card to whichever single set happened to qualify.
  const deltas = goldenTests
    .map((t) => t.latest_run_score_delta)
    .filter((d): d is number => typeof d === 'number' && Number.isFinite(d));
  const scoreChangePoints =
    deltas.length > 0 ? Math.round(deltas.reduce((sum, d) => sum + d, 0) * 10) / 10 : null;

  return {
    totalFailingPrompts,
    averageScore,
    scoreChangePoints,
    averagePassPercent,
    averageTtft,
    averageElapsed,
    goldenSetCount: goldenTests.length,
  };
}
