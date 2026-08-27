/**
 * B0-466 — day/hour-bucketed tool-call failure-rate TIME SERIES, for threshold alerting.
 *
 * ## Why this is not `tool-health.ts`
 * `~/lib/observability/tool-health.ts` (B0-629) already computes a failure rate, but it is one
 * rate per TOOL for one whole window — there is no notion of "yesterday vs today", so nothing in
 * it can detect a step change. This module is the missing time axis, shaped like
 * `buildFailureRateByDay` in `~/lib/observability/aggregates.ts` (day-bucketed, gap-seeded) and
 * built like `~/lib/observability/conversation-queries.ts` (pure fold + thin paged fetcher).
 *
 * ## Why `audit_logs` and not `workflow_steps.output.toolTrace`
 * `tool-health.ts` reads the persisted `toolTrace` on the `openai_responses_agent` step. Verified
 * live 2026-08-27: that field carries ZERO entries before 2026-08-03 (the rollout date noted in
 * `run-product-support-workflow.ts`), so a series built from it is blind to the entire May–June
 * 2026 regression this ticket exists for. The `tool_called` / `tool_succeeded` / `tool_failed`
 * audit rows go back to 2026-04-10 (13,050 / 10,791 / 2,244 rows), which is also how B0-417 and
 * B0-446 reconstructed that incident. They are therefore the source of truth here, and the same
 * source `~/lib/observability/timeline.ts` and `pipeline-stages.ts` already reconstruct calls from.
 *
 * ## "Settled" is the denominator, deliberately
 * A `tool_called` row with no outcome row is an UNSETTLED call (process death mid-call, see
 * `ToolCallSpan.unsettled` in `~/types/observability.ts`). Counting it would put in-flight and
 * abandoned calls in the denominator and quietly depress the failure rate, which is exactly the
 * failure mode an alert must not have. So the denominator is `tool_succeeded + tool_failed` only,
 * and `tool_called` is never read here.
 *
 * ## Speculative calls are reported both ways
 * B0-436 speculative retrievals carry `payload.speculative = true`. `tool-health.ts` EXCLUDES them
 * from its ordinary-call rate. Live check 2026-08-27: the marker exists only from 2026-08 onward
 * (2,689 of 4,031 August outcome rows; 9 failures), so on every historical bucket the two rates are
 * identical. Both are computed per bucket: `failureRate` over all settled calls (the ticket's
 * literal metric, and the calmer of the two — 0.00%–1.32% per day in the current regime) and
 * `ordinaryFailureRate` over non-speculative calls only (comparable with the Mission Control panel,
 * but noisy on the small post-speculative denominators). The alert rules read `failureRate`; see
 * `~/lib/observability/alert-rules.ts` for why.
 *
 * Documented trigger for change (same as the modules above): if a window's outcome rows ever
 * exceed `MAX_SCAN_PAGES * SCAN_PAGE_SIZE`, replace the paged scan with a Postgres RPC rather than
 * growing the budget — `truncated` on the returned series is how a caller notices that happening.
 */

import { roundTo, utcDayKey } from '~/lib/observability/aggregates';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/** PostgREST caps a request at 1000 rows; sweep in pages of that size. */
const SCAN_PAGE_SIZE = 1000;
const MAX_SCAN_PAGES = 20;

/** Ceiling on seeded empty buckets: 400 days (the `aggregates.ts` bound) or ~33 days of hours. */
const MAX_SEEDED_BUCKETS = 800;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

/** The two terminal tool-call audit events. `tool_called` is deliberately NOT one of them. */
export const SETTLED_TOOL_EVENT_TYPES = ['tool_succeeded', 'tool_failed'] as const;
export const TOOL_FAILED_EVENT_TYPE = 'tool_failed';

export type SeriesBucketSize = 'day' | 'hour';

export type ToolFailureSeriesWindow = {
  /** ISO timestamp, inclusive. */
  from: string;
  /** ISO timestamp, inclusive. */
  to: string;
};

/** One `tool_succeeded` / `tool_failed` audit row, narrowed to what the fold needs. */
export type ToolOutcomeScanRow = {
  event_type: string;
  created_at: string;
  /** `payload->>speculative` — text, so `'true'` not `true`; null on every pre-B0-436 row. */
  speculative: string | null;
};

export type ToolFailureRatePoint = {
  /** `YYYY-MM-DD` for day buckets, `YYYY-MM-DDTHH` for hour buckets, both UTC. */
  bucket: string;
  /** Start of the bucket as an ISO timestamp — what an alert message quotes. */
  bucketStart: string;
  /** `tool_succeeded + tool_failed` in the bucket. The alertable sample size. */
  settled: number;
  failed: number;
  /**
   * `failed / settled`, 0..1, 4dp. **`null`, never `0`, when `settled === 0`** — deliberately
   * unlike `buildFailureRateByDay`, which reports 0 for an empty day. A seeded gap is "no traffic",
   * and an alert rule that read it as a real 0% would compute a fictional spike off it.
   */
  failureRate: number | null;
  /** Non-speculative subset (B0-436), comparable with `tool-health.ts`'s per-tool rate. */
  ordinarySettled: number;
  ordinaryFailed: number;
  ordinaryFailureRate: number | null;
  /** Speculative subset, reported so the two denominators reconcile rather than disagree. */
  speculativeSettled: number;
  speculativeFailed: number;
};

export type ToolFailureRateSeries = {
  bucketSize: SeriesBucketSize;
  windowFrom: string;
  windowTo: string;
  /** Oldest first, every bucket in the window present (gap-seeded with `settled: 0`). */
  points: ToolFailureRatePoint[];
  /** Outcome rows folded into `points`. */
  scannedRows: number;
  /** True when the paged scan hit its page budget: the series may under-count. */
  truncated: boolean;
};

function bucketKey(iso: string, bucketSize: SeriesBucketSize): string | null {
  const day = utcDayKey(iso);
  if (!day) {
    return null;
  }
  if (bucketSize === 'day') {
    return day;
  }
  const hour = new Date(Date.parse(iso)).toISOString().slice(11, 13);
  return `${day}T${hour}`;
}

function bucketStartIso(key: string, bucketSize: SeriesBucketSize): string {
  return bucketSize === 'day' ? `${key}T00:00:00.000Z` : `${key}:00:00.000Z`;
}

type Accumulator = {
  settled: number;
  failed: number;
  ordinarySettled: number;
  ordinaryFailed: number;
  speculativeSettled: number;
  speculativeFailed: number;
};

function emptyAccumulator(): Accumulator {
  return {
    settled: 0,
    failed: 0,
    ordinarySettled: 0,
    ordinaryFailed: 0,
    speculativeSettled: 0,
    speculativeFailed: 0,
  };
}

/**
 * Seeds every bucket between `from` and `to` (inclusive, UTC-truncated) so the series has no
 * holes — a consumer must be able to tell "no traffic that day" from "that day is missing".
 * Bounded by `MAX_SEEDED_BUCKETS`, so an absurd window degrades to a truncated series instead of
 * allocating unboundedly.
 */
function seedBuckets(
  window: ToolFailureSeriesWindow,
  bucketSize: SeriesBucketSize,
): Map<string, Accumulator> {
  const buckets = new Map<string, Accumulator>();
  const stepMs = bucketSize === 'day' ? DAY_MS : HOUR_MS;
  const startKey = bucketKey(window.from, bucketSize);
  const endKey = bucketKey(window.to, bucketSize);
  if (!startKey || !endKey) {
    return buckets;
  }

  const start = Date.parse(bucketStartIso(startKey, bucketSize));
  const end = Date.parse(bucketStartIso(endKey, bucketSize));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return buckets;
  }

  for (let at = start, i = 0; at <= end && i < MAX_SEEDED_BUCKETS; at += stepMs, i += 1) {
    const key = bucketKey(new Date(at).toISOString(), bucketSize);
    if (key) {
      buckets.set(key, emptyAccumulator());
    }
  }

  return buckets;
}

/**
 * Pure fold, exported for unit tests. Rows outside the seeded range are still counted (they get
 * their own bucket) rather than dropped: an alerter must never silently discard evidence.
 */
export function buildToolFailureRateSeries(input: {
  rows: ToolOutcomeScanRow[];
  window: ToolFailureSeriesWindow;
  bucketSize: SeriesBucketSize;
  truncated?: boolean;
}): ToolFailureRateSeries {
  const { rows, window, bucketSize } = input;
  const buckets = seedBuckets(window, bucketSize);

  for (const row of rows) {
    const key = bucketKey(row.created_at, bucketSize);
    if (!key) {
      continue;
    }
    const entry = buckets.get(key) ?? emptyAccumulator();
    // Any row that reached this fold is settled by construction of the scan's event filter.
    const failed = row.event_type === TOOL_FAILED_EVENT_TYPE;
    const speculative = row.speculative === 'true';

    entry.settled += 1;
    if (failed) {
      entry.failed += 1;
    }
    if (speculative) {
      entry.speculativeSettled += 1;
      if (failed) {
        entry.speculativeFailed += 1;
      }
    } else {
      entry.ordinarySettled += 1;
      if (failed) {
        entry.ordinaryFailed += 1;
      }
    }
    buckets.set(key, entry);
  }

  const points: ToolFailureRatePoint[] = [...buckets.entries()]
    .map(([bucket, entry]) => ({
      bucket,
      bucketStart: bucketStartIso(bucket, bucketSize),
      settled: entry.settled,
      failed: entry.failed,
      failureRate: entry.settled > 0 ? roundTo(entry.failed / entry.settled, 4) : null,
      ordinarySettled: entry.ordinarySettled,
      ordinaryFailed: entry.ordinaryFailed,
      ordinaryFailureRate:
        entry.ordinarySettled > 0 ? roundTo(entry.ordinaryFailed / entry.ordinarySettled, 4) : null,
      speculativeSettled: entry.speculativeSettled,
      speculativeFailed: entry.speculativeFailed,
    }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));

  return {
    bucketSize,
    windowFrom: window.from,
    windowTo: window.to,
    points,
    scannedRows: rows.length,
    truncated: input.truncated ?? false,
  };
}

/** Paged scan of the two settled tool-call audit events in the window. */
async function scanToolOutcomeRows(
  window: ToolFailureSeriesWindow,
): Promise<{ rows: ToolOutcomeScanRow[]; truncated: boolean }> {
  const supabase = getSupabaseServiceRoleClient();
  const rows: ToolOutcomeScanRow[] = [];
  let truncated = false;

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    // Only the one jsonb key is selected, not the whole `payload` (which carries the failure
    // message and arguments preview on every failure row) — see the note on
    // `scanWorkflowStepOutputsByName` about narrowing jsonb at the query.
    const { data, error } = await supabase
      .from('audit_logs')
      .select('event_type,created_at,speculative:payload->>speculative')
      .in('event_type', [...SETTLED_TOOL_EVENT_TYPES])
      .gte('created_at', window.from)
      .lte('created_at', window.to)
      .order('created_at', { ascending: true })
      .range(start, start + SCAN_PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message);
    }

    const batch = (data ?? []) as unknown as ToolOutcomeScanRow[];
    rows.push(...batch);

    if (batch.length < SCAN_PAGE_SIZE) {
      return { rows, truncated: false };
    }
    truncated = page === MAX_SCAN_PAGES - 1;
  }

  return { rows, truncated };
}

/** Reader half: the window's settled tool-call outcomes, folded into a bucketed series. */
export async function getToolFailureRateSeries(
  window: ToolFailureSeriesWindow,
  bucketSize: SeriesBucketSize = 'day',
): Promise<ToolFailureRateSeries> {
  const { rows, truncated } = await scanToolOutcomeRows(window);
  return buildToolFailureRateSeries({ rows, window, bucketSize, truncated });
}
