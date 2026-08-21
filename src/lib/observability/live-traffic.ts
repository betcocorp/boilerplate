/**
 * B0-581 — view-model for the Bex Health "Live traffic" card: the six tiles and
 * the confidence spread bar, derived from `AggregateDashboardData` (ONE window
 * scan in `~/lib/observability/aggregates.ts` — nothing here fetches).
 *
 * Pure functions, unit-tested in `live-traffic.test.ts`. The component
 * (`~/components/admin/bex-health/LiveTrafficCard.tsx`) only renders these.
 */

import {
  CONFIDENCE_HIGH_MIN,
  CONFIDENCE_MID_MIN,
} from '~/lib/observability/aggregates';
import type {
  AggregateDashboardData,
  ConfidenceBucketDatum,
} from '~/types/observability';

/** "Not measured" — tiles must show this, never a fabricated 0. */
export const NOT_MEASURED = '—';

export type LiveTrafficTile = {
  key: 'runs' | 'failed' | 'confidence' | 'latency' | 'tokens' | 'orphaned';
  label: string;
  value: string;
  hint: string | null;
  /** `warning` marks a number that should normally be zero (orphaned runs). */
  tone: 'default' | 'warning';
};

function formatMs(value: number): string {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${Math.round(value)}ms`;
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US');
}

function plural(count: number): string {
  return count === 1 ? '' : 's';
}

/** The six tiles, in render order: Runs · Failed · Avg confidence · TTFT/elapsed · Tokens · Orphaned. */
export function buildLiveTrafficTiles(data: AggregateDashboardData): LiveTrafficTile[] {
  const failureRate =
    data.totalRuns > 0 ? ((data.failedRuns / data.totalRuns) * 100).toFixed(1) : null;

  const { tokenUsage } = data;

  return [
    {
      key: 'runs',
      label: 'Runs',
      value: formatCount(data.totalRuns),
      hint: `${formatCount(data.completedRuns)} completed`,
      tone: 'default',
    },
    {
      key: 'failed',
      label: 'Failed',
      // Count + rate in one reading; with zero runs there is no rate to state.
      value:
        failureRate === null
          ? formatCount(data.failedRuns)
          : `${formatCount(data.failedRuns)} · ${failureRate}%`,
      hint: failureRate === null ? 'No runs in this window' : 'Count · failure rate',
      tone: 'default',
    },
    {
      key: 'confidence',
      label: 'Avg confidence',
      value:
        data.avgConfidence === null
          ? NOT_MEASURED
          : `${(data.avgConfidence * 100).toFixed(1)}%`,
      hint:
        data.avgConfidence === null
          ? 'No run recorded a confidence'
          : 'Mean over runs that recorded a confidence',
      tone: 'default',
    },
    {
      key: 'latency',
      label: 'TTFT / elapsed',
      value: `${data.avgTtftMs === null ? NOT_MEASURED : formatMs(data.avgTtftMs)} / ${
        data.avgDurationMs === null ? NOT_MEASURED : formatMs(data.avgDurationMs)
      }`,
      hint: `TTFT over ${formatCount(data.ttftSampleSize)} run${plural(data.ttftSampleSize)} · elapsed over ${formatCount(data.durationSampleSize)} finished run${plural(data.durationSampleSize)}`,
      tone: 'default',
    },
    {
      key: 'tokens',
      label: 'Tokens per run',
      value:
        tokenUsage.avgTotalTokens === null
          ? NOT_MEASURED
          : formatCount(tokenUsage.avgTotalTokens),
      // Pre-B0-324 runs are out of the cache-share denominator; the sample size says so.
      hint:
        tokenUsage.cachedPromptShare === null
          ? `Cached share ${NOT_MEASURED} — no cache-instrumented runs in this window`
          : `${(tokenUsage.cachedPromptShare * 100).toFixed(1)}% cached, over ${formatCount(tokenUsage.cachedShareSampleSize)} cache-instrumented run${plural(tokenUsage.cachedShareSampleSize)} (of ${formatCount(tokenUsage.tokenSampleSize)} with usage)`,
      tone: 'default',
    },
    {
      key: 'orphaned',
      label: 'Orphaned',
      value: formatCount(data.orphanedRuns),
      hint:
        data.orphanedRuns > 0
          ? 'Stuck in "running" past the staleness threshold — awaiting the sweeper'
          : 'No runs stuck in "running"',
      tone: data.orphanedRuns > 0 ? 'warning' : 'default',
    },
  ];
}

export type ConfidenceSpreadSegment = {
  bucket: ConfidenceBucketDatum['bucket'];
  /** Human label, derived from the exported thresholds — never restated literals. */
  label: string;
  count: number;
  /** Share of all runs in the window, 0–100 (one decimal). 0 when the window is empty. */
  percent: number;
};

/**
 * Bucket labels derived from `CONFIDENCE_HIGH_MIN` / `CONFIDENCE_MID_MIN` so this bar can
 * never drift from the boundaries the aggregate dashboard (and `conversation-queries.ts`)
 * bucket with.
 */
export const CONFIDENCE_SPREAD_LABELS: Record<ConfidenceBucketDatum['bucket'], string> = {
  high: `High (≥ ${CONFIDENCE_HIGH_MIN * 100}%)`,
  mid: `Mid (${CONFIDENCE_MID_MIN * 100}–<${CONFIDENCE_HIGH_MIN * 100}%)`,
  low: `Low (< ${CONFIDENCE_MID_MIN * 100}%)`,
  none: 'None',
};

export function buildConfidenceSpread(
  buckets: ConfidenceBucketDatum[],
): ConfidenceSpreadSegment[] {
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);

  return buckets.map((bucket) => ({
    bucket: bucket.bucket,
    label: CONFIDENCE_SPREAD_LABELS[bucket.bucket],
    count: bucket.count,
    percent: total > 0 ? Math.round((bucket.count / total) * 1000) / 10 : 0,
  }));
}
