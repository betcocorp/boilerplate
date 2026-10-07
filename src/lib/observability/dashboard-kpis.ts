/**
 * B0-629 — run-level KPIs for the `/admin` Mission Control dashboard's card row.
 *
 * Read-only and composed FROM `~/lib/observability/aggregates.ts`: the window scan
 * (`scanWorkflowRuns`), the terminal-status list, the elapsed definition and the nearest-rank
 * percentile are all that module's, so these cards reconcile with `/admin/observability` for the
 * same window by construction rather than by coincidence.
 *
 * Three distinctions this module exists to get right — each one is a way the number could lie:
 *
 *  1. `runningRuns` is EVERY run whose status is `running`, at any age. It is deliberately NOT
 *     `AggregateDashboardData.orphanedRuns`, which counts only runs stuck past the sweeper's
 *     staleness threshold. In-flight and abandoned are different facts; this is the former.
 *  2. Elapsed (avg/p50/p95) is over TERMINAL runs only. For a run still `running`,
 *     `updated_at` is the last progress write, not an end time, so including it would report a
 *     truncated duration as a fast run. In-flight runs are excluded, never counted as fast.
 *  3. `failureRate`'s denominator is terminal runs, not `totalRuns`. A window full of in-flight
 *     runs must not read as a low failure rate, and with no terminal runs at all the answer is
 *     `null` — "no data", which is not the same claim as "0%".
 */

import {
  type AggregateWindow,
  percentileNearestRank,
  type RunScanRow,
  roundTo,
  scanWorkflowRuns,
  terminalElapsedMs,
  utcDayKey,
  type VersionFilter,
} from '~/lib/observability/aggregates';
import { logWarn } from '~/lib/observability/logger';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * A window covering at most this many UTC days is bucketed hourly; anything wider is bucketed
 * daily. At the boundary (2 days) hourly gives at most 48 points — still a readable sparkline.
 */
const MAX_UTC_DAYS_FOR_HOURLY = 2;

/** Guard against a malformed window seeding an unbounded number of empty buckets. */
const MAX_BUCKETS = 400;

/**
 * Mirrors the documented page budget of `scanWorkflowRuns` (`SCAN_PAGE_SIZE * MAX_SCAN_PAGES`).
 * The scan stops there and returns what it has, so a window above this silently truncates —
 * `getRunKpiSummary` logs a warning rather than reporting a partial count as a total.
 */
const RUN_SCAN_ROW_BUDGET = 1000 * 20;

export type RunBucketGranularity = 'hour' | 'day';

export type RunCountBucket = {
  /** `'hour'` → ISO hour start (`2026-08-22T14:00:00.000Z`); `'day'` → `YYYY-MM-DD` (UTC). */
  bucket: string;
  total: number;
  completed: number;
  failed: number;
  running: number;
};

export type RunKpiSummary = {
  windowFrom: string;
  windowTo: string;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  /** `status === 'running'`, at ANY age — in-flight, not the stuck-run count. */
  runningRuns: number;
  /** `failedRuns / (completedRuns + failedRuns)`; null when the window has no terminal runs. */
  failureRate: number | null;
  avgElapsedMs: number | null;
  p50ElapsedMs: number | null;
  p95ElapsedMs: number | null;
  /** Terminal runs the three elapsed figures were taken over, so a thin sample is never hidden. */
  elapsedSampleSize: number;
  /** Zero-filled across the whole window: an empty bucket is a visible 0, never an absent point. */
  buckets: RunCountBucket[];
  granularity: RunBucketGranularity;
};

/** Start-of-UTC-day epoch ms for an ISO timestamp, or null when it does not parse. */
function utcDayStartMs(iso: string): number | null {
  const key = utcDayKey(iso);
  if (key === null) {
    return null;
  }
  const parsed = Date.parse(`${key}T00:00:00.000Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * ≤ 2 UTC days spanned → hourly, otherwise daily. Counted in whole UTC days (inclusive of both
 * ends) so the choice matches how the buckets are keyed; an unparseable window falls back to
 * `'day'`, the coarser and cheaper option.
 */
function resolveGranularity(window: AggregateWindow): RunBucketGranularity {
  const startDay = utcDayStartMs(window.from);
  const endDay = utcDayStartMs(window.to);
  if (startDay === null || endDay === null || endDay < startDay) {
    return 'day';
  }
  const spannedDays = Math.floor((endDay - startDay) / DAY_MS) + 1;
  return spannedDays <= MAX_UTC_DAYS_FOR_HOURLY ? 'hour' : 'day';
}

/** The bucket key a run's `created_at` falls in, or null when the timestamp does not parse. */
function bucketKeyFor(iso: string, granularity: RunBucketGranularity): string | null {
  if (granularity === 'day') {
    return utcDayKey(iso);
  }
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(Math.floor(parsed / HOUR_MS) * HOUR_MS).toISOString();
}

/** Every bucket key in the window, in order — the zero-fill that keeps the sparkline gap-free. */
function seedBucketKeys(
  window: AggregateWindow,
  granularity: RunBucketGranularity,
): string[] {
  const stepMs = granularity === 'hour' ? HOUR_MS : DAY_MS;
  const fromMs = Date.parse(window.from);
  const toMs = Date.parse(window.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs < fromMs) {
    return [];
  }

  const first = Math.floor(fromMs / stepMs) * stepMs;
  const last = Math.floor(toMs / stepMs) * stepMs;
  const keys: string[] = [];
  for (let at = first, i = 0; at <= last && i < MAX_BUCKETS; at += stepMs, i += 1) {
    const key = bucketKeyFor(new Date(at).toISOString(), granularity);
    if (key !== null) {
      keys.push(key);
    }
  }
  return keys;
}

function emptyBucket(bucket: string): RunCountBucket {
  return { bucket, total: 0, completed: 0, failed: 0, running: 0 };
}

/**
 * Folds the scanned rows into the card row's figures. Pure — exported so the semantics above are
 * unit-testable without a database.
 *
 * Only `status`, `created_at` and `updated_at` are read here, and all three are real Postgres
 * columns rather than `->>` text extracted from `final_output`, so no string coercion is needed
 * (the token/TTFT fields that DO need it have their own parse helpers in `aggregates.ts`).
 */
export function buildRunKpiSummary(runs: RunScanRow[], window: AggregateWindow): RunKpiSummary {
  const granularity = resolveGranularity(window);

  const buckets = new Map<string, RunCountBucket>();
  for (const key of seedBucketKeys(window, granularity)) {
    buckets.set(key, emptyBucket(key));
  }

  let completedRuns = 0;
  let failedRuns = 0;
  let runningRuns = 0;
  const elapsed: number[] = [];

  for (const run of runs) {
    if (run.status === 'completed') {
      completedRuns += 1;
    } else if (run.status === 'failed') {
      failedRuns += 1;
    } else if (run.status === 'running') {
      // Every in-flight run, fresh or long-stuck. Age is `orphanedRuns`' business, not this card's.
      runningRuns += 1;
    }

    // Terminal-only, via the one shared elapsed definition (`updated_at - created_at`).
    const runElapsed = terminalElapsedMs(run);
    if (runElapsed !== null) {
      elapsed.push(runElapsed);
    }

    const key = bucketKeyFor(run.created_at, granularity);
    if (key === null) {
      continue;
    }
    // A row outside the seeded range (padded/edge scan) still gets its own bucket rather than
    // being dropped — the counts must add up to `totalRuns`.
    const bucket = buckets.get(key) ?? emptyBucket(key);
    bucket.total += 1;
    if (run.status === 'completed') {
      bucket.completed += 1;
    } else if (run.status === 'failed') {
      bucket.failed += 1;
    } else if (run.status === 'running') {
      bucket.running += 1;
    }
    buckets.set(key, bucket);
  }

  const terminalRuns = completedRuns + failedRuns;
  const sorted = [...elapsed].sort((a, b) => a - b);
  const elapsedTotal = sorted.reduce((sum, value) => sum + value, 0);

  return {
    windowFrom: window.from,
    windowTo: window.to,
    totalRuns: runs.length,
    completedRuns,
    failedRuns,
    runningRuns,
    // Terminal denominator, and null (not 0) when nothing has finished — "no data" is not "0%".
    failureRate: terminalRuns > 0 ? roundTo(failedRuns / terminalRuns, 4) : null,
    avgElapsedMs: sorted.length > 0 ? Math.round(elapsedTotal / sorted.length) : null,
    p50ElapsedMs: sorted.length > 0 ? Math.round(percentileNearestRank(sorted, 0.5)) : null,
    p95ElapsedMs: sorted.length > 0 ? Math.round(percentileNearestRank(sorted, 0.95)) : null,
    elapsedSampleSize: sorted.length,
    buckets: [...buckets.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)),
    granularity,
  };
}

/**
 * Percentage-POINT delta between two rates (each 0..1), or null when either side is null.
 *
 * Null propagates on purpose: a prior window with no terminal runs has no failure rate, and
 * "+4.2 points against nothing" would be an invented comparison. Rounded to 2 decimal points
 * so a 4-decimal rate difference does not render as a long float.
 */
export function deltaPoints(current: number | null, prior: number | null): number | null {
  if (current === null || prior === null) {
    return null;
  }
  return roundTo((current - prior) * 100, 2);
}

/**
 * The card row's figures for one window and optional traffic version (see `VersionFilter`).
 * Uses the same `scanWorkflowRuns` every other observability reader does — one scan, no
 * second pass.
 */
export async function getRunKpiSummary(
  window: AggregateWindow,
  version?: VersionFilter,
): Promise<RunKpiSummary> {
  const runs = await scanWorkflowRuns(window, version);

  if (runs.length >= RUN_SCAN_ROW_BUDGET) {
    // The scan's page budget is exhausted, so `totalRuns` is a floor, not a total. There is no
    // field on `RunKpiSummary` to say so, so say it in the logs instead of reporting silently.
    logWarn('dashboard_kpis_run_scan_truncated', {
      windowFrom: window.from,
      windowTo: window.to,
      scannedRows: runs.length,
      rowBudget: RUN_SCAN_ROW_BUDGET,
    });
  }

  return buildRunKpiSummary(runs, window);
}
