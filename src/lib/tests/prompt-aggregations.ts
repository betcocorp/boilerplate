import type { TestResultItemRecord, TestResultRecord } from './types';

/**
 * Pulls per-source `similarity` values off the response payload's `sources`
 * array and returns the maximum (matches the metric used on the run detail
 * page and the dataset trend chart).
 */
export function extractItemMaxSimilarity(responsePayload: unknown): number | null {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const sources = (responsePayload as Record<string, unknown>).sources;
  if (!Array.isArray(sources)) {
    return null;
  }

  const similarities = sources
    .map((source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return null;
      }
      const value = (source as Record<string, unknown>).similarity;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    })
    .filter((value): value is number => typeof value === 'number');

  if (similarities.length === 0) {
    return null;
  }
  return Math.max(...similarities);
}

export type PromptAggregatedStats = {
  /** Number of completed/failed runs that included this prompt. */
  runCount: number;
  passCount: number;
  failCount: number;
  /** `passCount / runCount * 100`, or `null` when `runCount === 0`. */
  passRatePercent: number | null;
  /** Average of the *max* per-source similarity per run, or `null` when no run recorded a score. */
  avgSimilarity: number | null;
  /** Lowest max-per-source similarity recorded across runs. */
  minSimilarity: number | null;
  /** Highest max-per-source similarity recorded across runs. */
  maxSimilarity: number | null;
  /** Mean wall-clock prompt elapsed time, or `null` when there are no completed runs. */
  avgElapsedMs: number | null;
  /** Most recent run that included this prompt (by run `started_at`). */
  latestRun: {
    runId: string;
    resultItemId: string;
    passed: boolean;
    similarity: number | null;
    elapsedMs: number;
    startedAt: string;
  } | null;
};

/**
 * Buckets `test_result_items` by `test_item_id` and rolls them up into
 * per-prompt stats. Runs with `status` outside `completed | failed` are
 * skipped because they don't represent a real attempt at the prompt
 * (queued/cancelled rows would otherwise inflate denominators).
 */
export function buildPromptAggregations(
  resultItems: TestResultItemRecord[],
  runsById: Map<string, TestResultRecord>,
): Map<string, PromptAggregatedStats> {
  const accumByItemId = new Map<
    string,
    {
      runCount: number;
      passCount: number;
      failCount: number;
      similaritySum: number;
      similarityCount: number;
      similarityMin: number;
      similarityMax: number;
      elapsedSum: number;
      elapsedCount: number;
      latest: PromptAggregatedStats['latestRun'];
      latestRunStartedAtMs: number;
    }
  >();

  for (const item of resultItems) {
    if (item.status !== 'completed' && item.status !== 'failed') {
      continue;
    }
    const run = runsById.get(item.test_result_id);
    if (!run) {
      continue;
    }

    let bucket = accumByItemId.get(item.test_item_id);
    if (!bucket) {
      bucket = {
        runCount: 0,
        passCount: 0,
        failCount: 0,
        similaritySum: 0,
        similarityCount: 0,
        similarityMin: Number.POSITIVE_INFINITY,
        similarityMax: Number.NEGATIVE_INFINITY,
        elapsedSum: 0,
        elapsedCount: 0,
        latest: null,
        latestRunStartedAtMs: -1,
      };
      accumByItemId.set(item.test_item_id, bucket);
    }

    bucket.runCount += 1;
    if (item.passed) {
      bucket.passCount += 1;
    } else {
      bucket.failCount += 1;
    }

    if (typeof item.elapsed_ms === 'number' && Number.isFinite(item.elapsed_ms)) {
      bucket.elapsedSum += item.elapsed_ms;
      bucket.elapsedCount += 1;
    }

    const similarity = extractItemMaxSimilarity(item.response_payload);
    if (typeof similarity === 'number') {
      bucket.similaritySum += similarity;
      bucket.similarityCount += 1;
      if (similarity < bucket.similarityMin) {
        bucket.similarityMin = similarity;
      }
      if (similarity > bucket.similarityMax) {
        bucket.similarityMax = similarity;
      }
    }

    const startedAtMs = run.started_at
      ? new Date(run.started_at).getTime()
      : 0;
    if (startedAtMs >= bucket.latestRunStartedAtMs) {
      bucket.latestRunStartedAtMs = startedAtMs;
      bucket.latest = {
        runId: run.id,
        resultItemId: item.id,
        passed: item.passed,
        similarity,
        elapsedMs:
          typeof item.elapsed_ms === 'number' && Number.isFinite(item.elapsed_ms)
            ? item.elapsed_ms
            : 0,
        startedAt: run.started_at ?? '',
      };
    }
  }

  const out = new Map<string, PromptAggregatedStats>();
  for (const [itemId, bucket] of accumByItemId) {
    out.set(itemId, {
      runCount: bucket.runCount,
      passCount: bucket.passCount,
      failCount: bucket.failCount,
      passRatePercent:
        bucket.runCount > 0 ? (bucket.passCount / bucket.runCount) * 100 : null,
      avgSimilarity:
        bucket.similarityCount > 0
          ? bucket.similaritySum / bucket.similarityCount
          : null,
      minSimilarity:
        bucket.similarityCount > 0 ? bucket.similarityMin : null,
      maxSimilarity:
        bucket.similarityCount > 0 ? bucket.similarityMax : null,
      avgElapsedMs:
        bucket.elapsedCount > 0 ? bucket.elapsedSum / bucket.elapsedCount : null,
      latestRun: bucket.latest,
    });
  }
  return out;
}
