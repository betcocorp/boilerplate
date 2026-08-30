/**
 * Calculate aggregate metrics for golden test sets (used on /admin/tests).
 * Metrics include: total failing prompts, average score, score change, and performance stats.
 */

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import { listTests } from '~/lib/tests/repository';
import { listGoldenCandidateRuns, listResultItemsForRuns } from '~/lib/tests/golden-set';

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

  // Fetch golden runs and result items
  const runs = await listGoldenCandidateRuns(goldenTestIds);
  const resultItems =
    runs.length > 0 ? await listResultItemsForRuns(runs.map((r) => r.id)) : [];

  // Fetch test result items with elapsed metrics to calculate average elapsed time
  const supabase = getSupabaseServiceRoleClient();
  const resultItemsWithMetrics: Array<{ elapsed_ms: number | null }> =
    runs.length > 0
      ? await supabase
          .from('test_result_items')
          .select('elapsed_ms')
          .in(
            'test_result_id',
            runs.map((r) => r.id),
          )
          .then((result) => (result.error ? [] : result.data ?? []))
      : [];

  // Calculate total failing prompts from latest runs
  const totalFailingPrompts = resultItems.filter((item) => !item.passed).length;

  // Calculate average score from golden tests
  const scoredTests = goldenTests.filter((t) => t.avg_report_score !== null);
  const averageScore =
    scoredTests.length > 0
      ? scoredTests.reduce((sum, t) => sum + (t.avg_report_score ?? 0), 0) /
        scoredTests.length
      : null;

  // Calculate average pass percentage
  const totalItems = resultItems.length;
  const passedItems = resultItems.filter((item) => item.passed).length;
  const averagePassPercent = totalItems > 0 ? (passedItems / totalItems) * 100 : null;

  // Calculate elapsed average from result items
  const itemsWithElapsed = resultItemsWithMetrics.filter((r) => r.elapsed_ms !== null);
  const averageElapsed =
    itemsWithElapsed.length > 0
      ? itemsWithElapsed.reduce((sum, r) => sum + (r.elapsed_ms ?? 0), 0) /
        itemsWithElapsed.length
      : null;

  // Calculate score change percentage (current vs previous run average)
  // For now, return null as we'd need more complex run comparison logic
  const scoreChangePercent = null;

  return {
    totalFailingPrompts,
    averageScore,
    scoreChangePercent,
    averagePassPercent,
    averageTtft: null, // TTFT not available in current schema
    averageElapsed,
    goldenSetCount: goldenTests.length,
  };
}
