import type { SmeAgentId } from '~/lib/agents/agent-registry';

import type {
  RoutingTestItemResult,
  RoutingTestPredictedLabel,
  RoutingTestRunSummary,
} from './types';

/**
 * B0-659 — `SmeRouteDecision.agent` is `SmeAgentId | null`; the semantic router already reports
 * `'ambiguous'` directly. Collapsing `null` to `'ambiguous'` (the same convention as
 * `normalizeKeywordRoute` in `~/lib/tests/routing-comparison`) keeps both routers in one label
 * space, so "routed nowhere" fails the item instead of disappearing from the score.
 */
export function normalizeRoutedAgent(
  agent: SmeAgentId | 'ambiguous' | null | undefined,
): RoutingTestPredictedLabel {
  return agent ?? 'ambiguous';
}

/** Pass/fail for one item. `'ambiguous'` can never equal an expected agent, so it always fails. */
export function isRoutingTestItemPass(
  predicted: RoutingTestPredictedLabel,
  expectedAgent: SmeAgentId,
): boolean {
  return predicted === expectedAgent;
}

/**
 * `durationMs` is the whole run's wall-clock time — it cannot be derived from the items array
 * (mapWithConcurrency overlaps item work), so the caller measures it and passes it in.
 * `avgItemDurationMs` IS derivable from `items[].elapsedMs` and is computed here (B0-667).
 */
export function computeRoutingTestSummary(
  items: readonly Pick<RoutingTestItemResult, 'passed' | 'error' | 'elapsedMs'>[],
  durationMs: number,
): RoutingTestRunSummary {
  const total = items.length;
  const correct = items.filter((item) => item.passed).length;
  const degraded = items.filter((item) => item.error !== null).length;
  const avgItemDurationMs =
    total === 0
      ? 0
      : Math.round(
          items.reduce((sum, item) => sum + item.elapsedMs, 0) / total,
        );

  return {
    total,
    correct,
    accuracy: total === 0 ? 0 : Math.round((correct / total) * 10000) / 10000,
    degraded,
    durationMs,
    avgItemDurationMs,
  };
}

/** "7/10 correct — 70%" (whole-percent display; `0/0 correct — 0%` when the list is empty). */
export function formatRoutingTestAccuracy(
  summary: RoutingTestRunSummary,
): string {
  const percent = Math.round(summary.accuracy * 100);
  return `${summary.correct}/${summary.total} correct — ${percent}%`;
}

/**
 * "2/4 50%" — the run-HISTORY display format (B0-667), distinct from `formatRoutingTestAccuracy`'s
 * "N/M correct — P%". Takes plain counts (not a `RoutingTestRunSummary`) so it works directly off a
 * persisted `RoutingTestRunRecord`'s `passed_items`/`total_items` columns.
 */
export function formatRoutingTestRunScore(
  passed: number,
  total: number,
): string {
  const percent = total === 0 ? 0 : Math.round((passed / total) * 100);
  return `${passed}/${total} ${percent}%`;
}

/**
 * Runs `worker` over `inputs` with at most `limit` in flight, preserving input order in the output.
 * The keyword router is synchronous, but the semantic router costs one embedding call per item —
 * a 50-item list must not fan out 50 concurrent requests.
 */
export async function mapWithConcurrency<TIn, TOut>(
  inputs: readonly TIn[],
  limit: number,
  worker: (input: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  const safeLimit = Math.max(1, Math.floor(limit));
  const results = new Array<TOut>(inputs.length);
  let cursor = 0;

  async function drain(): Promise<void> {
    while (cursor < inputs.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(inputs[index]!, index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(safeLimit, inputs.length) }, () => drain()),
  );

  return results;
}
