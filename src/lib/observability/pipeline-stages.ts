/**
 * B0-582 — the "pipeline stage strip" reader for the Bex Health dashboard
 * (epics B0-569/570/571): route → retrieve → generate → validate → gate.
 *
 * Read-only, like `~/lib/observability/aggregates.ts`, and composed FROM it:
 * the run/step scans, latency math (including the clock-skew clamp), routing
 * distribution, token folding and review count are the exact same functions
 * `/admin/observability` renders from, so the strip reconciles with that page
 * for the same window by construction. This file adds only what the strip
 * needs on top: the stage → step mapping, the tool-call scan (Retrieve), and
 * the validator-issue scan (Validate).
 */

import {
  type AggregateWindow,
  buildLatencyByStep,
  buildRoutingDistribution,
  buildTokenUsage,
  countHumanReviewRuns,
  type RunScanRow,
  roundTo,
  scanWorkflowRuns,
  scanWorkflowSteps,
  type StepScanRow,
  type VersionFilter,
} from '~/lib/observability/aggregates';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/** Mirrors the paging constants in `~/lib/observability/aggregates.ts` (same row budget). */
const SCAN_PAGE_SIZE = 1000;
const MAX_SCAN_PAGES = 20;

/** Same padding rationale as `CHILD_WINDOW_PADDING_MS` in aggregates: child rows are written during a run. */
const CHILD_WINDOW_PADDING_MS = 60 * 60 * 1000;

export type PipelineStageId = 'route' | 'retrieve' | 'generate' | 'validate' | 'gate';

/**
 * THE stage → data-source mapping — documented here and nowhere else.
 *
 * `workflow_steps.step_name` values that actually occur (verified against live data
 * 2026-08-21, and against `CANONICAL_STEP_SEQUENCE` / `STEP_LABELS` in
 * `~/lib/observability/timeline.ts`): `orchestration_planner`, `openai_responses_agent`,
 * `validator`, `early_decline_gate`, `revision`.
 *
 *  - route    → `orchestration_planner` (the planner's routing decision).
 *  - retrieve → NO `workflow_steps` row exists for retrieval: it happens as tool calls
 *    inside the `openai_responses_agent` tool loop. Stage timing is therefore derived
 *    from the `tool_called` → `tool_succeeded`/`tool_failed` audit rows (per call), fed
 *    through the same `buildLatencyByStep` math as the real steps.
 *  - generate → `openai_responses_agent` (the whole tool loop, retrieval included — the
 *    stages overlap by design; the strip labels say what each number measures).
 *  - validate → `validator`.
 *  - gate     → `early_decline_gate` is the only gate with a persisted step row; the
 *    post-validation confidence gates run inline in the workflow and leave no step. It is
 *    an alternative terminal branch (most runs never hit it), so a small n is normal.
 *
 * `revision` is deliberately unmapped: it is a conditional re-generate pass after a
 * validator rejection, not a stage every run passes through.
 */
export const PIPELINE_STAGES: ReadonlyArray<{
  id: PipelineStageId;
  number: string;
  name: string;
  /** `workflow_steps.step_name` the stage's latency comes from; null = audit-derived (retrieve). */
  stepName: string | null;
  /** What the latency figures measure, for the stage box's sub-label. */
  represents: string;
}> = [
  {
    id: 'route',
    number: '01',
    name: 'Route',
    stepName: 'orchestration_planner',
    represents: 'workflow_steps · orchestration_planner',
  },
  {
    id: 'retrieve',
    number: '02',
    name: 'Retrieve',
    stepName: null,
    represents: 'audit_logs · tool calls (no step row exists)',
  },
  {
    id: 'generate',
    number: '03',
    name: 'Generate',
    stepName: 'openai_responses_agent',
    represents: 'workflow_steps · openai_responses_agent',
  },
  {
    id: 'validate',
    number: '04',
    name: 'Validate',
    stepName: 'validator',
    represents: 'workflow_steps · validator',
  },
  {
    id: 'gate',
    number: '05',
    name: 'Gate',
    stepName: 'early_decline_gate',
    represents: 'workflow_steps · early_decline_gate (decline branch only)',
  },
];

/**
 * The Validate stage's "skipped or bypassed" markers, as persisted in the validator
 * step's `output.issues`. These are the same strings `~/lib/observability/timeline.ts`
 * discriminates its `validator_bypass` / `validator_skip_high_similarity` gates on.
 * NOT an audit event — no such audit row exists.
 */
export const VALIDATOR_SKIP_ISSUES = [
  'validator_bypassed_for_testing',
  'validator_skipped_high_similarity_non_safety_route',
] as const;

/** avg/p95/n for one stage; null = no samples in the window (never a zero average). */
export type StageLatency = {
  avgDurationMs: number;
  p95DurationMs: number;
  sampleSize: number;
} | null;

export type PipelineStageStripData = {
  windowFrom: string;
  windowTo: string;
  totalRuns: number;
  route: { latency: StageLatency; ambiguousRouteCount: number };
  retrieve: { latency: StageLatency; failedToolCallCount: number };
  generate: {
    latency: StageLatency;
    avgTotalTokens: number | null;
    tokenSampleSize: number;
  };
  validate: { latency: StageLatency; skippedOrBypassedCount: number };
  gate: {
    latency: StageLatency;
    meanFinalConfidence: number | null;
    confidenceSampleSize: number;
    forcedToReviewCount: number;
  };
};

/** One `tool_called`/`tool_succeeded`/`tool_failed` audit row, narrowed to what the strip needs. */
export type ToolEventScanRow = {
  workflow_run_id: string | null;
  event_type: string;
  created_at: string;
  /** `payload->>call_id` — pairs a call with its outcome row. */
  call_id: string | null;
};

/** One validator step's `workflow_run_id` + `output->issues` (a JSON array, or null). */
export type ValidatorIssueScanRow = {
  workflow_run_id: string;
  issues: unknown;
};

/**
 * Per-call durations from the audit rows, shaped as pseudo step rows so
 * `buildLatencyByStep` computes them with the exact same math as the real
 * steps — nearest-rank p95, and the ≥0 clamp (a call with no settle row has a
 * null `completed_at` and is excluded from timing, exactly like an unfinished step).
 */
const RETRIEVE_PSEUDO_STEP = 'retrieve_tool_call';

function buildRetrieveLatencyRows(toolEvents: ToolEventScanRow[]): StepScanRow[] {
  const byCallId = new Map<string, { calledAt: string | null; settledAt: string | null; runId: string }>();

  for (const event of toolEvents) {
    if (!event.call_id || !event.workflow_run_id) {
      continue;
    }
    const entry =
      byCallId.get(event.call_id) ??
      { calledAt: null, settledAt: null, runId: event.workflow_run_id };
    if (event.event_type === 'tool_called') {
      entry.calledAt = entry.calledAt ?? event.created_at;
    } else if (event.event_type === 'tool_succeeded' || event.event_type === 'tool_failed') {
      entry.settledAt = event.created_at;
    }
    byCallId.set(event.call_id, entry);
  }

  const rows: StepScanRow[] = [];
  for (const entry of byCallId.values()) {
    if (!entry.calledAt) {
      // A settle row with no `tool_called` row (forced calls bypass it) has no start time.
      continue;
    }
    rows.push({
      workflow_run_id: entry.runId,
      step_name: RETRIEVE_PSEUDO_STEP,
      started_at: entry.calledAt,
      completed_at: entry.settledAt,
    });
  }
  return rows;
}

function readIssueStrings(issues: unknown): string[] {
  if (!Array.isArray(issues)) {
    return [];
  }
  return issues.filter((item): item is string => typeof item === 'string');
}

/**
 * Pure assembly — everything below the fetches, unit-testable against fixture rows.
 */
export function buildPipelineStageStripData(input: {
  window: AggregateWindow;
  runs: RunScanRow[];
  steps: StepScanRow[];
  toolEvents: ToolEventScanRow[];
  validatorIssueRows: ValidatorIssueScanRow[];
  forcedToReviewCount: number;
}): PipelineStageStripData {
  const { window, runs, steps, toolEvents, validatorIssueRows, forcedToReviewCount } = input;

  // One latency table for real steps + the audit-derived retrieve rows, all through the
  // same shared math (`buildLatencyByStep` clamps skewed negative durations at 0 and
  // never drops the row). A step name absent from the window is simply absent from the
  // map, so the stage degrades to `latency: null` — "no samples", not a zero average.
  const latencyByStep = new Map(
    buildLatencyByStep([...steps, ...buildRetrieveLatencyRows(toolEvents)]).map((datum) => [
      datum.stepName,
      {
        avgDurationMs: datum.avgDurationMs,
        p95DurationMs: datum.p95DurationMs,
        sampleSize: datum.sampleSize,
      },
    ]),
  );
  const latencyFor = (stepName: string): StageLatency => latencyByStep.get(stepName) ?? null;

  // Route footer — the same `routingDistribution` the aggregate dashboard renders.
  const ambiguousRouteCount =
    buildRoutingDistribution(runs).find((datum) => datum.routingDecision === 'ambiguous')
      ?.count ?? 0;

  // Validate footer — distinct runs whose validator output carries a skip/bypass marker.
  const skippedOrBypassedRunIds = new Set<string>();
  for (const row of validatorIssueRows) {
    const issues = readIssueStrings(row.issues);
    if (VALIDATOR_SKIP_ISSUES.some((marker) => issues.includes(marker))) {
      skippedOrBypassedRunIds.add(row.workflow_run_id);
    }
  }

  // Gate footer — mean `workflow_runs.confidence`, rounded exactly like `avgConfidence`
  // on the aggregate dashboard (same rows, same `roundTo(…, 4)`).
  const confidences = runs
    .map((run) => run.confidence)
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  const meanFinalConfidence =
    confidences.length > 0
      ? roundTo(confidences.reduce((sum, value) => sum + value, 0) / confidences.length, 4)
      : null;

  const tokenUsage = buildTokenUsage(runs);

  return {
    windowFrom: window.from,
    windowTo: window.to,
    totalRuns: runs.length,
    route: {
      latency: latencyFor('orchestration_planner'),
      ambiguousRouteCount,
    },
    retrieve: {
      latency: latencyFor(RETRIEVE_PSEUDO_STEP),
      failedToolCallCount: toolEvents.filter((event) => event.event_type === 'tool_failed')
        .length,
    },
    generate: {
      latency: latencyFor('openai_responses_agent'),
      avgTotalTokens: tokenUsage.avgTotalTokens,
      tokenSampleSize: tokenUsage.tokenSampleSize,
    },
    validate: {
      latency: latencyFor('validator'),
      skippedOrBypassedCount: skippedOrBypassedRunIds.size,
    },
    gate: {
      latency: latencyFor('early_decline_gate'),
      meanFinalConfidence,
      confidenceSampleSize: confidences.length,
      forcedToReviewCount,
    },
  };
}

function shiftIso(iso: string, deltaMs: number): string {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? new Date(parsed + deltaMs).toISOString() : iso;
}

/** The three tool-outcome audit rows for runs in the window (padded scan, run-id intersected). */
async function scanToolEvents(
  window: AggregateWindow,
  runIds: ReadonlySet<string>,
): Promise<ToolEventScanRow[]> {
  if (runIds.size === 0) {
    return [];
  }

  const supabase = getSupabaseServiceRoleClient();
  const from = shiftIso(window.from, -CHILD_WINDOW_PADDING_MS);
  const to = shiftIso(window.to, CHILD_WINDOW_PADDING_MS);
  const rows: ToolEventScanRow[] = [];

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    const { data, error } = await supabase
      .from('audit_logs')
      .select('workflow_run_id,event_type,created_at,call_id:payload->>call_id')
      .in('event_type', ['tool_called', 'tool_succeeded', 'tool_failed'])
      .gte('created_at', from)
      .lte('created_at', to)
      .order('created_at', { ascending: true })
      .range(start, start + SCAN_PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message);
    }

    const batch = (data ?? []) as unknown as ToolEventScanRow[];
    rows.push(
      ...batch.filter(
        (row) => row.workflow_run_id !== null && runIds.has(row.workflow_run_id),
      ),
    );

    if (batch.length < SCAN_PAGE_SIZE) {
      break;
    }
  }

  return rows;
}

/** Validator steps' `output->issues` for runs in the window (padded scan, run-id intersected). */
async function scanValidatorIssueRows(
  window: AggregateWindow,
  runIds: ReadonlySet<string>,
): Promise<ValidatorIssueScanRow[]> {
  if (runIds.size === 0) {
    return [];
  }

  const supabase = getSupabaseServiceRoleClient();
  const from = shiftIso(window.from, -CHILD_WINDOW_PADDING_MS);
  const to = shiftIso(window.to, CHILD_WINDOW_PADDING_MS);
  const rows: ValidatorIssueScanRow[] = [];

  for (let page = 0; page < MAX_SCAN_PAGES; page += 1) {
    const start = page * SCAN_PAGE_SIZE;
    // Only the issues array — validator `output` also carries the full validation blob.
    const { data, error } = await supabase
      .from('workflow_steps')
      .select('workflow_run_id,issues:output->issues')
      .eq('step_name', 'validator')
      .gte('started_at', from)
      .lte('started_at', to)
      .order('started_at', { ascending: true })
      .range(start, start + SCAN_PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message);
    }

    const batch = (data ?? []) as unknown as ValidatorIssueScanRow[];
    rows.push(...batch.filter((row) => runIds.has(row.workflow_run_id)));

    if (batch.length < SCAN_PAGE_SIZE) {
      break;
    }
  }

  return rows;
}

/**
 * Everything `PipelineStageStrip` renders, for one window and optional traffic
 * version (see `VersionFilter` in `~/lib/observability/aggregates.ts`).
 */
export async function getPipelineStageStripData(
  window: AggregateWindow,
  version?: VersionFilter,
): Promise<PipelineStageStripData> {
  const runs = await scanWorkflowRuns(window, version);
  const runIds = new Set(runs.map((run) => run.id));

  const [steps, toolEvents, validatorIssueRows, forcedToReviewCount] = await Promise.all([
    scanWorkflowSteps(window, runIds),
    scanToolEvents(window, runIds),
    scanValidatorIssueRows(window, runIds),
    countHumanReviewRuns(window, runIds),
  ]);

  return buildPipelineStageStripData({
    window,
    runs,
    steps,
    toolEvents,
    validatorIssueRows,
    forcedToReviewCount,
  });
}
