import { describe, expect, it } from 'vitest';

import type { ToolTraceEntry } from '~/lib/audit/trace';
import type {
  WorkflowRunRow,
  WorkflowStepRow,
} from '~/lib/conversations/workflow-repository';
import {
  USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP,
  buildRunTimeline,
} from '~/lib/observability/timeline';
import type {
  AuditLogRow,
  ConfidenceGateTimelineEvent,
  StepTimelineEvent,
  TimelineEvent,
} from '~/types/observability';

/* -------------------------------------------------------------------------- *
 * Fixture helpers — plain typed rows, no DB and no Supabase mocking needed
 * because buildRunTimeline is pure.
 * -------------------------------------------------------------------------- */

const BASE = Date.parse('2026-08-01T12:00:00.000Z');
const at = (offsetMs: number) => new Date(BASE + offsetMs).toISOString();

const RUN_ID = 'run-1';
const CONVERSATION_ID = 'conv-1';

function makeRun(overrides: Partial<WorkflowRunRow> = {}): WorkflowRunRow {
  return {
    id: RUN_ID,
    conversation_id: CONVERSATION_ID,
    workflow_name: 'product-support',
    status: 'completed',
    confidence: 0.9,
    user_input: { message: 'How do I dilute Betco pH7Q Dual?', modelTag: 'preview' },
    final_output: { routingDecision: 'product', confidence: 0.9 },
    created_at: at(0),
    updated_at: at(90),
    ...overrides,
  };
}

function makeStep(overrides: Partial<WorkflowStepRow> & { id: string; step_name: string }): WorkflowStepRow {
  return {
    workflow_run_id: RUN_ID,
    status: 'completed',
    input: null,
    output: null,
    error: null,
    started_at: at(0),
    completed_at: null,
    ...overrides,
  };
}

function makeLog(overrides: Partial<AuditLogRow> & { id: string; event_type: string }): AuditLogRow {
  return {
    conversation_id: CONVERSATION_ID,
    workflow_run_id: RUN_ID,
    payload: {},
    created_at: at(0),
    ...overrides,
  };
}

function toolTraceEntry(overrides: Partial<ToolTraceEntry> = {}): ToolTraceEntry {
  return {
    toolName: 'search_product_docs',
    callId: 'call-1',
    argumentsPreview: '{"productName":"pH7Q Dual"}',
    outputPreview: '{"sources":[]}',
    ok: true,
    durationMs: 120,
    ...overrides,
  };
}

const plannerStep = makeStep({
  id: 'step-planner',
  step_name: 'orchestration_planner',
  input: { message: 'How do I dilute Betco pH7Q Dual?' },
  output: { routing: { decision: 'product', scores: { product: 3 }, rationale: 'product signals' } },
  started_at: at(10),
  completed_at: at(10),
});

function kinds(timeline: TimelineEvent[]) {
  return timeline.map((event) => event.kind);
}

function gates(timeline: TimelineEvent[]): ConfidenceGateTimelineEvent[] {
  return timeline.filter(
    (event): event is ConfidenceGateTimelineEvent => event.kind === 'confidence_gate',
  );
}

function steps(timeline: TimelineEvent[]): StepTimelineEvent[] {
  return timeline.filter((event): event is StepTimelineEvent => event.kind === 'step');
}

/* -------------------------------------------------------------------------- *
 * Scenario 1 — normal run (validator bypassed, one tool call)
 * -------------------------------------------------------------------------- */

function normalRunFixture() {
  const run = makeRun();
  const stepRows: WorkflowStepRow[] = [
    plannerStep,
    makeStep({
      id: 'step-agent',
      step_name: 'openai_responses_agent',
      started_at: at(20),
      completed_at: at(60),
      input: { model: 'gpt-5', hasPreviousResponse: false },
      output: {
        responseIds: ['resp_1'],
        toolCalls: 1,
        toolTrace: [toolTraceEntry()],
      },
    }),
    makeStep({
      id: 'step-validator',
      step_name: 'validator',
      started_at: at(70),
      completed_at: at(85),
      output: {
        approved: true,
        confidence: 0.9,
        issues: ['validator_bypassed_for_testing'],
        requires_human_review: false,
        skipped: true,
        reason: 'temporary_test_bypass',
      },
    }),
  ];
  const logs: AuditLogRow[] = [
    makeLog({ id: 'log-step-started', event_type: 'step_started', created_at: at(10), payload: { step: 'orchestration_planner', step_id: 'step-planner' } }),
    makeLog({ id: 'log-resp', event_type: 'openai_response_requested', created_at: at(20), payload: { step: 'agent', step_id: 'step-agent' } }),
    makeLog({ id: 'log-tool-called', event_type: 'tool_called', created_at: at(30), payload: { tool_name: 'search_product_docs', call_id: 'call-1' } }),
    makeLog({ id: 'log-tool-ok', event_type: 'tool_succeeded', created_at: at(45), payload: { tool_name: 'search_product_docs', call_id: 'call-1' } }),
    makeLog({
      id: 'log-validation',
      event_type: 'validation_completed',
      created_at: at(80),
      payload: {
        approved: true,
        confidence: 0.9,
        issues: ['validator_bypassed_for_testing'],
        requires_human_review: false,
      },
    }),
    makeLog({ id: 'log-completed', event_type: 'workflow_completed', created_at: at(90), payload: { workflow_run_id: RUN_ID } }),
  ];
  return { run, stepRows, logs };
}

describe('buildRunTimeline — normal run', () => {
  const { run, stepRows, logs } = normalRunFixture();
  const timeline = buildRunTimeline(run, stepRows, logs);

  it('orders events chronologically, interleaving the tool call inside the agent step', () => {
    expect(kinds(timeline)).toEqual([
      'lifecycle',
      'step',
      'step',
      'tool_call',
      'step',
      'confidence_gate',
      'lifecycle',
    ]);
    const timestamps = timeline.map((event) => Date.parse(event.at));
    expect([...timestamps].sort((a, b) => a - b)).toEqual(timestamps);
  });

  it('opens with a synthesized workflow_started anchored on run.created_at', () => {
    // The workflow writes its workflow_started audit row with a null
    // workflow_run_id, so it is never returned by listAuditLogsForRun.
    const first = timeline[0];
    expect(first).toMatchObject({
      kind: 'lifecycle',
      phase: 'workflow_started',
      id: `run:${RUN_ID}:started`,
      at: run.created_at,
      status: 'ok',
    });
  });

  it('carries step names, durations and statuses', () => {
    expect(
      steps(timeline).map((event) => [event.stepName, event.status, event.durationMs]),
    ).toEqual([
      ['orchestration_planner', 'ok', 0],
      ['openai_responses_agent', 'ok', 40],
      ['validator', 'ok', 15],
    ]);
  });

  it('derives the tool call from output.toolTrace and its timestamp from the audit log', () => {
    const toolCall = timeline.find((event) => event.kind === 'tool_call');
    expect(toolCall).toMatchObject({
      kind: 'tool_call',
      toolName: 'search_product_docs',
      callId: 'call-1',
      stepId: 'step-agent',
      ok: true,
      status: 'ok',
      at: at(30),
      durationMs: 120,
    });
  });

  it('surfaces the validator-bypass heuristic as its own gate event', () => {
    expect(gates(timeline)).toHaveLength(1);
    expect(gates(timeline)[0]).toMatchObject({
      gate: 'validator_bypass',
      confidenceAfter: 0.9,
      approved: true,
      issues: ['validator_bypassed_for_testing'],
    });
    expect(gates(timeline)[0]?.inferred).toBeUndefined();
  });

  it('omits tool-call events for legacy agent rows with no persisted toolTrace', () => {
    const legacySteps = stepRows.map((step) =>
      step.id === 'step-agent'
        ? { ...step, output: { responseIds: ['resp_1'], toolCalls: 1 } }
        : step,
    );
    const legacyTimeline = buildRunTimeline(run, legacySteps, logs);
    expect(legacyTimeline.some((event) => event.kind === 'tool_call')).toBe(false);
    expect(steps(legacyTimeline)).toHaveLength(3);
  });
});

/* -------------------------------------------------------------------------- *
 * Scenario 2 — early-decline run
 * -------------------------------------------------------------------------- */

describe('buildRunTimeline — early-decline run', () => {
  const run = makeRun({
    confidence: 0.92,
    updated_at: at(30),
    final_output: { routingDecision: 'ambiguous', confidence: 0.92 },
    user_input: { message: 'Can I mix bleach and ammonia?', modelTag: 'preview' },
  });
  const stepRows: WorkflowStepRow[] = [
    plannerStep,
    makeStep({
      id: 'step-decline',
      step_name: 'early_decline_gate',
      started_at: at(15),
      completed_at: at(15),
      input: { reason: 'chemical_mixing_or_safety', message: 'Can I mix bleach and ammonia?' },
      output: { applied: true, reason: 'chemical_mixing_or_safety' },
    }),
  ];
  const logs: AuditLogRow[] = [
    makeLog({ id: 'log-step-started', event_type: 'step_started', created_at: at(10), payload: { step: 'orchestration_planner', step_id: 'step-planner' } }),
    makeLog({
      id: 'log-decline',
      event_type: 'step_completed',
      created_at: at(15),
      payload: { step: 'early_decline_gate', step_id: 'step-decline', reason: 'chemical_mixing_or_safety' },
    }),
    makeLog({ id: 'log-completed', event_type: 'workflow_completed', created_at: at(30), payload: { workflow_run_id: RUN_ID, early_decline_reason: 'chemical_mixing_or_safety' } }),
  ];
  const timeline = buildRunTimeline(run, stepRows, logs);

  it('surfaces the early-decline gate as its own confidence gate', () => {
    expect(gates(timeline)).toHaveLength(1);
    expect(gates(timeline)[0]).toMatchObject({
      gate: 'early_decline_gate',
      confidenceAfter: 0.92,
      approved: true,
      issues: ['chemical_mixing_or_safety'],
      at: at(15),
    });
  });

  it('ends on workflow_completed and never projects the un-run agent/validator steps', () => {
    expect(kinds(timeline)).toEqual([
      'lifecycle',
      'step',
      'step',
      'confidence_gate',
      'lifecycle',
    ]);
    expect(timeline.at(-1)).toMatchObject({ kind: 'lifecycle', phase: 'workflow_completed' });
    expect(steps(timeline).map((event) => event.stepName)).toEqual([
      'orchestration_planner',
      'early_decline_gate',
    ]);
    expect(steps(timeline).every((event) => event.status !== 'not_reached')).toBe(true);
  });
});

/* -------------------------------------------------------------------------- *
 * Scenario 3 — failed run
 * -------------------------------------------------------------------------- */

describe('buildRunTimeline — failed run', () => {
  const run = makeRun({
    status: 'failed',
    confidence: null,
    updated_at: at(55),
    final_output: { error: 'OpenAI request timed out' },
  });
  const stepRows: WorkflowStepRow[] = [
    plannerStep,
    makeStep({
      id: 'step-agent',
      step_name: 'openai_responses_agent',
      status: 'failed',
      started_at: at(20),
      completed_at: at(50),
      error: { message: 'OpenAI request timed out' },
    }),
  ];
  const logs: AuditLogRow[] = [
    makeLog({ id: 'log-resp', event_type: 'openai_response_requested', created_at: at(20), payload: { step: 'agent', step_id: 'step-agent' } }),
    makeLog({ id: 'log-failed', event_type: 'workflow_failed', created_at: at(55), payload: { message: 'OpenAI request timed out' } }),
  ];
  const timeline = buildRunTimeline(run, stepRows, logs);

  it('marks the failing step failed and carries its error', () => {
    const agent = steps(timeline).find((event) => event.stepName === 'openai_responses_agent');
    expect(agent).toMatchObject({ status: 'failed', stepId: 'step-agent' });
    expect(agent?.error).toEqual({ message: 'OpenAI request timed out' });
  });

  it('projects the validator step as not reached', () => {
    const validator = steps(timeline).find((event) => event.stepName === 'validator');
    expect(validator).toMatchObject({
      status: 'not_reached',
      stepId: null,
      rawStatus: null,
      startedAt: null,
      completedAt: null,
      id: `step:${RUN_ID}:not_reached:validator`,
    });
    expect(validator?.detail.failedAtStepName).toBe('openai_responses_agent');
  });

  it('places the not-reached step before the terminal workflow_failed event', () => {
    expect(kinds(timeline)).toEqual(['lifecycle', 'step', 'step', 'step', 'lifecycle']);
    expect(timeline.at(-1)).toMatchObject({
      kind: 'lifecycle',
      phase: 'workflow_failed',
      status: 'failed',
    });
    const notReachedIndex = timeline.findIndex(
      (event) => event.kind === 'step' && event.status === 'not_reached',
    );
    expect(notReachedIndex).toBe(timeline.length - 2);
  });
});

/* -------------------------------------------------------------------------- *
 * Scenario 4 — recommendations-routed run (LLM validator + 0.55 cap INFERRED the
 * historical, pre-B0-367 way + recommendation gate + human review)
 * -------------------------------------------------------------------------- */

describe('buildRunTimeline — recommendations-routed run', () => {
  const run = makeRun({
    confidence: 0.55,
    updated_at: at(140),
    final_output: { routingDecision: 'recommendations', confidence: 0.55 },
    user_input: { message: 'What is a Betco equivalent to BNC-15? How do I use it safely?', modelTag: 'preview' },
  });
  const stepRows: WorkflowStepRow[] = [
    plannerStep,
    makeStep({
      id: 'step-agent',
      step_name: 'openai_responses_agent',
      started_at: at(20),
      completed_at: at(70),
      output: {
        responseIds: ['resp_1', 'resp_2'],
        toolCalls: 2,
        toolTrace: [
          toolTraceEntry({ toolName: 'lookup_cross_reference', callId: 'call-xref', durationMs: 80 }),
          toolTraceEntry({ toolName: 'search_product_docs', callId: 'call-search', ok: false, durationMs: 200 }),
        ],
      },
    }),
    makeStep({
      id: 'step-validator',
      step_name: 'validator',
      started_at: at(80),
      completed_at: at(130),
      output: {
        approved: false,
        confidence: 0.55,
        issues: [
          'insufficient_usage_and_safety_evidence',
          'Top retrieval similarity 58% is below 60%; confidence capped at 0.75.',
        ],
        requires_human_review: true,
      },
    }),
  ];
  const logs: AuditLogRow[] = [
    makeLog({ id: 'log-xref-called', event_type: 'tool_called', created_at: at(30), payload: { tool_name: 'lookup_cross_reference', call_id: 'call-xref' } }),
    makeLog({ id: 'log-xref-ok', event_type: 'tool_succeeded', created_at: at(40), payload: { tool_name: 'lookup_cross_reference', call_id: 'call-xref' } }),
    makeLog({ id: 'log-search-called', event_type: 'tool_called', created_at: at(50), payload: { tool_name: 'search_product_docs', call_id: 'call-search' } }),
    makeLog({
      id: 'log-search-failed',
      event_type: 'tool_failed',
      created_at: at(60),
      // B0-363 — the failure cause is now persisted on the audit row itself.
      payload: {
        tool_name: 'search_product_docs',
        call_id: 'call-search',
        error_message: 'embedding request failed: 429 rate limited',
        arguments_preview: '{"query":"BNC-15 equivalent usage"}',
      },
    }),
    makeLog({
      id: 'log-validation',
      event_type: 'validation_completed',
      created_at: at(90),
      payload: { approved: true, confidence: 0.9, issues: [], requires_human_review: false },
    }),
    makeLog({
      id: 'log-rec-gate',
      event_type: 'recommendation_gate_applied',
      created_at: at(110),
      payload: {
        approved: true,
        confidence: 0.75,
        issues: ['Top retrieval similarity 58% is below 60%; confidence capped at 0.75.'],
        requires_human_review: false,
        topSimilarity: 0.58,
      },
    }),
    makeLog({ id: 'log-review', event_type: 'review_requested', created_at: at(135), payload: { issues: ['insufficient_usage_and_safety_evidence'] } }),
    makeLog({ id: 'log-completed', event_type: 'workflow_completed', created_at: at(140), payload: { workflow_run_id: RUN_ID } }),
  ];
  const timeline = buildRunTimeline(run, stepRows, logs);

  it('emits both tool calls in call order, flagging the failed one', () => {
    const toolCalls = timeline.filter((event) => event.kind === 'tool_call');
    expect(toolCalls.map((event) => [event.label, event.status, event.at])).toEqual([
      ['Tool: lookup_cross_reference', 'ok', at(30)],
      ['Tool: search_product_docs', 'failed', at(50)],
    ]);
  });

  it('B0-363: carries the tool_failed error message + arguments preview into the tool-call detail', () => {
    const failed = timeline.find(
      (event) => event.kind === 'tool_call' && event.status === 'failed',
    );
    expect(failed).toMatchObject({
      kind: 'tool_call',
      callId: 'call-search',
      errorMessage: 'embedding request failed: 429 rate limited',
      auditArgumentsPreview: '{"query":"BNC-15 equivalent usage"}',
    });
    expect(failed?.detail).toMatchObject({
      errorMessage: 'embedding request failed: 429 rate limited',
      auditArgumentsPreview: '{"query":"BNC-15 equivalent usage"}',
    });
  });

  it('B0-363: leaves successful tool calls without audit failure fields', () => {
    const ok = timeline.find((event) => event.kind === 'tool_call' && event.status === 'ok');
    expect(ok).toMatchObject({ errorMessage: null, auditArgumentsPreview: null });
    expect(ok?.detail).not.toHaveProperty('errorMessage');
    expect(ok?.detail).not.toHaveProperty('auditArgumentsPreview');
  });

  it('B0-363: degrades to null for historical tool_failed rows with no error_message', () => {
    const legacyLogs = logs.map((log) =>
      log.id === 'log-search-failed'
        ? {
            ...log,
            payload: { tool_name: 'search_product_docs', call_id: 'call-search' },
          }
        : log,
    );
    const legacy = buildRunTimeline(run, stepRows, legacyLogs);
    const failed = legacy.find(
      (event) => event.kind === 'tool_call' && event.status === 'failed',
    );
    expect(failed).toMatchObject({ errorMessage: null, auditArgumentsPreview: null });
  });

  it('surfaces every confidence-affecting gate separately and in order', () => {
    expect(gates(timeline).map((event) => event.gate)).toEqual([
      'llm_validator',
      'usage_safety_coverage_cap',
      'recommendation_gate',
    ]);
  });

  it('infers the usage/safety-coverage cap by diffing the validator pass against the step output', () => {
    const cap = gates(timeline).find((event) => event.gate === 'usage_safety_coverage_cap');
    expect(cap).toMatchObject({
      inferred: true,
      cap: USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP,
      confidenceBefore: 0.9,
      confidenceAfter: 0.55,
      approved: false,
      requiresHumanReview: true,
      issues: ['insufficient_usage_and_safety_evidence'],
      status: 'failed',
    });
    expect(cap?.detail.missingEvidence).toEqual(['usage', 'safety']);
    // The other gates all have direct log entries, so none of them are inferred.
    expect(gates(timeline).filter((event) => event.inferred === true)).toHaveLength(1);
  });

  it('reports the LLM validator self-report and the recommendation-gate calibration from their audit rows', () => {
    const llmGate = gates(timeline).find((event) => event.gate === 'llm_validator');
    expect(llmGate).toMatchObject({ confidenceAfter: 0.9, approved: true, cap: null });
    expect(llmGate?.inferred).toBeUndefined();
    const recGate = gates(timeline).find((event) => event.gate === 'recommendation_gate');
    expect(recGate).toMatchObject({ confidenceAfter: 0.75, approved: true });
    expect(recGate?.detail.topSimilarity).toBe(0.58);
  });

  it('surfaces the human-review escalation and finishes on workflow_completed', () => {
    expect(kinds(timeline)).toEqual([
      'lifecycle',
      'step',
      'step',
      'tool_call',
      'tool_call',
      'step',
      'confidence_gate',
      'confidence_gate',
      'confidence_gate',
      'review',
      'lifecycle',
    ]);
    expect(timeline.find((event) => event.kind === 'review')).toMatchObject({
      issues: ['insufficient_usage_and_safety_evidence'],
      status: 'failed',
    });
  });

  it('B0-368: a historical review_requested row with no reason still renders the bare headline', () => {
    const review = timeline.find((event) => event.kind === 'review');
    expect(review).toMatchObject({ reason: null, label: 'Human review requested' });
  });

  it('B0-368: promotes the reason discriminator into the review headline', () => {
    const cases: [string, string][] = [
      ['regulated_claim_unverified', 'Human review requested — regulated claim unverified'],
      ['revision_refused', 'Human review requested — revision pass refused to re-ground'],
      ['validator_rejected', 'Human review requested — validator rejected the answer'],
      // An unknown reason is shown raw rather than dropped.
      ['some_future_reason', 'Human review requested — some_future_reason'],
    ];

    for (const [reason, expectedLabel] of cases) {
      const withReason = buildRunTimeline(
        run,
        stepRows,
        logs.map((log) =>
          log.event_type === 'review_requested'
            ? { ...log, payload: { reason, issues: ['insufficient_safety_evidence'] } }
            : log,
        ),
      );
      expect(withReason.find((event) => event.kind === 'review')).toMatchObject({
        reason,
        label: expectedLabel,
        status: 'failed',
      });
    }
  });
});

/* -------------------------------------------------------------------------- *
 * Scenario 5 — B0-367: the usage/safety coverage cap now writes a real audit row
 * -------------------------------------------------------------------------- */

function coverageCapRunFixture() {
  const run = makeRun({
    confidence: 0.55,
    updated_at: at(140),
    final_output: { routingDecision: 'product', confidence: 0.55 },
    user_input: { message: 'How do I use Betco Fight Bac safely?', modelTag: 'preview' },
  });
  const stepRows: WorkflowStepRow[] = [
    plannerStep,
    makeStep({
      id: 'step-agent',
      step_name: 'openai_responses_agent',
      started_at: at(20),
      completed_at: at(70),
      output: { responseIds: ['resp_1'], toolCalls: 0, toolTrace: [] },
    }),
    makeStep({
      id: 'step-validator',
      step_name: 'validator',
      started_at: at(80),
      completed_at: at(130),
      output: {
        approved: false,
        confidence: 0.55,
        issues: ['insufficient_safety_evidence'],
        requires_human_review: true,
      },
    }),
  ];
  const logs: AuditLogRow[] = [
    makeLog({
      id: 'log-validation',
      event_type: 'validation_completed',
      created_at: at(90),
      payload: { approved: true, confidence: 0.82, issues: [], requires_human_review: false },
    }),
    makeLog({
      id: 'log-coverage-cap',
      event_type: 'usage_safety_coverage_cap_applied',
      created_at: at(100),
      payload: {
        missingEvidence: ['safety'],
        confidenceBefore: 0.82,
        confidenceAfter: 0.55,
        cap: 0.55,
        issues: ['insufficient_safety_evidence'],
        approved: false,
        requires_human_review: true,
      },
    }),
    makeLog({ id: 'log-completed', event_type: 'workflow_completed', created_at: at(140), payload: { workflow_run_id: RUN_ID } }),
  ];
  return { run, stepRows, logs };
}

describe('buildRunTimeline — usage/safety coverage cap with a real audit row (B0-367)', () => {
  const { run, stepRows, logs } = coverageCapRunFixture();
  const timeline = buildRunTimeline(run, stepRows, logs);

  it('renders the cap from the audit row, without the inferred badge', () => {
    const caps = gates(timeline).filter(
      (event) => event.gate === 'usage_safety_coverage_cap',
    );
    expect(caps).toHaveLength(1);
    expect(caps[0]).toMatchObject({
      id: 'gate:usage_safety_coverage_cap:log-coverage-cap',
      at: at(100),
      cap: USAGE_SAFETY_COVERAGE_CONFIDENCE_CAP,
      confidenceBefore: 0.82,
      confidenceAfter: 0.55,
      approved: false,
      requiresHumanReview: true,
      issues: ['insufficient_safety_evidence'],
      status: 'failed',
    });
    expect(caps[0]?.inferred).toBeUndefined();
    expect(caps[0]?.detail.missingEvidence).toEqual(['safety']);
  });

  it('does not also emit the inferred event for the same run', () => {
    expect(timeline.filter((event) => event.inferred === true)).toHaveLength(0);
  });

  it('agrees with the inference on confidenceBefore/After for the same run shape', () => {
    // Same rows minus the new audit row = the historical path.
    const inferredTimeline = buildRunTimeline(
      run,
      stepRows,
      logs.filter((log) => log.event_type !== 'usage_safety_coverage_cap_applied'),
    );
    const inferredCap = gates(inferredTimeline).find(
      (event) => event.gate === 'usage_safety_coverage_cap',
    );
    expect(inferredCap).toMatchObject({
      inferred: true,
      confidenceBefore: 0.82,
      confidenceAfter: 0.55,
      issues: ['insufficient_safety_evidence'],
    });
  });

  it('still renders the inferred event (with its badge) for historical runs', () => {
    const historical = buildRunTimeline(
      run,
      stepRows,
      logs.filter((log) => log.event_type !== 'usage_safety_coverage_cap_applied'),
    );
    const cap = gates(historical).find(
      (event) => event.gate === 'usage_safety_coverage_cap',
    );
    expect(cap?.inferred).toBe(true);
    expect(cap?.detail.note).toContain('inferred');
  });
});
