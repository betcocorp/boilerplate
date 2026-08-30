/**
 * Calculate aggregate metrics for golden test sets (used on /admin/tests).
 * Metrics include: total failing prompts from report grading, average score, and performance stats.
 */

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import { listTests } from '~/lib/tests/repository';
import { listGoldenCandidateRuns, listResultItemsForRuns } from '~/lib/tests/golden-set';
import { parseReportState } from '~/lib/tests/report/schemas';

export type GoldenSetMetrics = {
  totalFailingPrompts: number;
  averageScore: number | null;
  scoreChangePercent: number | null;
  averagePassPercent: number | null;
  averageTtft: number | null;
  averageElapsed: number | null;
  goldenSetCount: number;
};

export async function calculateGoldenSetMetrics(): Promise<GoldenSetMetrics> {
  const allTests = await listTests();
  const goldenTests = allTests.filter((t) => t.is_golden);

  if (goldenTests.length === 0) {
    return {
      totalFailingPrompts: 0,
      averageScore: null,
      scoreChangePercent: null,
      averagePassPercent: null,
      averageTtft: null,
      averageElapsed: null,
      goldenSetCount: 0,
    };
  }

  const goldenTestIds = goldenTests.map((t) => t.id);

  // Fetch golden runs
  const runs = await listGoldenCandidateRuns(goldenTestIds);

  if (runs.length === 0) {
    return {
      totalFailingPrompts: 0,
      averageScore: null,
      scoreChangePercent: null,
      averagePassPercent: null,
      averageTtft: null,
      averageElapsed: null,
      goldenSetCount: goldenTests.length,
    };
  }

  const supabase = getSupabaseServiceRoleClient();
  const runIds = runs.map((r) => r.id);

  // Fetch test results with report state to get completion status and case counts
  const testResults = await supabase
    .from('test_results')
    .select('id, report_state')
    .in('id', runIds)
    .then((result) => (result.error ? [] : result.data ?? []));

  // Calculate total failing prompts from report state (totalCases - (cases marked as Pass))
  // This counts partial passes and failures together
  let totalFailingPrompts = 0;
  for (const run of testResults) {
    const reportState = parseReportState(run.report_state);
    if (reportState && reportState.status === 'completed' && reportState.totalCases > 0) {
      // Count failing as total minus the completed passes
      // In a completed report, we count how many cases passed
      const casesList = Object.values(reportState.caseScores || {});
      const failedCount = casesList.filter((score) => score.unableToEvaluate).length;
      totalFailingPrompts += Math.max(failedCount, reportState.totalCases - casesList.length);
    }
  }

  // Fetch result items for metrics
  const resultItems = await listResultItemsForRuns(runIds);

  // Fetch test result items with performance metrics
  const resultItemsWithMetrics: Array<{ elapsed_ms: number | null; ttft_ms: number | null }> =
    await supabase
      .from('test_result_items')
      .select('elapsed_ms, ttft_ms')
      .in('test_result_id', runIds)
      .then((result) => (result.error ? [] : result.data ?? []));

  // Calculate average score from golden tests
  const scoredTests = goldenTests.filter((t) => t.avg_report_score !== null);
  const averageScore =
    scoredTests.length > 0
      ? scoredTests.reduce((sum, t) => sum + (t.avg_report_score ?? 0), 0) /
        scoredTests.length
      : null;

  // Calculate average pass percentage from result items
  const totalItems = resultItems.length;
  const passedItems = resultItems.filter((item) => item.passed).length;
  const averagePassPercent = totalItems > 0 ? (passedItems / totalItems) * 100 : null;

  // Calculate elapsed and TTFT averages from result items
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

  // Calculate score change percentage (current vs previous run average)
  // For now, return null as we'd need more complex run comparison logic
  const scoreChangePercent = null;

  return {
    totalFailingPrompts,
    averageScore,
    scoreChangePercent,
    averagePassPercent,
    averageTtft,
    averageElapsed,
    goldenSetCount: goldenTests.length,
  };
}
