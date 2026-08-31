/**
 * Calculate aggregate metrics for golden test sets (used on /admin/tests).
 * Metrics include: total failing prompts from the latest run's report, average score, score
 * change vs the previous run, and performance stats — all scoped to the LATEST completed run
 * of each golden test, never summed across a test's full run history.
 */

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import { listTests } from '~/lib/tests/repository';
import { listGoldenCandidateRuns, type GoldenRunRow } from '~/lib/tests/golden-set';
import { parseReportState } from '~/lib/tests/report/schemas';

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

/** The latest and (if any) second-latest completed run per test_id, from a desc-sorted run list. */
function resolveLatestAndPreviousRuns(
  runs: GoldenRunRow[],
): Map<string, { latest: GoldenRunRow; previous: GoldenRunRow | null }> {
  const byTestId = new Map<string, GoldenRunRow[]>();
  for (const run of runs) {
    const existing = byTestId.get(run.test_id);
    if (existing) {
      existing.push(run);
    } else {
      byTestId.set(run.test_id, [run]);
    }
  }

  const result = new Map<string, { latest: GoldenRunRow; previous: GoldenRunRow | null }>();
  for (const [testId, testRuns] of byTestId) {
    // `listGoldenCandidateRuns` orders by created_at desc, but sort defensively.
    const sorted = [...testRuns].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
    result.set(testId, { latest: sorted[0], previous: sorted[1] ?? null });
  }
  return result;
}

/** `report_state.overall.avg` for a completed run's report, else null. */
function extractRunScore(reportStateValue: unknown): number | null {
  const reportState = parseReportState(reportStateValue);
  if (!reportState || reportState.status !== 'completed' || !reportState.overall) {
    return null;
  }
  return reportState.overall.avg;
}

export async function calculateGoldenSetMetrics(): Promise<GoldenSetMetrics> {
  const allTests = await listTests();
  const goldenTests = allTests.filter((t) => t.is_golden);

  if (goldenTests.length === 0) {
    return { ...EMPTY_METRICS, goldenSetCount: 0 };
  }

  const goldenTestIds = goldenTests.map((t) => t.id);

  // Every completed, full-mode run of every golden test — used only to resolve, per test, its
  // latest run and the run immediately before it. Never aggregated over directly.
  const runs = await listGoldenCandidateRuns(goldenTestIds);

  if (runs.length === 0) {
    return { ...EMPTY_METRICS, goldenSetCount: goldenTests.length };
  }

  const latestAndPreviousByTestId = resolveLatestAndPreviousRuns(runs);
  const latestRuns = Array.from(latestAndPreviousByTestId.values()).map((r) => r.latest);
  const previousRuns = Array.from(latestAndPreviousByTestId.values())
    .map((r) => r.previous)
    .filter((r): r is GoldenRunRow => r !== null);

  const latestRunIds = latestRuns.map((r) => r.id);
  const previousRunIds = previousRuns.map((r) => r.id);

  const supabase = getSupabaseServiceRoleClient();

  // Fetch report_state (for scores) and failed_items (for the failing-prompt count) for the
  // latest run of every golden test, plus report_state for the previous run of every golden
  // test that has one (for the score-change comparison).
  const allRelevantRunIds = Array.from(new Set([...latestRunIds, ...previousRunIds]));
  const testResults: Array<{ id: string; report_state: unknown; failed_items: number | null }> =
    await supabase
      .from('test_results')
      .select('id, report_state, failed_items')
      .in('id', allRelevantRunIds)
      .then((result) => (result.error ? [] : result.data ?? []));
  const testResultById = new Map(testResults.map((r) => [r.id, r]));

  // Failing prompts: sum of failed_items from ONLY the latest run of each golden test.
  let totalFailingPrompts = 0;
  for (const runId of latestRunIds) {
    totalFailingPrompts += testResultById.get(runId)?.failed_items ?? 0;
  }

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

  // Score change: avg(latest-run score) vs avg(previous-run score), one score per golden test,
  // only over tests that have a scored report on BOTH sides of the comparison — a test with no
  // previous run (or an unscored one) is excluded from both averages, not treated as a 0.
  const latestScoresByTestId = new Map<string, number>();
  for (const [testId, { latest }] of latestAndPreviousByTestId) {
    const score = extractRunScore(testResultById.get(latest.id)?.report_state);
    if (score !== null) latestScoresByTestId.set(testId, score);
  }
  const previousScoresByTestId = new Map<string, number>();
  for (const [testId, { previous }] of latestAndPreviousByTestId) {
    if (!previous) continue;
    const score = extractRunScore(testResultById.get(previous.id)?.report_state);
    if (score !== null) previousScoresByTestId.set(testId, score);
  }

  const comparableTestIds = Array.from(latestScoresByTestId.keys()).filter((testId) =>
    previousScoresByTestId.has(testId),
  );

  let scoreChangePoints: number | null = null;
  if (comparableTestIds.length > 0) {
    const currentAvg =
      comparableTestIds.reduce((sum, id) => sum + (latestScoresByTestId.get(id) ?? 0), 0) /
      comparableTestIds.length;
    const previousAvg =
      comparableTestIds.reduce((sum, id) => sum + (previousScoresByTestId.get(id) ?? 0), 0) /
      comparableTestIds.length;
    scoreChangePoints = currentAvg - previousAvg;
  }

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
