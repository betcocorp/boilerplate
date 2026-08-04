import { describe, expect, it } from 'vitest';

import {
  buildPromptAnalysisPayload,
  describeTimelineEvent,
  normalizePromptInsights,
  promptInsightsResponseSchema,
  type PromptInsight,
  type WorkflowRunTrace,
} from '~/lib/observability/prompt-insights';

import type { TimelineEvent } from '~/types/observability';

function toolCall(
  overrides: Partial<Extract<TimelineEvent, { kind: 'tool_call' }>> = {},
): TimelineEvent {
  return {
    kind: 'tool_call',
    id: 'tc-1',
    label: 'lookup_cross_reference',
    at: '2026-08-04T10:00:01.000Z',
    status: 'ok',
    detail: {},
    toolName: 'lookup_cross_reference',
    callId: 'call_1',
    argumentsPreview: '{"brand":"Spartan","productName":"BNC-15"}',
    outputPreview: '{"ok":true,"fallbackRecommended":true}',
    ok: true,
    stepId: 'step-1',
    durationMs: 120,
    ...overrides,
  };
}

function trace(overrides: {
  finalOutput?: Record<string, unknown> | null;
  userInput?: Record<string, unknown>;
  timeline?: TimelineEvent[];
  confidence?: number | null;
  status?: string;
}): WorkflowRunTrace {
  return {
    run: {
      id: 'run-1',
      conversation_id: 'conv-1',
      workflow_name: 'product-support',
      status: overrides.status ?? 'completed',
      user_input: overrides.userInput ?? { message: 'What replaces Spartan BNC-15?' },
      final_output:
        overrides.finalOutput === undefined
          ? {
              routingDecision: 'product',
              answerText: 'Betco Fight Bac RTU is a comparable disinfectant.',
              validation: { approved: true, confidence: 0.6, issues: [], requires_human_review: false },
              sources: [{ url: 'https://betco.com/a' }],
              retrieved_document_chunks: [{ id: 'c1' }, { id: 'c2' }],
            }
          : overrides.finalOutput,
      // `??` would coerce an explicitly-passed null back to the default.
      confidence: 'confidence' in overrides ? overrides.confidence : 0.6,
      created_at: '2026-08-04T10:00:00.000Z',
      updated_at: '2026-08-04T10:00:09.000Z',
    } as WorkflowRunTrace['run'],
    steps: [],
    auditLogs: [],
    timeline: overrides.timeline ?? [toolCall()],
  };
}

describe('buildPromptAnalysisPayload', () => {
  it('surfaces the run header, user message, and answer', () => {
    const payload = buildPromptAnalysisPayload(trace({}));

    expect(payload).toContain('Routing decision: product');
    expect(payload).toContain('Final confidence: 0.6');
    expect(payload).toContain('Sources cited: 1');
    expect(payload).toContain('Retrieved chunks: 2');
    expect(payload).toContain('What replaces Spartan BNC-15?');
    expect(payload).toContain('Betco Fight Bac RTU is a comparable disinfectant.');
  });

  it('counts failed tool calls and flags repeated tools', () => {
    const payload = buildPromptAnalysisPayload(
      trace({
        timeline: [
          toolCall(),
          toolCall({ id: 'tc-2', callId: 'call_2' }),
          toolCall({
            id: 'tc-3',
            callId: 'call_3',
            toolName: 'recommend_cross_reference',
            ok: false,
            status: 'failed',
          }),
        ],
      }),
    );

    expect(payload).toContain('Tool calls: 3 (1 failed)');
    expect(payload).toContain('lookup_cross_reference x2');
    expect(payload).toContain('TOOL recommend_cross_reference — FAILED');
  });

  it('reports an unknown duration rather than 0ms when the span is missing', () => {
    // workflow_steps.started_at is Postgres now() while completed_at is the Node
    // clock, so timeline.ts drops negative spans to undefined. Those must not be
    // presented to the model as a zero-duration step.
    const payload = buildPromptAnalysisPayload(
      trace({ timeline: [toolCall({ durationMs: undefined })] }),
    );

    expect(payload).toContain('in unknown');
    expect(payload).not.toContain('in 0ms');
  });

  it('degrades gracefully when final_output is missing entirely', () => {
    const payload = buildPromptAnalysisPayload(
      trace({ finalOutput: null, confidence: null, status: 'failed' }),
    );

    expect(payload).toContain('Status: failed');
    expect(payload).toContain('Routing decision: unknown');
    expect(payload).toContain('Final confidence: n/a');
    expect(payload).toContain('Validator verdict: none recorded');
    expect(payload).toContain('(no answer text recorded)');
  });

  it('includes an empty-trace marker when nothing is describable', () => {
    const payload = buildPromptAnalysisPayload(trace({ timeline: [] }));
    expect(payload).toContain('No trace events recorded.');
  });
});

describe('describeTimelineEvent', () => {
  it('renders a confidence gate with its cap, issues and inferred marker', () => {
    const line = describeTimelineEvent({
      kind: 'confidence_gate',
      id: 'g-1',
      label: 'coverage cap',
      at: '2026-08-04T10:00:05.000Z',
      status: 'ok',
      detail: {},
      inferred: true,
      gate: 'usage_safety_coverage_cap',
      confidenceBefore: 0.9,
      confidenceAfter: 0.55,
      cap: 0.55,
      approved: null,
      requiresHumanReview: false,
      issues: ['missing_safety_evidence'],
    });

    expect(line).toContain('GATE usage_safety_coverage_cap');
    expect(line).toContain('confidence 0.9 -> 0.55');
    expect(line).toContain('cap 0.55');
    expect(line).toContain('issues: missing_safety_evidence');
    expect(line).toContain('inferred');
  });

  it('drops lifecycle markers, which the run header already covers', () => {
    const line = describeTimelineEvent({
      kind: 'lifecycle',
      id: 'l-1',
      label: 'started',
      at: '2026-08-04T10:00:00.000Z',
      status: 'ok',
      detail: {},
      phase: 'workflow_started',
    });

    expect(line).toBeNull();
  });
});

describe('normalizePromptInsights', () => {
  const insight = (rank: number, title: string): PromptInsight => ({
    rank,
    title,
    description: 'because the trace says so',
    category: 'routing',
    impact: 'high',
  });

  it('caps at 3 and renumbers sequentially', () => {
    const result = normalizePromptInsights([
      insight(7, 'a'),
      insight(7, 'b'),
      insight(2, 'c'),
      insight(9, 'd'),
    ]);

    expect(result).toHaveLength(3);
    expect(result.map((i) => i.rank)).toEqual([1, 2, 3]);
    expect(result.map((i) => i.title)).toEqual(['a', 'b', 'c']);
  });
});

describe('promptInsightsResponseSchema', () => {
  it('rejects a category the UI has no style for', () => {
    const parsed = promptInsightsResponseSchema.safeParse({
      insights: [
        {
          rank: 1,
          title: 'x',
          description: 'y',
          category: 'corpus', // valid for test-run insights, not for prompt insights
          impact: 'high',
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it('accepts a well-formed payload', () => {
    const parsed = promptInsightsResponseSchema.safeParse({
      insights: [
        {
          rank: 1,
          title: 'Name the competitor brand explicitly',
          description: 'The router scored this ambiguous.',
          category: 'prompt',
          impact: 'high',
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });
});
