/**
 * B0-332 — shared contracts for the Prompt Observability admin feature (epic B0-330).
 *
 * Consumed by:
 *  - `~/lib/observability/timeline.ts`        (per-run trace timeline assembly)
 *  - `~/lib/observability/runs-repository.ts` (run list / filtering)
 *  - the observability admin UI + aggregate dashboard (B0-333…B0-336)
 *
 * Nothing here performs I/O; these are pure type declarations.
 */

import type { Json, Tables } from '~/types/supabase.public';

export type AuditLogRow = Tables<'audit_logs'>;

/* ------------------------------------------------------------------------- *
 * Run trace timeline
 * ------------------------------------------------------------------------- */

/**
 * Coarse status for a timeline event.
 *  - `ok`          — completed successfully / informational-and-fine.
 *  - `failed`      — the step, tool call, or gate rejected / errored.
 *  - `not_reached` — synthesized placeholder: the run died before this step ran,
 *                    so no `workflow_steps` row exists for it.
 *  - `running`     — a step row exists with no `completed_at` yet.
 */
export type TimelineEventStatus = 'ok' | 'failed' | 'not_reached' | 'running';

/**
 * The confidence-affecting gates in the product-support workflow
 * (`~/lib/workflows/product-support/run-product-support-workflow.ts`). Each one
 * surfaces as its own timeline event so a low confidence number is always
 * attributable rather than opaque.
 */
export type ConfidenceGateKind =
  /** Pre-flight policy decline (`step_name = 'early_decline_gate'`); pins confidence at 0.92. */
  | 'early_decline_gate'
  /** `useValidator === false` heuristic: 0.9 with sources, 0.6 without, issue `validator_bypassed_for_testing`. */
  | 'validator_bypass'
  /** The LLM validator's own approved/confidence/issues self-report (`validation_completed`). */
  | 'llm_validator'
  /**
   * Usage + safety evidence coverage cap at 0.55. Logged as
   * `usage_safety_coverage_cap_applied` since B0-367; runs predating that row are
   * reconstructed from the validator step output and flagged `inferred`.
   */
  | 'usage_safety_coverage_cap'
  /** B0-257 regulated-claim guardrail; hard clamp to 0.4 + forced human review. */
  | 'regulated_claim_guardrail'
  /** REC-4 recommendation-route calibration (`recommendation_gate_applied`). */
  | 'recommendation_gate';

type TimelineEventBase = {
  /** Stable across re-renders and re-fetches; derived from the source row id. */
  id: string;
  /** Short human-readable title for the timeline row. */
  label: string;
  /** ISO timestamp the event is anchored at; the sort key for the timeline. */
  at: string;
  /** Wall-clock duration where knowable (step span, tool-call duration). */
  durationMs?: number;
  status: TimelineEventStatus;
  /** Free-form payload for inline expansion in the UI (raw step/audit JSON). */
  detail: Record<string, unknown>;
  /**
   * True when the event was synthesized rather than read from a log row — since
   * B0-367 only historical usage/safety-coverage caps, which were applied without
   * an audit entry. UI should label these "inferred, no direct log entry".
   */
  inferred?: boolean;
};

/** Run-level start/finish markers. */
export type LifecycleTimelineEvent = TimelineEventBase & {
  kind: 'lifecycle';
  phase: 'workflow_started' | 'workflow_completed' | 'workflow_failed';
};

/** One `workflow_steps` row, or a synthesized `not_reached` placeholder after a failure. */
export type StepTimelineEvent = TimelineEventBase & {
  kind: 'step';
  /** Null for synthesized `not_reached` steps (no row exists). */
  stepId: string | null;
  stepName: string;
  /** The raw `workflow_steps.status` string, unmapped. */
  rawStatus: string | null;
  startedAt: string | null;
  completedAt: string | null;
  error: Json | null;
};

/**
 * One entry from the agent step's persisted `output.toolTrace` (B0-331), or — for
 * runs predating that field — an event `reconstructed` from the `tool_called` /
 * `tool_succeeded` / `tool_failed` audit rows (B0-417).
 */
export type ToolCallTimelineEvent = TimelineEventBase & {
  kind: 'tool_call';
  toolName: string;
  callId: string;
  /**
   * Truncated at write time (2000 / 4000 chars) by `~/lib/audit/trace`.
   * **Null on `reconstructed` events**: the previews only ever existed in
   * `toolTrace` and were never written to `audit_logs`, so they are unrecoverable
   * for pre-B0-331 runs. UI must render an explicit "not captured for this run"
   * state rather than an empty block.
   */
  argumentsPreview: string | null;
  outputPreview: string | null;
  /**
   * Null only on `reconstructed` events whose call never settled — a `tool_called`
   * audit row with no matching `tool_succeeded`/`tool_failed` row (process death
   * mid-call). Treat as unknown, NOT as a failure, so failure rates stay honest.
   */
  ok: boolean | null;
  /** The `workflow_steps` row the tool call was made from. */
  stepId: string | null;
  /**
   * B0-417 — true when the event was rebuilt from `audit_logs` because the step
   * carried no `output.toolTrace`. Name, timestamps, duration and ok/failed are
   * real (read from the audit rows); the previews are not recoverable.
   */
  reconstructed?: true;
  /**
   * B0-363 — failure cause as persisted on the `tool_failed` audit row
   * (`payload.error_message`). Null for successful calls and for failures logged
   * before B0-363 landed.
   */
  errorMessage: string | null;
  /**
   * B0-363 — bounded arguments preview from the `tool_failed` audit row
   * (`payload.arguments_preview`, 512 chars). Null for successes / pre-B0-363 rows.
   */
  auditArgumentsPreview: string | null;
};

/** A confidence-affecting gate decision. */
export type ConfidenceGateTimelineEvent = TimelineEventBase & {
  kind: 'confidence_gate';
  gate: ConfidenceGateKind;
  /** Confidence entering the gate, when recoverable. */
  confidenceBefore: number | null;
  /** Confidence the gate produced. */
  confidenceAfter: number | null;
  /** Hard ceiling the gate imposes (0.55, 0.4, …), or null when it only reports. */
  cap: number | null;
  approved: boolean | null;
  requiresHumanReview: boolean;
  issues: string[];
};

/** A human-review escalation (`review_requested`). */
export type ReviewTimelineEvent = TimelineEventBase & {
  kind: 'review';
  reason: string | null;
  issues: string[];
};

/** A notable audit-log event that isn't a step, tool call, gate, or lifecycle marker. */
export type AuditTimelineEvent = TimelineEventBase & {
  kind: 'audit';
  eventType: string;
};

export type TimelineEvent =
  | LifecycleTimelineEvent
  | StepTimelineEvent
  | ToolCallTimelineEvent
  | ConfidenceGateTimelineEvent
  | ReviewTimelineEvent
  | AuditTimelineEvent;

/* ------------------------------------------------------------------------- *
 * Run list
 * ------------------------------------------------------------------------- */

/** Derived (not a stored column): whether the run came from the golden-set harness. */
export type RunSource = 'live' | 'harness';

export type WorkflowRunListRow = {
  id: string;
  conversationId: string;
  workflowName: string;
  status: string;
  confidence: number | null;
  routingDecision: string | null;
  source: RunSource;
  createdAt: string;
  updatedAt: string;
  durationMs: number | null;
  /**
   * B0-428 / B0-429 — time to first assistant token ("Stream" column). Read from
   * `final_output.timingBreakdown.ttftMs`, falling back to the harness's own
   * `test_result_items.ttft_ms`. Recorded for every run since B0-429; null only when the run failed
   * before any token existed, or when it predates the instrumentation.
   */
  ttftMs: number | null;
  userMessagePreview: string | null;
};

export type ListWorkflowRunsFilters = {
  from?: string; // ISO, inclusive
  to?: string; // ISO, inclusive
  status?: string;
  routingDecision?: string;
  confidenceMin?: number;
  confidenceMax?: number;
  source?: RunSource;
  /**
   * B0-431 — free-text run search, applied server-side so it spans the whole
   * window rather than the current page. A full UUID matches the run id
   * exactly; anything else is a case-insensitive substring match on the prompt
   * (`user_input->>message`). Callers pass an already-normalized term.
   */
  search?: string;
  limit?: number;
  offset?: number;
};

/* ------------------------------------------------------------------------- *
 * Aggregate dashboard (B0-336 codes against this exact shape)
 * ------------------------------------------------------------------------- */

export type RoutingDistributionDatum = { routingDecision: string; count: number; avgConfidence: number | null };
export type ConfidenceBucketDatum = { bucket: 'high' | 'mid' | 'low' | 'none'; count: number };
export type LatencyByStepDatum = { stepName: string; avgDurationMs: number; p95DurationMs: number; sampleSize: number };
export type FailureRateByDayDatum = { day: string; total: number; failed: number; failureRate: number };

export type AggregateDashboardData = {
  windowFrom: string;
  windowTo: string;
  totalRuns: number;
  completedRuns: number;
  failedRuns: number;
  avgConfidence: number | null;
  humanReviewCount: number;
  /**
   * B0-371 — runs still in `running` whose age exceeds the sweeper's staleness
   * threshold (`DEFAULT_STALE_AFTER_MS`). These are orphaned records left by process
   * death, awaiting the sweeper; a non-zero value that does not clear means the
   * sweeper is not running.
   */
  orphanedRuns: number;
  /**
   * B0-430 — mean time to first assistant token across runs in the window, using the same
   * source precedence as the runs table's "Stream" column (`ttftMs` above). Null when no run
   * in the window recorded a first token; `ttftSampleSize` says how many did, so a partial
   * window (runs predating the B0-428/B0-429 instrumentation) is visible rather than silent.
   */
  avgTtftMs: number | null;
  ttftSampleSize: number;
  /**
   * B0-430 — mean wall-clock run duration (`updated_at - created_at`) over runs that have
   * *finished*. Runs still `running` are excluded: their `updated_at` is the last progress
   * write, not an end time. `durationSampleSize` is that finished-run count.
   */
  avgDurationMs: number | null;
  durationSampleSize: number;
  routingDistribution: RoutingDistributionDatum[];
  confidenceBuckets: ConfidenceBucketDatum[];
  latencyByStep: LatencyByStepDatum[];
  failureRateByDay: FailureRateByDayDatum[];
};
