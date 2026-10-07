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

import {
  type HarnessRunIndex,
  indexHarnessWorkflowRuns,
} from '~/lib/observability/runs-repository';
import {
  DEFAULT_STALE_AFTER_MS,
  isStalled,
} from '~/lib/observability/stalled-run-sweeper';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type {
  AggregateDashboardData,
  ConfidenceBucketDatum,
  FailureRateByDayDatum,
  LatencyByStepDatum,
  RoutingDistributionDatum,
  TokenUsageAggregate,
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
 *
 * Exported (B0-536) so `~/lib/observability/conversation-queries.ts` buckets confidence with the
 * exact same boundaries — the escalation-vs-confidence correlation must agree with this dashboard.
 */
export const CONFIDENCE_HIGH_MIN = 0.8;
export const CONFIDENCE_MID_MIN = 0.5;

/** Bucket label for runs whose `final_output` carries no `routingDecision`. */
const UNROUTED_LABEL = 'unrouted';

/**
 * B0-430 — `workflow_runs.status` values for which `updated_at` is a real end time. A run still
 * `running` is excluded from the elapsed average; see `buildAvgDurationMs`.
 *
 * Exported (B0-629) so `~/lib/observability/dashboard-kpis.ts` splits terminal from in-flight
 * runs on exactly this list. Verified against live data 2026-08-22: `workflow_runs.status` only
 * ever holds `completed`, `failed` or `running`.
 */
export const TERMINAL_RUN_STATUSES: ReadonlySet<string> = new Set(['completed', 'failed']);

export type AggregateWindow = {
  /** ISO timestamp, inclusive. */
  from: string;
  /** ISO timestamp, inclusive. */
  to: string;
};

/**
 * B0-581 — traffic-version narrowing for the Bex Health dashboard (epics B0-569/570/571).
 *
 * Semantics (the shared health-panel contract):
 *  - `null` / `undefined`     → no filter, all traffic. Every pre-existing call site passes
 *    nothing, so `/admin/observability` behavior is byte-for-byte unchanged.
 *  - `UNVERSIONED_TRAFFIC`    → only runs whose `workflow_runs.app_version` IS NULL
 *    (traffic that predates version stamping).
 *  - any other string         → exact match on `workflow_runs.app_version`.
 */
export const UNVERSIONED_TRAFFIC = 'unversioned';
export type VersionFilter = string | null | undefined;

/** Exported for `~/lib/observability/pipeline-stages.ts`, which composes the same scan. */
export type RunScanRow = {
  id: string;
  status: string;
  confidence: number | null;
  created_at: string;
  updated_at: string;
  routing_decision: string | null;
  /** B0-430 — `->>` yields text, so this is parsed by `parseTtftMs` rather than used directly. */
  ttft_ms: string | null;
  /**
   * B0-581 — `final_output.usage` fields (written by B0-117; `cachedPromptTokens` added by
   * B0-324). All `->>` text: null means the key is absent, NOT zero — `cached_prompt_tokens`
   * being null is how a pre-B0-324 run is excluded from the cache-share denominator.
   */
  total_tokens: string | null;
  prompt_tokens: string | null;
  cached_prompt_tokens: string | null;
};

/** Exported for `~/lib/observability/pipeline-stages.ts` (stage latency reuses `buildLatencyByStep`). */
export type StepScanRow = {
  workflow_run_id: string;
  step_name: string;
  started_at: string;
  completed_at: string | null;
};

function shiftIso(iso: string, deltaMs: number): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed + deltaMs).toISOString() : iso;
}

/**
 * `YYYY-MM-DD` in UTC — matches `date_trunc('day', created_at)` on the server.
 * Exported (B0-629) so the dashboard's day buckets key identically to `failureRateByDay`.
 */
export function utcDayKey(iso: string): string | null {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString().slice(0, 10);
}

/** Exported (B0-582) so the Gate stage's mean-confidence footer rounds exactly like `avgConfidence`. */
export function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Nearest-rank percentile over an ascending-sorted array. `percentile` is a fraction (0..1),
 * so p95 is `0.95` and the median is `0.5`.
 *
 * Exported (B0-629) so the Mission Control KPI cards compute p50/p95 with exactly this
 * definition — the dashboard's latency figures must reconcile with `/admin/observability`'s.
 * Nearest rank (no interpolation) means an even-sized sample's p50 is the LOWER of the two
 * middle values; that is deliberate, so a percentile is always an observed measurement.
 * Returns 0 for an empty array — callers that must distinguish "no samples" from a real 0ms
 * check the sample size themselves (see `StageLatency`, `RunKpiSummary.elapsedSampleSize`).
 */
export function percentileNearestRank(sortedAscending: number[], percentile: number): number {
  if (sortedAscending.length === 0) {
    return 0;
  }
  const rank = Math.ceil(percentile * sortedAscending.length);
  const index = Math.min(sortedAscending.length - 1, Math.max(0, rank - 1));
  return sortedAscending[index] ?? 0;
}

/** Nearest-rank p95 over an ascending-sorted array. */
function percentile95(sortedAscending: number[]): number {
  return percentileNearestRank(sortedAscending, 0.95);
}

/** Exported (B0-581/B0-582) so the Bex Health readers share this exact scan; see `VersionFilter`. */
export async function scanWorkflowRuns(
  window: AggregateWindow,
  version?: VersionFilter,
): Promise<RunScanRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const rows: RunScanRow[] = [];

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    // `final_output` also holds the answer text and retrieved chunks, so pull
    // only the routing decision, TTFT and token usage out of it rather than the
    // whole JSON blob. (B0-581 added the three `usage` fields — same scan, no
    // second pass, per this module's row-budget note above.)
    let query = supabase
      .from('workflow_runs')
      .select(
        'id,status,confidence,created_at,updated_at,routing_decision:final_output->>routingDecision,ttft_ms:final_output->timingBreakdown->>ttftMs,total_tokens:final_output->usage->>totalTokens,prompt_tokens:final_output->usage->>promptTokens,cached_prompt_tokens:final_output->usage->>cachedPromptTokens',
      )
      .gte('created_at', window.from)
      .lte('created_at', window.to);

    if (version === UNVERSIONED_TRAFFIC) {
      query = query.is('app_version', null);
    } else if (typeof version === 'string') {
      query = query.eq('app_version', version);
    }

    const { data, error } = await query
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

/** Exported (B0-582) so `~/lib/observability/pipeline-stages.ts` shares this exact scan. */
export async function scanWorkflowSteps(
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
 * B0-629 — one `workflow_steps` row's persisted `output`, for a single named step.
 * `output` is jsonb, so it arrives as an already-parsed but unvalidated value: narrow it at
 * the call site (the routing-health and tool-health readers each parse their own shape).
 */
export type NamedStepScanRow = { workflow_run_id: string; output: unknown };

/**
 * B0-629 — the persisted `output` of ONE named step, for runs in the window.
 *
 * Same contract as `scanWorkflowSteps` above (padded `started_at` scan, same page budget,
 * post-filtered against the window's run-id set), narrowed to a single `step_name` and
 * selecting `output` instead of the timing columns. Exists so the Mission Control readers
 * that each need one step's output — routing-health (`orchestration_planner`), tool-health
 * (`openai_responses_agent`) — share one scan implementation rather than re-deriving the
 * padding and paging rules; compare `scanValidatorIssueRows` in
 * `~/lib/observability/pipeline-stages.ts`, which predates this helper.
 *
 * Note `output` is the FULL step blob (no `->` narrowing), which is the point — callers want
 * different keys out of it — but it is therefore the widest of the child scans. Callers that
 * only need one jsonb key should select that key directly instead.
 */
export async function scanWorkflowStepOutputsByName(
  window: AggregateWindow,
  runIds: ReadonlySet<string>,
  stepName: string,
): Promise<NamedStepScanRow[]> {
  if (runIds.size === 0) {
    return [];
  }

  const supabase = getSupabaseServiceRoleClient();
  const from = shiftIso(window.from, -CHILD_WINDOW_PADDING_MS);
  const to = shiftIso(window.to, CHILD_WINDOW_PADDING_MS);
  const rows: NamedStepScanRow[] = [];

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    const { data, error } = await supabase
      .from('workflow_steps')
      .select('workflow_run_id,output')
      .eq('step_name', stepName)
      .gte('started_at', from)
      .lte('started_at', to)
      .order('started_at', { ascending: true })
      .range(start, start + SCAN_PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message);
    }

    const batch = (data ?? []) as unknown as NamedStepScanRow[];
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
 *
 * Exported (B0-582): the Gate stage's "forced to review" footer is this same figure.
 */
export async function countHumanReviewRuns(
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

/** Exported (B0-582): the Route stage's "ambiguous" footer reads this distribution's `ambiguous` entry. */
export function buildRoutingDistribution(runs: RunScanRow[]): RoutingDistributionDatum[] {
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

/**
 * Exported (B0-582): the pipeline stage strip's per-stage avg/p95/n must reconcile with
 * `/admin/observability`'s latency-by-step panel, so both go through this one function —
 * including the clock-skew clamp below.
 */
export function buildLatencyByStep(steps: StepScanRow[]): LatencyByStepDatum[] {
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
        // B0-629 — p50 reuses the single sort above; the array is not sorted twice.
        p50DurationMs: Math.round(percentileNearestRank(sorted, 0.5)),
        p95DurationMs: Math.round(percentile95(sorted)),
        sampleSize: sorted.length,
      };
    })
    .sort((a, b) => b.avgDurationMs - a.avgDurationMs || a.stepName.localeCompare(b.stepName));
}

/** A mean plus the number of runs it was taken over, so a thin sample is never hidden. */
type MeanMsDatum = { mean: number | null; sampleSize: number };

function meanMs(values: number[]): MeanMsDatum {
  if (values.length === 0) {
    return { mean: null, sampleSize: 0 };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return { mean: Math.round(total / values.length), sampleSize: values.length };
}

/** `final_output->timingBreakdown->>ttftMs` arrives as text; mirrors `readTtftMs`'s guards. */
function parseTtftMs(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * B0-430 — mean time to first assistant token over the window.
 *
 * Resolves each run exactly as the runs table's "Stream" column does (`toListRow` in
 * `~/lib/observability/runs-repository.ts`): the run's own `timingBreakdown.ttftMs` first, then
 * the harness's `test_result_items.ttft_ms`. The fallback is load-bearing, not cosmetic — most
 * runs predating the B0-429 instrumentation only have the harness value, so dropping it would
 * make this tile disagree with the column directly beneath it.
 */
function buildAvgTtftMs(runs: RunScanRow[], harnessTtft: HarnessRunIndex): MeanMsDatum {
  const values: number[] = [];

  for (const run of runs) {
    const ttft = parseTtftMs(run.ttft_ms) ?? harnessTtft.get(run.id) ?? null;
    if (ttft !== null) {
      values.push(ttft);
    }
  }

  return meanMs(values);
}

/**
 * B0-430 — mean wall-clock run duration, over finished runs only.
 *
 * `updated_at` is an end time only once a run has stopped: while it is `running` that column is
 * the last progress write, and for an orphaned run (see `countOrphanedRuns`) it can be hours or
 * days stale. Averaging those in would drag the number around for reasons that have nothing to do
 * with how long runs actually take, so in-flight runs are left out instead of counted as fast.
 */
function buildAvgDurationMs(runs: RunScanRow[]): MeanMsDatum {
  const values: number[] = [];

  for (const run of runs) {
    const elapsed = terminalElapsedMs(run);
    if (elapsed !== null) {
      values.push(elapsed);
    }
  }

  return meanMs(values);
}

/**
 * `updated_at - created_at` for a FINISHED run, or null when the run is still in flight or the
 * span is unusable. The single definition of "elapsed" — exported (B0-629) so
 * `~/lib/observability/dashboard-kpis.ts` and `buildAvgDurationMs` above cannot drift apart.
 */
export function terminalElapsedMs(
  run: Pick<RunScanRow, 'status' | 'created_at' | 'updated_at'>,
): number | null {
  if (!TERMINAL_RUN_STATUSES.has(run.status)) {
    return null;
  }
  const started = Date.parse(run.created_at);
  const ended = Date.parse(run.updated_at);
  // Same guard as `durationMsBetween`: drop unparseable or inverted spans.
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) {
    return null;
  }
  return ended - started;
}

/** The token fields of `RunScanRow` — the only inputs `buildTokenUsage` needs, kept narrow for tests. */
export type TokenUsageScanRow = Pick<
  RunScanRow,
  'total_tokens' | 'prompt_tokens' | 'cached_prompt_tokens'
>;

/** `->>` yields text; a token count must parse to a finite non-negative number to count. */
function parseTokenCount(raw: string | null): number | null {
  if (raw === null) {
    return null;
  }
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * B0-581 — token spend per run and the cached share of prompt tokens, folded from the
 * rows the window scan already fetched (no second pass).
 *
 *  - `avgTotalTokens` averages `final_output.usage.totalTokens` over runs that recorded
 *    usage at all (`tokenSampleSize`); a run with no `usage` (failed early, or predates
 *    B0-117) is out of the sample rather than counted as zero.
 *  - `cachedPromptShare` = Σ cachedPromptTokens / Σ promptTokens, over ONLY the runs whose
 *    usage carries the `cachedPromptTokens` key (`cachedShareSampleSize`). Runs predating
 *    B0-324 have usage without that key; including their prompt tokens in the denominator
 *    would deflate the share, so they are excluded and the sample size is surfaced.
 */
export function buildTokenUsage(runs: TokenUsageScanRow[]): TokenUsageAggregate {
  let totalTokensSum = 0;
  let tokenSampleSize = 0;
  let cachedSum = 0;
  let promptSumForCache = 0;
  let cachedShareSampleSize = 0;

  for (const run of runs) {
    const total = parseTokenCount(run.total_tokens);
    if (total !== null) {
      totalTokensSum += total;
      tokenSampleSize += 1;
    }

    const cached = parseTokenCount(run.cached_prompt_tokens);
    const prompt = parseTokenCount(run.prompt_tokens);
    // Both fields must be present: `cached !== null` is what excludes pre-B0-324 runs.
    if (cached !== null && prompt !== null) {
      cachedSum += cached;
      promptSumForCache += prompt;
      cachedShareSampleSize += 1;
    }
  }

  return {
    avgTotalTokens: tokenSampleSize > 0 ? Math.round(totalTokensSum / tokenSampleSize) : null,
    tokenSampleSize,
    cachedPromptShare:
      promptSumForCache > 0 ? roundTo(cachedSum / promptSumForCache, 4) : null,
    cachedShareSampleSize,
  };
}

/**
 * B0-371 — runs still `running` past the sweeper's staleness threshold, i.e. orphaned
 * records with no terminal row. Folded from the rows already scanned above, so this
 * costs no extra query.
 *
 * `created_at` is Postgres `now()` and this comparison uses the Node clock, so it goes
 * through `isStalled`, which clamps the age at 0. A genuinely in-flight run therefore
 * can never be counted here, and no row is ever dropped for having a negative age.
 */
function countOrphanedRuns(runs: RunScanRow[], nowMs: number): number {
  return runs.filter(
    (run) => run.status === 'running' && isStalled(run.created_at, nowMs, DEFAULT_STALE_AFTER_MS),
  ).length;
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
  /**
   * B0-581 — optional; omitted by every `/admin/observability` call site, whose behavior is
   * unchanged. The Bex Health panels pass `{ version }` per the shared props contract.
   */
  options?: { version?: VersionFilter },
): Promise<AggregateDashboardData> {
  const runs = await scanWorkflowRuns(window, options?.version);
  const runIds = new Set(runs.map((run) => run.id));

  const [steps, humanReviewCount, harnessTtft] = await Promise.all([
    scanWorkflowSteps(window, runIds),
    countHumanReviewRuns(window, runIds),
    // Padded like the other child scans: a harness item is written after the run it belongs to.
    indexHarnessWorkflowRuns(
      shiftIso(window.from, -CHILD_WINDOW_PADDING_MS),
      shiftIso(window.to, CHILD_WINDOW_PADDING_MS),
    ),
  ]);

  const avgTtft = buildAvgTtftMs(runs, harnessTtft);
  const avgDuration = buildAvgDurationMs(runs);

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
    orphanedRuns: countOrphanedRuns(runs, Date.now()),
    avgTtftMs: avgTtft.mean,
    ttftSampleSize: avgTtft.sampleSize,
    avgDurationMs: avgDuration.mean,
    durationSampleSize: avgDuration.sampleSize,
    tokenUsage: buildTokenUsage(runs),
    routingDistribution: buildRoutingDistribution(runs),
    confidenceBuckets: buildConfidenceBuckets(runs),
    latencyByStep: buildLatencyByStep(steps),
    failureRateByDay: buildFailureRateByDay(runs, window),
  };
}
