/**
 * B0-332 — per-run trace timeline assembly (epic B0-330).
 *
 * `buildRunTimeline` is PURE: it takes already-fetched `workflow_runs`,
 * `workflow_steps` and `audit_logs` rows and returns an ordered
 * `TimelineEvent[]`. No I/O, no clock reads, so it is fully unit-testable
 * against fixture rows (see `timeline.test.ts`).
 *
 * Everything here is grounded in
 * `~/lib/workflows/product-support/run-product-support-workflow.ts`, which is the
 * only writer of these rows today. Step names it emits: `orchestration_planner`,
 * `early_decline_gate`, `openai_responses_agent`, `validator`.
 */

import { toolTraceSchema } from '~/lib/audit/trace';
import type { ToolTraceEntry } from '~/lib/audit/trace';
import type {
  WorkflowRunRow,
  WorkflowStepRow,
} from '~/lib/conversations/workflow-repository';
import { promptRecordSchema } from '~/lib/workflows/product-support/product-support-schemas';
import type { PromptRecord } from '~/lib/workflows/product-support/product-support-schemas';
import type {
  AuditLogRow,
  ConfidenceGateKind,
  TimelineEvent,
  TimelineEventStatus,
} from '~/types/observability';

/**
 * Confidence ceiling the workflow applies when a usage/safety question lacks usage
 * or safety evidence. Mirrors `USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP` in
 * `~/lib/workflows/product-support/run-product-support-workflow.ts` (duplicated so this
 * module stays pure) — change both together. Since B0-367 the workflow writes a
 * `usage_safety_coverage_cap_applied` row; older runs are still reconstructed by
 * `inferUsageSafetyCoverageGate`.
 */
export const USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP = 0.55;

/** B0-257 regulated-claim guardrail clamp (`Math.min(validation.confidence, 0.4)`). */
export const REGULATED_CLAIM_CONFIDENCE_CAP = 0.4;

/**
 * Happy-path step order. `early_decline_gate` is deliberately absent: it is an
 * alternative terminal branch, not a stage every run passes through, so it is
 * never projected as "not reached".
 */
const CANONICAL_STEP_SEQUENCE = [
  'orchestration_planner',
  'openai_responses_agent',
  'validator',
] as const;

const STEP_LABELS: Record<string, string> = {
  orchestration_planner: 'Orchestration planner (routing)',
  early_decline_gate: 'Early decline gate',
  openai_responses_agent: 'Agent generation (tool loop)',
  validator: 'Validator',
  /**
   * B0-389 — the revision pass got its own step (its own prompt, model and output). Like
   * `early_decline_gate` it is deliberately absent from `CANONICAL_STEP_SEQUENCE`: it only runs when
   * the validator disapproves, so it must never be projected as "not reached".
   */
  revision: 'Revision pass',
};

const GATE_LABELS: Record<ConfidenceGateKind, string> = {
  early_decline_gate: 'Early decline gate applied',
  validator_bypass: 'Validator bypassed (heuristic confidence)',
  llm_validator: 'LLM validator self-report',
  usage_safety_coverage_cap: `Usage/safety coverage cap (${USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP})`,
  regulated_claim_guardrail: `Regulated-claim guardrail clamp (${REGULATED_CLAIM_CONFIDENCE_CAP})`,
  recommendation_gate: 'Recommendation gate calibration',
};

/**
 * B0-368 — human-readable headline per `review_requested.payload.reason`. Keyed by
 * the closed set in `~/lib/workflows/product-support/run-product-support-workflow.ts`
 * (`REVIEW_REQUEST_REASONS`); an unknown reason falls back to the raw string rather
 * than being dropped.
 */
const REVIEW_REASON_LABELS: Record<string, string> = {
  regulated_claim_unverified: 'regulated claim unverified',
  revision_refused: 'revision pass refused to re-ground',
  validator_rejected: 'validator rejected the answer',
};

/* -------------------------------------------------------------------------- *
 * Small JSON readers (audit payloads and step input/output are `Json` columns)
 * -------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readBoolean(record: Record<string, unknown> | null, key: string): boolean | null {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : null;
}

function readStringArray(record: Record<string, unknown> | null, key: string): string[] {
  const value = record?.[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function diffMs(from: string | null, to: string | null): number | undefined {
  if (!from || !to) {
    return undefined;
  }
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return undefined;
  }
  // B0-551: `started_at` is Postgres `now()`, `completed_at` is the Node clock — clock skew can
  // make a genuinely fast step's delta go negative. Clamp at 0 rather than dropping the row
  // (returning undefined here would silently hide real fast-step data from duration views).
  const delta = end - start;
  return delta >= 0 ? delta : 0;
}

function mapStepStatus(rawStatus: string): TimelineEventStatus {
  if (rawStatus === 'failed') {
    return 'failed';
  }
  if (rawStatus === 'completed') {
    return 'ok';
  }
  return 'running';
}

/**
 * B0-389 — a step that was inserted but never called a model persists `{ skipped: true, reason }`
 * (today: the validator on the `useValidator === false` path). Say so in the label, so a bypassed
 * validator is never read as one that ran.
 */
function buildStepLabel(step: WorkflowStepRow): string {
  const base = STEP_LABELS[step.step_name] ?? step.step_name;
  const output = asRecord(step.output);
  if (readBoolean(output, 'skipped') !== true) {
    return base;
  }
  const reason = readString(output, 'reason');
  return reason ? `${base} — skipped (${reason})` : `${base} — skipped`;
}

/**
 * B0-463 — the persisted prompt for a step, or null. Reads `step.input.prompt` exactly as
 * `recordPrompt` wrote it (`{ stage, instructions, model, runtime }`); a step whose `input`
 * carries no `prompt` key (or an unparseable one, e.g. a pre-B0-389 row) is null rather than
 * throwing, since this file must still render malformed historical runs.
 */
function readStepPrompt(step: WorkflowStepRow): PromptRecord | null {
  const input = asRecord(step.input);
  if (!input || !('prompt' in input)) {
    return null;
  }
  const parsed = promptRecordSchema.safeParse(input.prompt);
  return parsed.success ? parsed.data : null;
}

/** Anything longer than this in a step `detail` is the agent's tool trace, surfaced separately. */
function buildStepDetail(step: WorkflowStepRow): Record<string, unknown> {
  const output = asRecord(step.output);
  if (!output || !('toolTrace' in output)) {
    return { input: step.input, output: step.output, error: step.error };
  }

  // Tool calls get their own timeline events, so keep only the count here.
  const { toolTrace, ...rest } = output;
  return {
    input: step.input,
    output: {
      ...rest,
      toolTraceCount: Array.isArray(toolTrace) ? toolTrace.length : 0,
    },
    error: step.error,
  };
}

/* -------------------------------------------------------------------------- *
 * Tool calls
 * -------------------------------------------------------------------------- */

type ToolCallAuditFacts = {
  calledAt: string | null;
  settledAt: string | null;
  /**
   * B0-417 — `payload.tool_name`, written on all three tool_* rows by
   * `writeAuditLog`'s audit context. This is what makes a legacy run's tool calls
   * nameable without a `toolTrace`.
   */
  toolName: string | null;
  /**
   * B0-417 — `true` after `tool_succeeded`, `false` after `tool_failed`, `null`
   * while the call is unsettled (a `tool_called` row with no matching outcome row).
   * Unsettled must NOT read as failed.
   */
  ok: boolean | null;
  /**
   * B0-417 — `payload.step_id`. In practice always null for tool_* rows: the tool
   * loop's audit context (`wfCtx` in `run-product-support-workflow.ts`) never sets
   * `stepId`. Read anyway so attribution is exact if that writer is ever fixed.
   */
  stepId: string | null;
  /** B0-363 — `tool_failed.payload.error_message`; null on successes / pre-B0-363 rows. */
  errorMessage: string | null;
  /** B0-363 — `tool_failed.payload.arguments_preview` (bounded at write time). */
  argumentsPreview: string | null;
};

/**
 * `tool_called` / `tool_succeeded` / `tool_failed` audit rows carry `call_id`,
 * which is the only way to recover real timestamps for a `toolTrace` entry
 * (the trace itself stores only a duration). B0-363 added the failure cause to
 * `tool_failed`, so the same index also carries the error message and the bounded
 * arguments preview. B0-417 additionally recovers `tool_name` and the ok/failed
 * outcome, which is everything needed to rebuild a tool-call event for a run whose
 * agent step predates `toolTrace`.
 *
 * `call_id` only ever appears on those three event types, so no other audit row can
 * leak into this index. Insertion order therefore follows the chronologically
 * sorted logs, i.e. real call order.
 */
function indexToolCallAuditFacts(auditLogs: AuditLogRow[]): Map<string, ToolCallAuditFacts> {
  const facts = new Map<string, ToolCallAuditFacts>();

  for (const log of auditLogs) {
    const payload = asRecord(log.payload);
    const callId = readString(payload, 'call_id');
    if (!callId) {
      continue;
    }

    const existing =
      facts.get(callId) ??
      {
        calledAt: null,
        settledAt: null,
        toolName: null,
        ok: null,
        stepId: null,
        errorMessage: null,
        argumentsPreview: null,
      };
    // Any of the three rows can supply the name / owning step; first non-null wins.
    existing.toolName = existing.toolName ?? readString(payload, 'tool_name');
    existing.stepId = existing.stepId ?? readString(payload, 'step_id');
    if (log.event_type === 'tool_called') {
      existing.calledAt = existing.calledAt ?? log.created_at;
    } else if (log.event_type === 'tool_succeeded' || log.event_type === 'tool_failed') {
      existing.settledAt = log.created_at;
      existing.ok = log.event_type === 'tool_succeeded';
    }
    if (log.event_type === 'tool_failed') {
      existing.errorMessage = readString(payload, 'error_message');
      existing.argumentsPreview = readString(payload, 'arguments_preview');
    }
    facts.set(callId, existing);
  }

  return facts;
}

/* -------------------------------------------------------------------------- *
 * B0-417 — tool-call reconstruction for runs with no persisted `toolTrace`
 * -------------------------------------------------------------------------- */

/**
 * The only step that runs a tool loop today: `executeTool` in
 * `~/lib/workflows/product-support/run-product-support-workflow.ts` is called
 * exclusively from the `openai_responses_agent` step. Reconstructed calls are
 * attributed here when the audit row carries no usable `step_id`.
 *
 * Attribution deliberately does NOT use `started_at`/`completed_at` containment:
 * `workflow_steps.started_at` is Postgres `now()` while `completed_at` comes from
 * the Node clock, so step windows are skewed by up to several seconds and ~23% of
 * real in-loop calls fall outside them.
 */
const TOOL_LOOP_STEP_NAME = 'openai_responses_agent';

type ReconstructedToolCall = ToolCallAuditFacts & { callId: string };

/**
 * Audit-derived tool calls that are NOT already covered by a `toolTrace`.
 *
 * `tracedCallIds` is collected across every step, so a run that persisted its trace
 * reconstructs nothing at all and is left byte-for-byte unchanged.
 */
function collectReconstructableToolCalls(
  toolCallFacts: Map<string, ToolCallAuditFacts>,
  tracedCallIds: ReadonlySet<string>,
): ReconstructedToolCall[] {
  const calls: ReconstructedToolCall[] = [];
  for (const [callId, facts] of toolCallFacts) {
    if (!tracedCallIds.has(callId)) {
      calls.push({ callId, ...facts });
    }
  }
  return calls;
}

/**
 * Assign each reconstructable call to the step it was made from. Every call is
 * placed exactly once: never dropped, never duplicated. Calls with no host step to
 * hang off (a run whose agent step row is missing entirely) come back as
 * `unattributed` and are still rendered, with a null `stepId`.
 */
function attributeReconstructedToolCalls(
  calls: ReconstructedToolCall[],
  candidateSteps: WorkflowStepRow[],
): { byStepId: Map<string, ReconstructedToolCall[]>; unattributed: ReconstructedToolCall[] } {
  const byStepId = new Map<string, ReconstructedToolCall[]>();
  const unattributed: ReconstructedToolCall[] = [];

  const candidatesById = new Map(candidateSteps.map((step) => [step.id, step]));
  // Ordered by `started_at` already (callers pass `orderedSteps`-derived lists).
  const toolLoopSteps = candidateSteps.filter(
    (step) => step.step_name === TOOL_LOOP_STEP_NAME,
  );

  const assign = (stepId: string, call: ReconstructedToolCall) => {
    const bucket = byStepId.get(stepId);
    if (bucket) {
      bucket.push(call);
    } else {
      byStepId.set(stepId, [call]);
    }
  };

  for (const call of calls) {
    // 1. An explicit, resolvable `step_id` on the audit row always wins.
    if (call.stepId && candidatesById.has(call.stepId)) {
      assign(call.stepId, call);
      continue;
    }

    // 2. Otherwise the tool-loop step. With more than one (never observed), pick the
    //    last one that had already started when the call was made.
    if (toolLoopSteps.length > 0) {
      const calledAt = call.calledAt;
      const startedFirst = calledAt
        ? [...toolLoopSteps]
            .reverse()
            .find((step) => Date.parse(step.started_at) <= Date.parse(calledAt))
        : undefined;
      assign((startedFirst ?? toolLoopSteps[0]).id, call);
      continue;
    }

    // 3. Nothing to attribute it to — surface it rather than dropping it.
    unattributed.push(call);
  }

  return { byStepId, unattributed };
}

/** Shared "the previews are gone" explanation, so UI and export read identically. */
const RECONSTRUCTED_PREVIEW_NOTE =
  'Arguments and output previews were not captured for this run. They only ever existed on the agent step\'s persisted toolTrace (added by B0-331); audit_logs never carried them.';

/**
 * Build the timeline event for one audit-reconstructed tool call. Name, timing,
 * duration and outcome are real; the previews are explicitly null.
 */
function buildReconstructedToolCallEvent(input: {
  call: ReconstructedToolCall;
  index: number;
  stepId: string | null;
  /** Anchor for calls whose `tool_called` row is missing (mirrors the traced path). */
  fallbackAt: string;
}): TimelineEvent {
  const { call, index, stepId, fallbackAt } = input;
  const toolName = call.toolName ?? 'unknown_tool';
  const status: TimelineEventStatus =
    call.ok === true ? 'ok' : call.ok === false ? 'failed' : 'running';

  return {
    kind: 'tool_call',
    id: `tool:audit:${stepId ?? 'unattributed'}:${call.callId}:${index}`,
    stepId,
    toolName,
    callId: call.callId,
    // Unrecoverable by design — the renderer shows "not captured for this run".
    argumentsPreview: null,
    outputPreview: null,
    // B0-390 fields, all unknown on a reconstructed call: `audit_logs` never carried the
    // origin, and with no preview persisted there is nothing that could have been cut.
    // Null (not false) so the UI says "unknown" rather than asserting "not truncated".
    origin: null,
    argumentsTruncated: null,
    outputTruncated: null,
    ok: call.ok,
    errorMessage: call.errorMessage,
    auditArgumentsPreview: call.argumentsPreview,
    label: `Tool: ${toolName}`,
    at: call.calledAt ?? fallbackAt,
    durationMs: diffMs(call.calledAt, call.settledAt),
    status,
    reconstructed: true,
    detail: {
      reconstructedFrom: 'audit_logs tool_called / tool_succeeded / tool_failed rows',
      note: RECONSTRUCTED_PREVIEW_NOTE,
      ok: call.ok,
      calledAt: call.calledAt,
      settledAt: call.settledAt,
      ...(call.ok === null
        ? { unsettled: 'No tool_succeeded / tool_failed row was written for this call.' }
        : {}),
      ...(stepId === null
        ? {
            unattributed:
              'No tool-loop step row exists for this run, so the call could not be attributed to a step.',
          }
        : {}),
      ...(call.errorMessage ? { errorMessage: call.errorMessage } : {}),
      ...(call.argumentsPreview ? { auditArgumentsPreview: call.argumentsPreview } : {}),
    },
  };
}

/**
 * Reads the agent step's persisted `output.toolTrace` (added by B0-331). Legacy
 * rows only persisted `{ responseIds, toolCalls }`; those degrade to no
 * tool-call events rather than throwing.
 */
function readToolTrace(step: WorkflowStepRow): ToolTraceEntry[] {
  const output = asRecord(step.output);
  if (!output || !('toolTrace' in output)) {
    return [];
  }
  const parsed = toolTraceSchema.safeParse(output.toolTrace);
  return parsed.success ? parsed.data : [];
}

/* -------------------------------------------------------------------------- *
 * Timeline assembly
 * -------------------------------------------------------------------------- */

type PendingEvent = { event: TimelineEvent; at: string };

export function buildRunTimeline(
  run: WorkflowRunRow,
  steps: WorkflowStepRow[],
  auditLogs: AuditLogRow[],
): TimelineEvent[] {
  const pending: PendingEvent[] = [];
  const push = (event: TimelineEvent) => pending.push({ event, at: event.at });

  const orderedSteps = [...steps].sort(
    (a, b) => Date.parse(a.started_at) - Date.parse(b.started_at),
  );
  const orderedLogs = [...auditLogs].sort(
    (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at),
  );
  const toolCallFacts = indexToolCallAuditFacts(orderedLogs);
  const logsByType = (eventType: string) =>
    orderedLogs.filter((log) => log.event_type === eventType);

  /* --- B0-417: tool-call reconstruction for pre-`toolTrace` runs ---------- *
   * Only ~3% of `openai_responses_agent` rows carry `output.toolTrace`; the rest
   * used to render zero tool calls, silently. Rebuild those from the audit rows.
   * Steps that DO have a trace keep the authoritative path below untouched, and
   * their call ids are excluded here so nothing is ever emitted twice.
   */
  const tracesByStepId = new Map(
    orderedSteps.map((step) => [step.id, readToolTrace(step)] as const),
  );
  const tracedCallIds = new Set<string>();
  const untracedSteps: WorkflowStepRow[] = [];
  for (const step of orderedSteps) {
    const trace = tracesByStepId.get(step.id) ?? [];
    if (trace.length > 0) {
      for (const entry of trace) {
        tracedCallIds.add(entry.callId);
      }
    } else {
      untracedSteps.push(step);
    }
  }
  const { byStepId: reconstructedByStepId, unattributed: unattributedToolCalls } =
    attributeReconstructedToolCalls(
      collectReconstructableToolCalls(toolCallFacts, tracedCallIds),
      untracedSteps,
    );

  /* --- run start -------------------------------------------------------- *
   * NOTE: the workflow writes its `workflow_started` audit row with a null
   * workflow_run_id (the run doesn't exist yet), so `listAuditLogsForRun` never
   * returns it. The start marker is therefore anchored on `run.created_at`.
   */
  const startedLog = logsByType('workflow_started')[0];
  push({
    kind: 'lifecycle',
    phase: 'workflow_started',
    id: startedLog ? `audit:${startedLog.id}` : `run:${run.id}:started`,
    label: `Workflow started — ${run.workflow_name}`,
    at: startedLog?.created_at ?? run.created_at,
    status: 'ok',
    detail: {
      workflowName: run.workflow_name,
      conversationId: run.conversation_id,
      userInput: run.user_input,
      ...(startedLog ? { auditPayload: startedLog.payload } : {}),
    },
  });

  /* --- steps + their tool calls ----------------------------------------- */
  for (const step of orderedSteps) {
    push({
      kind: 'step',
      id: `step:${step.id}`,
      stepId: step.id,
      stepName: step.step_name,
      rawStatus: step.status,
      label: buildStepLabel(step),
      at: step.started_at,
      startedAt: step.started_at,
      completedAt: step.completed_at,
      durationMs: diffMs(step.started_at, step.completed_at),
      status: mapStepStatus(step.status),
      detail: buildStepDetail(step),
      error: step.error,
      prompt: readStepPrompt(step),
    });

    // B0-417 — a step has EITHER its authoritative trace or reconstructed events,
    // never both: `tracedCallIds` excluded these call ids from reconstruction.
    for (const [index, call] of (reconstructedByStepId.get(step.id) ?? []).entries()) {
      push(
        buildReconstructedToolCallEvent({
          call,
          index,
          stepId: step.id,
          // Forced tool calls (e.g. the cross-reference safety-net search) bypass
          // writeAuditLog's `tool_called`, so fall back to the step's own start time.
          fallbackAt: step.started_at,
        }),
      );
    }

    for (const [index, entry] of (tracesByStepId.get(step.id) ?? []).entries()) {
      const facts = toolCallFacts.get(entry.callId);
      push({
        kind: 'tool_call',
        id: `tool:${step.id}:${entry.callId}:${index}`,
        stepId: step.id,
        toolName: entry.toolName,
        callId: entry.callId,
        argumentsPreview: entry.argumentsPreview,
        outputPreview: entry.outputPreview,
        ok: entry.ok,
        // B0-363 — diagnostics persisted on the `tool_failed` audit row.
        errorMessage: facts?.errorMessage ?? null,
        auditArgumentsPreview: facts?.argumentsPreview ?? null,
        // B0-390 — attribution + truncation flags; null on rows written before they existed.
        origin: entry.origin ?? null,
        argumentsTruncated: entry.argumentsTruncated ?? null,
        outputTruncated: entry.outputTruncated ?? null,
        label: `Tool: ${entry.toolName}`,
        // Forced tool calls (e.g. the cross-reference safety-net search) bypass
        // writeAuditLog, so fall back to the step's own start time.
        at: facts?.calledAt ?? step.started_at,
        durationMs: entry.durationMs ?? diffMs(facts?.calledAt ?? null, facts?.settledAt ?? null),
        status: entry.ok ? 'ok' : 'failed',
        detail: {
          argumentsPreview: entry.argumentsPreview,
          outputPreview: entry.outputPreview,
          ok: entry.ok,
          ...(entry.origin ? { origin: entry.origin } : {}),
          ...(entry.argumentsTruncated === undefined
            ? {}
            : { argumentsTruncated: entry.argumentsTruncated }),
          ...(entry.outputTruncated === undefined
            ? {}
            : { outputTruncated: entry.outputTruncated }),
          ...(facts?.errorMessage ? { errorMessage: facts.errorMessage } : {}),
          ...(facts?.argumentsPreview
            ? { auditArgumentsPreview: facts.argumentsPreview }
            : {}),
        },
      });
    }
  }

  /* --- B0-417: reconstructed calls with no host step --------------------- *
   * Never observed in practice (every run with tool audit rows has an agent step),
   * but a run whose step row is missing must still show its tool calls rather than
   * losing them.
   */
  for (const [index, call] of unattributedToolCalls.entries()) {
    push(
      buildReconstructedToolCallEvent({
        call,
        index,
        stepId: null,
        fallbackAt: run.created_at,
      }),
    );
  }

  /* --- gate 1: early decline -------------------------------------------- */
  const earlyDeclineStep = orderedSteps.find(
    (step) => step.step_name === 'early_decline_gate',
  );
  if (earlyDeclineStep) {
    const output = asRecord(earlyDeclineStep.output);
    const input = asRecord(earlyDeclineStep.input);
    const reason = readString(output, 'reason') ?? readString(input, 'reason');
    push({
      kind: 'confidence_gate',
      gate: 'early_decline_gate',
      id: `gate:early_decline:${earlyDeclineStep.id}`,
      label: GATE_LABELS.early_decline_gate,
      at: earlyDeclineStep.completed_at ?? earlyDeclineStep.started_at,
      status: 'ok',
      confidenceBefore: null,
      confidenceAfter: run.confidence,
      cap: null,
      approved: true,
      requiresHumanReview: false,
      issues: reason ? [reason] : [],
      detail: { reason, stepOutput: earlyDeclineStep.output },
    });
  }

  /* --- gates 2 & 3: validator self-report / bypass heuristic ------------- */
  const validatorStep = orderedSteps.find((step) => step.step_name === 'validator');
  const validationLogs = logsByType('validation_completed');

  for (const [index, log] of validationLogs.entries()) {
    const payload = asRecord(log.payload);
    const issues = readStringArray(payload, 'issues');
    const bypassed = issues.includes('validator_bypassed_for_testing');
    const pass = readString(payload, 'pass');
    const gate: ConfidenceGateKind = bypassed ? 'validator_bypass' : 'llm_validator';
    const approved = readBoolean(payload, 'approved');
    push({
      kind: 'confidence_gate',
      gate,
      id: `gate:${gate}:${log.id}`,
      label: pass ? `${GATE_LABELS[gate]} (${pass} pass)` : GATE_LABELS[gate],
      at: log.created_at,
      status: approved === false ? 'failed' : 'ok',
      // The first validator pass is the entry point for confidence; nothing precedes it.
      confidenceBefore: index === 0 ? null : readNumber(asRecord(validationLogs[index - 1]?.payload), 'confidence'),
      confidenceAfter: readNumber(payload, 'confidence'),
      cap: null,
      approved,
      requiresHumanReview: readBoolean(payload, 'requires_human_review') === true,
      issues,
      detail: { auditPayload: log.payload },
    });
  }

  /* --- gate 4: usage/safety coverage cap --------------------------------- *
   * B0-367 added a real `usage_safety_coverage_cap_applied` audit row. Prefer it;
   * fall back to the inference only for runs that predate it (which must keep
   * rendering, with the "inferred" badge).
   */
  const coverageCapLogs = logsByType('usage_safety_coverage_cap_applied');
  if (coverageCapLogs.length > 0) {
    for (const log of coverageCapLogs) {
      push(buildUsageSafetyCoverageGateFromLog(log, validatorStep));
    }
  } else {
    const inferredCap = inferUsageSafetyCoverageGate({
      validatorStep,
      validationLogs,
    });
    if (inferredCap) {
      push(inferredCap);
    }
  }

  /* --- gate 5: regulated-claim guardrail -------------------------------- */
  for (const log of logsByType('regulated_claim_guardrail_rejected')) {
    const payload = asRecord(log.payload);
    const ungrounded = readStringArray(payload, 'ungroundedCategories');
    push({
      kind: 'confidence_gate',
      gate: 'regulated_claim_guardrail',
      id: `gate:regulated_claim_guardrail:${log.id}`,
      label: GATE_LABELS.regulated_claim_guardrail,
      at: log.created_at,
      status: 'failed',
      confidenceBefore: null,
      confidenceAfter: null,
      cap: REGULATED_CLAIM_CONFIDENCE_CAP,
      approved: false,
      requiresHumanReview: true,
      issues: ungrounded.map((category) => `regulated_claim_unverified:${category}`),
      detail: { auditPayload: log.payload },
    });
  }

  /* --- gate 6: recommendation-gate calibration -------------------------- */
  for (const log of logsByType('recommendation_gate_applied')) {
    const payload = asRecord(log.payload);
    push({
      kind: 'confidence_gate',
      gate: 'recommendation_gate',
      id: `gate:recommendation_gate:${log.id}`,
      label: GATE_LABELS.recommendation_gate,
      at: log.created_at,
      status: readBoolean(payload, 'approved') === false ? 'failed' : 'ok',
      confidenceBefore: null,
      confidenceAfter: readNumber(payload, 'confidence'),
      cap: null,
      approved: readBoolean(payload, 'approved'),
      requiresHumanReview: readBoolean(payload, 'requires_human_review') === true,
      issues: readStringArray(payload, 'issues'),
      detail: { auditPayload: log.payload, topSimilarity: readNumber(payload, 'topSimilarity') },
    });
  }

  /* --- revision refusal + human review ---------------------------------- */
  for (const log of logsByType('revision_skipped_refusal')) {
    push({
      kind: 'audit',
      eventType: log.event_type,
      id: `audit:${log.id}`,
      label: 'Revision pass skipped (model refused to re-ground)',
      at: log.created_at,
      status: 'failed',
      detail: { auditPayload: log.payload },
    });
  }

  for (const log of logsByType('review_requested')) {
    const payload = asRecord(log.payload);
    const reason = readString(payload, 'reason');
    push({
      kind: 'review',
      id: `review:${log.id}`,
      // B0-368 — the triage discriminator IS the headline. Rows written before
      // B0-368 have no reason and keep the bare label.
      label: reason
        ? `Human review requested — ${REVIEW_REASON_LABELS[reason] ?? reason}`
        : 'Human review requested',
      at: log.created_at,
      status: 'failed',
      reason,
      issues: readStringArray(payload, 'issues'),
      detail: { auditPayload: log.payload },
    });
  }

  /* --- not-reached projection for failed runs ---------------------------- */
  for (const notReached of projectNotReachedSteps(run, orderedSteps)) {
    push(notReached);
  }

  /* --- run finish -------------------------------------------------------- */
  const completedLog = logsByType('workflow_completed')[0];
  const failedLog = logsByType('workflow_failed')[0];
  if (failedLog || run.status === 'failed') {
    push({
      kind: 'lifecycle',
      phase: 'workflow_failed',
      id: failedLog ? `audit:${failedLog.id}` : `run:${run.id}:failed`,
      label: 'Workflow failed',
      at: failedLog?.created_at ?? run.updated_at,
      status: 'failed',
      detail: {
        finalOutput: run.final_output,
        ...(failedLog ? { auditPayload: failedLog.payload } : {}),
      },
    });
  } else if (completedLog || run.status === 'completed') {
    push({
      kind: 'lifecycle',
      phase: 'workflow_completed',
      id: completedLog ? `audit:${completedLog.id}` : `run:${run.id}:completed`,
      label: 'Workflow completed',
      at: completedLog?.created_at ?? run.updated_at,
      status: 'ok',
      durationMs: diffMs(run.created_at, run.updated_at) ?? undefined,
      detail: {
        confidence: run.confidence,
        finalOutput: run.final_output,
        ...(completedLog ? { auditPayload: completedLog.payload } : {}),
      },
    });
  }

  // Chronological. `Array.prototype.sort` is stable, so events sharing a
  // timestamp keep the construction order above (steps → gates → lifecycle),
  // which is the order the workflow actually executes them in.
  return pending
    .map((item, index) => ({ ...item, index }))
    .sort((a, b) => {
      const delta = Date.parse(a.at) - Date.parse(b.at);
      if (delta !== 0 && Number.isFinite(delta)) {
        return delta;
      }
      return a.index - b.index;
    })
    .map((item) => item.event);
}

/**
 * B0-399 — degraded/empty-state flags for the run trace page, derived once from the same inputs
 * as `buildRunTimeline`. Kept as a companion function rather than folded into `buildRunTimeline`'s
 * return value so every caller that already depends on `TimelineEvent[]` (this file's own test
 * suite included) is unaffected.
 */
export type RunEmptyState = {
  /**
   * State #1 — "Not captured — this run predates prompt capture." True when zero
   * `workflow_steps` rows exist for the run at all. Distinct from a `ToolCallTimelineEvent`'s
   * `reconstructed` flag, which only means a run's tool-call *previews* are missing — that run
   * still has real steps. `buildRunTimeline` always emits at least a synthesized
   * `workflow_started` lifecycle event, so `timeline.length === 0` is never a usable check here;
   * this looks at the underlying `workflow_steps` rows instead.
   */
  predatesCapture: boolean;
  /**
   * State #3 — "Run failed before completing. Partial timeline below." Mirrors
   * `run.status === 'failed'`; exposed here so the page/component don't need to reach back into
   * the run row just to decide whether to show the banner. The partial-timeline data itself
   * (not-reached steps, the `workflow_failed` marker) is already produced by `buildRunTimeline` —
   * this flag only gates the explanatory banner text.
   */
  runFailed: boolean;
  /**
   * State #4 — "No model call — answer produced by the decline gate." True when the timeline
   * carries an `early_decline_gate` confidence-gate event and no `openai_responses_agent` step
   * ran, i.e. the decline gate produced the final answer without any model call.
   */
  declinedWithoutModelCall: boolean;
};

/** Everything the run trace page needs to pick which of the four B0-399 empty-state banners (if any) to render. */
export function deriveRunEmptyState(
  run: WorkflowRunRow,
  steps: WorkflowStepRow[],
  timeline: TimelineEvent[],
): RunEmptyState {
  const hasAgentStep = steps.some((step) => step.step_name === TOOL_LOOP_STEP_NAME);
  const hasEarlyDeclineGateEvent = timeline.some(
    (event) => event.kind === 'confidence_gate' && event.gate === 'early_decline_gate',
  );

  return {
    predatesCapture: steps.length === 0,
    runFailed: run.status === 'failed',
    declinedWithoutModelCall: hasEarlyDeclineGateEvent && !hasAgentStep,
  };
}

/**
 * B0-367 — the usage/safety-coverage cap as logged by the workflow. Payload:
 * `{ missingEvidence, confidenceBefore, confidenceAfter, cap, issues,
 * requires_human_review }`. Not `inferred`: this is a real row.
 */
function buildUsageSafetyCoverageGateFromLog(
  log: AuditLogRow,
  validatorStep: WorkflowStepRow | undefined,
): TimelineEvent {
  const payload = asRecord(log.payload);
  const confidenceBefore = readNumber(payload, 'confidenceBefore');
  const cap = readNumber(payload, 'cap') ?? USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP;
  const confidenceAfter =
    readNumber(payload, 'confidenceAfter') ??
    (confidenceBefore === null ? cap : Math.min(confidenceBefore, cap));

  return {
    kind: 'confidence_gate',
    gate: 'usage_safety_coverage_cap',
    id: `gate:usage_safety_coverage_cap:${log.id}`,
    label: GATE_LABELS.usage_safety_coverage_cap,
    at: log.created_at,
    status: 'failed',
    confidenceBefore,
    confidenceAfter,
    cap,
    approved: false,
    requiresHumanReview: readBoolean(payload, 'requires_human_review') === true,
    issues: readStringArray(payload, 'issues'),
    detail: {
      auditPayload: log.payload,
      missingEvidence: readStringArray(payload, 'missingEvidence'),
      // Kept for continuity with the inferred path, which read the step output.
      finalValidatorIssues: readStringArray(asRecord(validatorStep?.output ?? null), 'issues'),
    },
  };
}

/**
 * Historical runs only (pre-B0-367). The usage/safety-coverage cap (0.55) used to be
 * the one confidence gate with NO dedicated audit event: the workflow mutates
 * `validation` in place between the `validation_completed` audit write and
 * `completeWorkflowStep(validationStep)`.
 *
 * We therefore synthesize it by diffing the validator pass as logged against the
 * validator step's persisted output: an `insufficient_*_evidence` issue that
 * appears only in the final output is the cap's fingerprint. The resulting event
 * is flagged `inferred: true`.
 */
function inferUsageSafetyCoverageGate(input: {
  validatorStep: WorkflowStepRow | undefined;
  validationLogs: AuditLogRow[];
}): TimelineEvent | null {
  const { validatorStep, validationLogs } = input;
  if (!validatorStep) {
    return null;
  }

  const finalOutput = asRecord(validatorStep.output);
  const finalIssues = readStringArray(finalOutput, 'issues');
  const insufficientIssues = finalIssues.filter((issue) =>
    /^insufficient_[a-z_]*evidence$/.test(issue),
  );
  if (insufficientIssues.length === 0) {
    return null;
  }

  // Use the LAST logged validator pass: after a revision the second pass is the
  // state the cap actually clamped.
  const baseLog = validationLogs.length > 0 ? validationLogs[validationLogs.length - 1] : null;
  const basePayload = asRecord(baseLog?.payload ?? null);
  const baseIssues = readStringArray(basePayload, 'issues');
  const newIssues = insufficientIssues.filter((issue) => !baseIssues.includes(issue));
  if (newIssues.length === 0) {
    return null;
  }

  const confidenceBefore = readNumber(basePayload, 'confidence');
  const confidenceAfter =
    confidenceBefore === null
      ? USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP
      : Math.min(confidenceBefore, USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP);

  const missingEvidence = newIssues
    .flatMap((issue) => issue.replace(/^insufficient_/, '').replace(/_evidence$/, '').split('_and_'))
    .filter((token) => token === 'usage' || token === 'safety');

  return {
    kind: 'confidence_gate',
    gate: 'usage_safety_coverage_cap',
    id: `gate:usage_safety_coverage_cap:${validatorStep.id}`,
    label: GATE_LABELS.usage_safety_coverage_cap,
    at: baseLog?.created_at ?? validatorStep.completed_at ?? validatorStep.started_at,
    status: 'failed',
    confidenceBefore,
    confidenceAfter,
    cap: USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP,
    approved: false,
    requiresHumanReview: readBoolean(finalOutput, 'requires_human_review') === true,
    issues: newIssues,
    inferred: true,
    detail: {
      inferredFrom: 'diff of logged validator pass vs. persisted validator step output',
      note: 'This gate writes no audit log entry; the event is inferred.',
      missingEvidence: [...new Set(missingEvidence)],
      loggedValidatorIssues: baseIssues,
      finalValidatorIssues: finalIssues,
    },
  };
}

/**
 * After a failure, the remaining canonical steps have no `workflow_steps` row at
 * all (the workflow throws before inserting them). Emit them as `not_reached`
 * placeholders so the UI can grey them out instead of silently ending the trace.
 */
function projectNotReachedSteps(
  run: WorkflowRunRow,
  orderedSteps: WorkflowStepRow[],
): TimelineEvent[] {
  if (run.status !== 'failed') {
    return [];
  }

  const failingStep =
    orderedSteps.find((step) => step.status === 'failed') ??
    orderedSteps[orderedSteps.length - 1];
  if (!failingStep) {
    return [];
  }

  const boundary = CANONICAL_STEP_SEQUENCE.indexOf(
    failingStep.step_name as (typeof CANONICAL_STEP_SEQUENCE)[number],
  );
  if (boundary < 0) {
    return [];
  }

  const present = new Set(orderedSteps.map((step) => step.step_name));
  const at = failingStep.completed_at ?? run.updated_at;

  return CANONICAL_STEP_SEQUENCE.slice(boundary + 1)
    .filter((stepName) => !present.has(stepName))
    .map((stepName) => ({
      kind: 'step' as const,
      id: `step:${run.id}:not_reached:${stepName}`,
      stepId: null,
      stepName,
      rawStatus: null,
      label: STEP_LABELS[stepName] ?? stepName,
      at,
      startedAt: null,
      completedAt: null,
      status: 'not_reached' as const,
      error: null,
      prompt: null,
      detail: {
        note: `Not reached — the run failed at "${failingStep.step_name}".`,
        failedAtStepName: failingStep.step_name,
      },
    }));
}
