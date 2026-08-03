/**
 * B0-336 — aggregate reporting for the Prompt Observability admin feature (epic B0-330).
 *
 * Read-only, like `~/lib/observability/runs-repository.ts`. Nothing here writes.
 *
 * ## Why this reduces in Node instead of using a Postgres RPC
 * The dashboard window is ≤ a few weeks by design (the UI defaults to 7 days),
 * which is low thousands of `workflow_runs` rows and a small multiple of that in
 * `workflow_steps`. Fetching those rows and folding them here matches how the
 * existing admin chart surfaces already work (see
 * `~/components/admin/tests/RunAtAGlanceCharts.tsx`, whose inputs are shaped in
 * the page) and keeps the whole contract in TypeScript.
 *
 * Documented trigger for change: if a 7-day window ever exceeds
 * `MAX_SCAN_PAGES * SCAN_PAGE_SIZE` rows, or this call becomes a visible source
 * of latency on `/admin/observability`, replace the row scans with a Postgres
 * RPC following the existing `admin_latest_failures_*` precedent (migration +
 * `supabase.rpc(...)` reader) rather than growing the page budget here.
 */

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type {
  AggregateDashboardData,
  ConfidenceBucketDatum,
  FailureRateByDayDatum,
  LatencyByStepDatum,
  RoutingDistributionDatum,
} from '~/types/observability';

/** PostgREST caps a request at 1000 rows; sweep in pages of that size. */
const SCAN_PAGE_SIZE = 1000;
const MAX_SCAN_PAGES = 20;

/**
 * `review_tasks` / `workflow_steps` rows are written *during* a run, so a run
 * created at the very edge of the window can have children stamped just outside
 * it. Pad both child scans and then intersect on the run-id set for exactness.
 */
const CHILD_WINDOW_PADDING_MS = 60 * 60 * 1000;

/**
 * Confidence health buckets. Thresholds are chosen to line up with the
 * confidence-affecting gates in `run-product-support-workflow.ts`:
 *  - `high` (≥ 0.80): validator-approved answers and the 0.92 early-decline gate.
 *  - `mid`  (≥ 0.50, < 0.80): the 0.55 usage/safety coverage cap and the 0.6
 *    "validator bypassed, no sources" heuristic — answered, but thin.
 *  - `low`  (< 0.50): the 0.4 regulated-claim clamp and validator rejections.
 *  - `none`: `confidence IS NULL` — in-flight or failed before the validator ran.
 */
const CONFIDENCE_HIGH_MIN = 0.8;
const CONFIDENCE_MID_MIN = 0.5;

/** Bucket label for runs whose `final_output` carries no `routingDecision`. */
const UNROUTED_LABEL = 'unrouted';

export type AggregateWindow = {
  /** ISO timestamp, inclusive. */
  from: string;
  /** ISO timestamp, inclusive. */
  to: string;
};

type RunScanRow = {
  id: string;
  status: string;
  confidence: number | null;
  created_at: string;
  updated_at: string;
  routing_decision: string | null;
};

type StepScanRow = {
  workflow_run_id: string;
  step_name: string;
  started_at: string;
  completed_at: string | null;
};

function shiftIso(iso: string, deltaMs: number): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed + deltaMs).toISOString() : iso;
}

/** `YYYY-MM-DD` in UTC — matches `date_trunc('day', created_at)` on the server. */
function utcDayKey(iso: string): string | null {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Nearest-rank p95 over an ascending-sorted array. */
function percentile95(sortedAscending: number[]): number {
  if (sortedAscending.length === 0) {
    return 0;
  }
  const rank = Math.ceil(0.95 * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index] ?? 0;
}

async function scanWorkflowRuns(window: AggregateWindow): Promise<RunScanRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const rows: RunScanRow[] = [];

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    // `final_output` also holds the answer text and retrieved chunks, so pull
    // only the routing decision out of it rather than the whole JSON blob.
    const { data, error } = await supabase
      .from('workflow_runs')
      .select('id,status,confidence,created_at,updated_at,routing_decision:final_output->>routingDecision')
      .gte('created_at', window.from)
      .lte('created_at', window.to)
      .order('created_at', { ascending: true })
      .range(start, start + SCAN_PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message);
    }

    const batch = (data ?? []) as unknown as RunScanRow[];
    rows.push(...batch);

    if (batch.length < SCAN_PAGE_SIZE) {
      break;
    }
  }

  return rows;
}

async function scanWorkflowSteps(
  window: AggregateWindow,
  runIds: ReadonlySet<string>,
): Promise<StepScanRow[]> {
  if (runIds.size === 0) {
    return [];
  }

  const supabase = getSupabaseServiceRoleClient();
  const from = shiftIso(window.from, -CHILD_WINDOW_PADDING_MS);
  const to = shiftIso(window.to, CHILD_WINDOW_PADDING_MS);
  const rows: StepScanRow[] = [];

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    const { data, error } = await supabase
      .from('workflow_steps')
      .select('workflow_run_id,step_name,started_at,completed_at')
      .gte('started_at', from)
      .lte('started_at', to)
      .order('started_at', { ascending: true })
      .range(start, start + SCAN_PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message);
    }

    const batch = data ?? [];
    // Padded scan, so drop steps belonging to runs outside the window.
    rows.push(...batch.filter((row) => runIds.has(row.workflow_run_id)));

    if (batch.length < SCAN_PAGE_SIZE) {
      break;
    }
  }

  return rows;
}

/**
 * Runs escalated to a human. Sourced from `review_tasks` (written by
 * `insertReviewTask` in `~/lib/conversations/workflow-repository.ts`) rather
 * than the `review_requested` audit event: both are written in the same branch
 * of `run-product-support-workflow.ts`, but `review_tasks` is the durable
 * work-queue row with a real FK to `workflow_runs`. Counted as *distinct runs*
 * so a run with several tasks does not inflate the number.
 */
async function countHumanReviewRuns(
  window: AggregateWindow,
  runIds: ReadonlySet<string>,
): Promise<number> {
  if (runIds.size === 0) {
    return 0;
  }

  const supabase = getSupabaseServiceRoleClient();
  const from = shiftIso(window.from, -CHILD_WINDOW_PADDING_MS);
  const to = shiftIso(window.to, CHILD_WINDOW_PADDING_MS);
  const reviewed = new Set<string>();

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    const { data, error } = await supabase
      .from('review_tasks')
      .select('workflow_run_id')
      .gte('created_at', from)
      .lte('created_at', to)
      .range(start, start + SCAN_PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message);
    }

    const batch = data ?? [];
    for (const row of batch) {
      if (runIds.has(row.workflow_run_id)) {
        reviewed.add(row.workflow_run_id);
      }
    }

    if (batch.length < SCAN_PAGE_SIZE) {
      break;
    }
  }

  return reviewed.size;
}

function buildRoutingDistribution(runs: RunScanRow[]): RoutingDistributionDatum[] {
  const byDecision = new Map<string, { count: number; confidenceSum: number; confidenceCount: number }>();

  for (const run of runs) {
    const key = run.routing_decision?.trim() || UNROUTED_LABEL;
    const entry = byDecision.get(key) ?? { count: 0, confidenceSum: 0, confidenceCount: 0 };
    entry.count += 1;
    if (typeof run.confidence === 'number' && Number.isFinite(run.confidence)) {
      entry.confidenceSum += run.confidence;
      entry.confidenceCount += 1;
    }
    byDecision.set(key, entry);
  }

  return [...byDecision.entries()]
    .map(([routingDecision, entry]) => ({
      routingDecision,
      count: entry.count,
      avgConfidence:
        entry.confidenceCount > 0
          ? roundTo(entry.confidenceSum / entry.confidenceCount, 4)
          : null,
    }))
    .sort((a, b) => b.count - a.count || a.routingDecision.localeCompare(b.routingDecision));
}

function buildConfidenceBuckets(runs: RunScanRow[]): ConfidenceBucketDatum[] {
  const counts: Record<ConfidenceBucketDatum['bucket'], number> = {
    high: 0,
    mid: 0,
    low: 0,
    none: 0,
  };

  for (const run of runs) {
    if (typeof run.confidence !== 'number' || !Number.isFinite(run.confidence)) {
      counts.none += 1;
    } else if (run.confidence >= CONFIDENCE_HIGH_MIN) {
      counts.high += 1;
    } else if (run.confidence >= CONFIDENCE_MID_MIN) {
      counts.mid += 1;
    } else {
      counts.low += 1;
    }
  }

  return [
    { bucket: 'high', count: counts.high },
    { bucket: 'mid', count: counts.mid },
    { bucket: 'low', count: counts.low },
    { bucket: 'none', count: counts.none },
  ];
}

function buildLatencyByStep(steps: StepScanRow[]): LatencyByStepDatum[] {
  const byStep = new Map<string, number[]>();

  for (const step of steps) {
    if (!step.completed_at) {
      continue;
    }
    const started = Date.parse(step.started_at);
    const completed = Date.parse(step.completed_at);
    if (!Number.isFinite(started) || !Number.isFinite(completed)) {
      continue;
    }
    // `started_at` is stamped by Postgres (`now()` on insert) while
    // `completed_at` comes from the Node clock, so sub-second steps can land a
    // ~100ms *negative* delta from clock skew. Clamp to 0 rather than dropping
    // the row — dropping would erase fast steps (`orchestration_planner`,
    // `early_decline_gate`) from the chart entirely.
    const duration = Math.max(0, completed - started);
    const list = byStep.get(step.step_name) ?? [];
    list.push(duration);
    byStep.set(step.step_name, list);
  }

  return [...byStep.entries()]
    .map(([stepName, durations]) => {
      const sorted = [...durations].sort((a, b) => a - b);
      const total = sorted.reduce((sum, value) => sum + value, 0);
      return {
        stepName,
        avgDurationMs: Math.round(total / sorted.length),
        p95DurationMs: Math.round(percentile95(sorted)),
        sampleSize: sorted.length,
      };
    })
    .sort((a, b) => b.avgDurationMs - a.avgDurationMs || a.stepName.localeCompare(b.stepName));
}

function buildFailureRateByDay(
  runs: RunScanRow[],
  window: AggregateWindow,
): FailureRateByDayDatum[] {
  const byDay = new Map<string, { total: number; failed: number }>();

  // Seed every UTC day in the window so the chart has no gaps.
  const startDay = Date.parse(`${utcDayKey(window.from) ?? ''}T00:00:00.000Z`);
  const endDay = Date.parse(`${utcDayKey(window.to) ?? ''}T00:00:00.000Z`);
  if (Number.isFinite(startDay) && Number.isFinite(endDay) && endDay >= startDay) {
    const dayMs = 24 * 60 * 60 * 1000;
    const maxDays = 400;
    for (let day = startDay, i = 0; day <= endDay && i < maxDays; day += dayMs, i += 1) {
      byDay.set(new Date(day).toISOString().slice(0, 10), { total: 0, failed: 0 });
    }
  }

  for (const run of runs) {
    const key = utcDayKey(run.created_at);
    if (!key) {
      continue;
    }
    const entry = byDay.get(key) ?? { total: 0, failed: 0 };
    entry.total += 1;
    if (run.status === 'failed') {
      entry.failed += 1;
    }
    byDay.set(key, entry);
  }

  return [...byDay.entries()]
    .map(([day, entry]) => ({
      day,
      total: entry.total,
      failed: entry.failed,
      failureRate: entry.total > 0 ? roundTo(entry.failed / entry.total, 4) : 0,
    }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/**
 * Everything the aggregate dashboard renders, for one time window. Shares the
 * window with the runs list on `/admin/observability` (default: last 7 days).
 */
export async function getAggregateDashboardData(
  window: AggregateWindow,
): Promise<AggregateDashboardData> {
  const runs = await scanWorkflowRuns(window);
  const runIds = new Set(runs.map((run) => run.id));

  const [steps, humanReviewCount] = await Promise.all([
    scanWorkflowSteps(window, runIds),
    countHumanReviewRuns(window, runIds),
  ]);

  const confidences = runs
    .map((run) => run.confidence)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

  return {
    windowFrom: window.from,
    windowTo: window.to,
    totalRuns: runs.length,
    completedRuns: runs.filter((run) => run.status === 'completed').length,
    failedRuns: runs.filter((run) => run.status === 'failed').length,
    avgConfidence:
      confidences.length > 0
        ? roundTo(confidences.reduce((sum, value) => sum + value, 0) / confidences.length, 4)
        : null,
    humanReviewCount,
    routingDistribution: buildRoutingDistribution(runs),
    confidenceBuckets: buildConfidenceBuckets(runs),
    latencyByStep: buildLatencyByStep(steps),
    failureRateByDay: buildFailureRateByDay(runs, window),
  };
}
