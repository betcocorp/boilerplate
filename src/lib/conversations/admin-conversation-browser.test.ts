import { describe, expect, it } from 'vitest';

import {
  aggregateConversationMetrics,
  buildTurnRun,
  matchRunsToTurns,
  pairConversationTurns,
  readPlannerRouting,
  readTurnToolCalls,
  resolveOwnerDisplay,
  summarizeTurnTotals,
  type ConversationMessageRow,
  type ConversationRunRow,
  type ConversationStepRow,
} from '~/lib/conversations/admin-conversation-browser';

const CONVERSATION_ID = 'c0000000-0000-4000-8000-000000000001';

function message(
  overrides: Partial<ConversationMessageRow> & Pick<ConversationMessageRow, 'id' | 'role' | 'created_at'>,
): ConversationMessageRow {
  return {
    conversation_id: CONVERSATION_ID,
    content: null,
    plain_text: null,
    processing_ms: null,
    user_pause_ms: null,
    pause_tier: null,
    ...overrides,
  };
}

function run(overrides: Partial<ConversationRunRow> & Pick<ConversationRunRow, 'id' | 'created_at'>): ConversationRunRow {
  return {
    conversation_id: CONVERSATION_ID,
    status: 'completed',
    confidence: 0.9,
    source: 'bex_chat',
    app_version: '2.19.0',
    prompt_bundle_version: 'bundlehash',
    updated_at: overrides.created_at,
    routing_decision: 'product',
    prompt_version: 'prompthash',
    ...overrides,
  };
}

function step(
  overrides: Partial<ConversationStepRow> & Pick<ConversationStepRow, 'id' | 'workflow_run_id' | 'step_name'>,
): ConversationStepRow {
  return {
    status: 'completed',
    started_at: '2026-09-23T20:14:00.000Z',
    completed_at: '2026-09-23T20:14:01.500Z',
    output: null,
    ...overrides,
  };
}

const RUN_A = 'a0000000-0000-4000-8000-00000000000a';
const RUN_B = 'b0000000-0000-4000-8000-00000000000b';
const RUN_C = 'c0000000-0000-4000-8000-00000000000c';

describe('pairConversationTurns', () => {
  it('pairs each user message with the assistant reply that followed it, in time order', () => {
    const rows = [
      message({ id: 'a1', role: 'assistant', created_at: '2026-09-23T20:14:14.000Z', plain_text: 'Answer 1', processing_ms: 15_000, content: { kind: 'assistant_turn', text: 'Answer 1', workflowRunId: RUN_A } }),
      message({ id: 'u1', role: 'user', created_at: '2026-09-23T20:13:58.000Z', plain_text: 'What is AF79?' }),
      message({ id: 'u2', role: 'user', created_at: '2026-09-23T20:14:27.000Z', plain_text: 'What is the dilution?', user_pause_ms: 13_629, pause_tier: 'short' }),
      message({ id: 'a2', role: 'assistant', created_at: '2026-09-23T20:14:52.000Z', plain_text: 'Answer 2', processing_ms: 24_234, content: { kind: 'assistant_turn', text: 'Answer 2', workflowRunId: RUN_B } }),
    ];

    const { turns, orphanAssistantMessages } = pairConversationTurns(rows);

    expect(orphanAssistantMessages).toBe(0);
    expect(turns).toHaveLength(2);
    expect(turns[0]).toMatchObject({
      index: 1,
      user: { id: 'u1', text: 'What is AF79?', pauseMs: null, pauseTier: null },
      assistant: { id: 'a1', text: 'Answer 1', processingMs: 15_000, workflowRunId: RUN_A },
    });
    expect(turns[1]).toMatchObject({
      index: 2,
      user: { id: 'u2', pauseMs: 13_629, pauseTier: 'short' },
      assistant: { id: 'a2', processingMs: 24_234, workflowRunId: RUN_B },
    });
  });

  it('leaves a turn without an assistant when the next message is another user message', () => {
    const rows = [
      message({ id: 'u1', role: 'user', created_at: '2026-09-23T20:00:00.000Z', plain_text: 'first' }),
      message({ id: 'u2', role: 'user', created_at: '2026-09-23T20:01:00.000Z', plain_text: 'retry' }),
      message({ id: 'a2', role: 'assistant', created_at: '2026-09-23T20:01:20.000Z', plain_text: 'reply' }),
    ];

    const { turns } = pairConversationTurns(rows);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.assistant).toBeNull();
    expect(turns[1]?.assistant?.id).toBe('a2');
  });

  it('counts an assistant row before any user message as an orphan and never drops text fallbacks', () => {
    const rows = [
      message({ id: 'a0', role: 'assistant', created_at: '2026-09-23T19:59:00.000Z', plain_text: 'stray' }),
      message({ id: 'u1', role: 'user', created_at: '2026-09-23T20:00:00.000Z', content: { kind: 'user_turn', text: 'from content' } }),
      message({ id: 't1', role: 'tool', created_at: '2026-09-23T20:00:05.000Z' }),
      message({ id: 'a1', role: 'assistant', created_at: '2026-09-23T20:00:10.000Z', content: { kind: 'assistant_turn', text: 'content text', model: 'gpt-5.5', confidence: 0.8, toolSummary: [{ name: 'search_product_docs', ok: true }] } }),
    ];

    const { turns, orphanAssistantMessages } = pairConversationTurns(rows);

    expect(orphanAssistantMessages).toBe(1);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.user.text).toBe('from content');
    expect(turns[0]?.assistant).toMatchObject({
      text: 'content text',
      model: 'gpt-5.5',
      confidence: 0.8,
      workflowRunId: null,
      toolSummary: [{ name: 'search_product_docs', ok: true }],
    });
  });

  it('narrows an unknown stored pause_tier to null rather than inventing a tier', () => {
    const rows = [
      message({ id: 'u1', role: 'user', created_at: '2026-09-23T20:00:00.000Z', user_pause_ms: 10, pause_tier: 'bogus' }),
    ];
    expect(pairConversationTurns(rows).turns[0]?.user.pauseTier).toBeNull();
  });
});

describe('matchRunsToTurns', () => {
  const turnsOf = (rows: ConversationMessageRow[]) => pairConversationTurns(rows).turns;

  it('claims runs by the assistant message link first, then by timestamp for reply-less turns', () => {
    const turns = turnsOf([
      message({ id: 'u1', role: 'user', created_at: '2026-09-23T20:00:00.000Z' }),
      message({ id: 'a1', role: 'assistant', created_at: '2026-09-23T20:00:10.000Z', content: { kind: 'assistant_turn', text: 'x', workflowRunId: RUN_A } }),
      // Turn 2 failed before an assistant row was written: no link, must fall back to timestamps.
      message({ id: 'u2', role: 'user', created_at: '2026-09-23T20:01:00.000Z' }),
      message({ id: 'u3', role: 'user', created_at: '2026-09-23T20:02:00.000Z' }),
      message({ id: 'a3', role: 'assistant', created_at: '2026-09-23T20:02:10.000Z', content: { kind: 'assistant_turn', text: 'y', workflowRunId: RUN_C } }),
    ]);
    const runs = [
      run({ id: RUN_A, created_at: '2026-09-23T20:00:00.500Z' }),
      run({ id: RUN_B, created_at: '2026-09-23T20:01:00.400Z', status: 'failed', confidence: null }),
      run({ id: RUN_C, created_at: '2026-09-23T20:02:00.300Z' }),
    ];

    const { turns: matched, unmatchedRunIds } = matchRunsToTurns(turns, runs, new Map());

    expect(matched.map((turn) => turn.run?.id)).toEqual([RUN_A, RUN_B, RUN_C]);
    expect(matched.map((turn) => turn.run?.matchedBy)).toEqual(['message_link', 'timestamp', 'message_link']);
    expect(matched[1]?.run?.status).toBe('failed');
    expect(unmatchedRunIds).toEqual([]);
  });

  it('never claims a run twice and reports runs no turn claimed', () => {
    const turns = turnsOf([
      message({ id: 'u1', role: 'user', created_at: '2026-09-23T20:00:00.000Z' }),
      message({ id: 'a1', role: 'assistant', created_at: '2026-09-23T20:00:10.000Z', content: { kind: 'assistant_turn', text: 'x', workflowRunId: RUN_A } }),
      message({ id: 'u2', role: 'user', created_at: '2026-09-23T20:01:00.000Z' }),
      message({ id: 'a2', role: 'assistant', created_at: '2026-09-23T20:01:10.000Z', content: { kind: 'assistant_turn', text: 'dup', workflowRunId: RUN_A } }),
    ]);
    const runs = [
      run({ id: RUN_A, created_at: '2026-09-23T20:00:00.500Z' }),
      // Created before every user message: outside any turn's window.
      run({ id: RUN_B, created_at: '2026-09-23T19:00:00.000Z' }),
    ];

    const { turns: matched, unmatchedRunIds } = matchRunsToTurns(turns, runs, new Map());

    expect(matched[0]?.run?.id).toBe(RUN_A);
    // The duplicate link is ignored and the fallback finds nothing inside turn 2's window.
    expect(matched[1]?.run).toBeNull();
    expect(unmatchedRunIds).toEqual([RUN_B]);
  });

  it('bounds the timestamp fallback at the next turn so a later run is not pulled backwards', () => {
    const turns = turnsOf([
      message({ id: 'u1', role: 'user', created_at: '2026-09-23T20:00:00.000Z' }),
      message({ id: 'u2', role: 'user', created_at: '2026-09-23T20:05:00.000Z' }),
    ]);
    const runs = [run({ id: RUN_B, created_at: '2026-09-23T20:05:00.200Z' })];

    const { turns: matched } = matchRunsToTurns(turns, runs, new Map());

    expect(matched[0]?.run).toBeNull();
    expect(matched[1]?.run?.id).toBe(RUN_B);
  });
});

describe('buildTurnRun', () => {
  it('reads routing, classifier confidence, tool calls and step durations off the run and its steps', () => {
    const plannerOutput = {
      routing: { decision: 'bathroom', rationale: 'LLM intent classifier (llm, confidence 0.85) routed to "bathroom".' },
      gates: [
        { gate: 'keyword_routing', inputs: { routedAgent: 'product' } },
        { gate: 'llm_intent_classifier_live', inputs: { classifierConfidence: 0.85, classifierSource: 'llm' } },
      ],
    };
    const agentOutput = {
      toolTrace: [
        { toolName: 'search_product_docs', callId: 'c1', argumentsPreview: '{}', outputPreview: '{}', ok: true, durationMs: 2435, origin: 'workflow_injected' },
        { toolName: 'get_efficacy_data', callId: 'c2', argumentsPreview: '{}', outputPreview: '{}', ok: false, durationMs: 2 },
      ],
    };
    const steps = [
      step({ id: 's2', workflow_run_id: RUN_A, step_name: 'openai_responses_agent', started_at: '2026-09-23T20:14:01.000Z', completed_at: '2026-09-23T20:14:09.000Z', output: agentOutput }),
      step({ id: 's1', workflow_run_id: RUN_A, step_name: 'orchestration_planner', started_at: '2026-09-23T20:14:00.000Z', completed_at: '2026-09-23T20:14:01.000Z', output: plannerOutput }),
      // Clock skew: completed before started → clamped to 0, never negative or dropped.
      step({ id: 's3', workflow_run_id: RUN_A, step_name: 'validator', started_at: '2026-09-23T20:14:09.000Z', completed_at: '2026-09-23T20:14:08.900Z' }),
    ];

    const view = buildTurnRun(run({ id: RUN_A, created_at: '2026-09-23T20:13:59.000Z', routing_decision: null }), steps, 'message_link');

    // No final_output routingDecision → the planner's decision is the fallback.
    expect(view.routingDecision).toBe('bathroom');
    expect(view.planner).toEqual({
      decision: 'bathroom',
      rationale: 'LLM intent classifier (llm, confidence 0.85) routed to "bathroom".',
      classifierConfidence: 0.85,
      classifierSource: 'llm',
    });
    expect(view.toolCalls).toEqual([
      { toolName: 'search_product_docs', ok: true, durationMs: 2435, origin: 'workflow_injected' },
      { toolName: 'get_efficacy_data', ok: false, durationMs: 2, origin: null },
    ]);
    expect(view.steps).toEqual([
      { name: 'orchestration_planner', status: 'completed', durationMs: 1000 },
      { name: 'openai_responses_agent', status: 'completed', durationMs: 8000 },
      { name: 'validator', status: 'completed', durationMs: 0 },
    ]);
  });

  it('prefers the run row routingDecision over the planner and tolerates missing steps', () => {
    const view = buildTurnRun(run({ id: RUN_A, created_at: '2026-09-23T20:13:59.000Z', routing_decision: 'dilution' }), [], 'timestamp');
    expect(view.routingDecision).toBe('dilution');
    expect(view.planner).toBeNull();
    expect(view.toolCalls).toEqual([]);
    expect(view.steps).toEqual([]);
  });
});

describe('readPlannerRouting / readTurnToolCalls', () => {
  it('returns null for an output with no routing block and [] for a malformed tool trace', () => {
    expect(readPlannerRouting({ gates: [] })).toBeNull();
    expect(readPlannerRouting(null)).toBeNull();
    expect(readTurnToolCalls({ toolTrace: 'not-an-array' })).toEqual([]);
    expect(readTurnToolCalls({ responseIds: [] })).toEqual([]);
  });

  it('falls back to the signals_analysis gate for classifier confidence', () => {
    const routing = readPlannerRouting({
      routing: { decision: 'product' },
      gates: [{ gate: 'signals_analysis', inputs: { signals: { confidence: 0.7, source: 'llm' } } }],
    });
    expect(routing).toEqual({ decision: 'product', rationale: null, classifierConfidence: 0.7, classifierSource: 'llm' });
  });
});

describe('aggregateConversationMetrics', () => {
  it('counts user turns and sums the two metrics per conversation, leaving unmeasured sums null', () => {
    const other = 'c0000000-0000-4000-8000-000000000002';
    const index = aggregateConversationMetrics([
      { conversation_id: CONVERSATION_ID, role: 'user', created_at: '2026-09-23T20:00:00.000Z', processing_ms: null, user_pause_ms: null },
      { conversation_id: CONVERSATION_ID, role: 'assistant', created_at: '2026-09-23T20:00:10.000Z', processing_ms: 10_000, user_pause_ms: null },
      { conversation_id: CONVERSATION_ID, role: 'user', created_at: '2026-09-23T20:00:30.000Z', processing_ms: null, user_pause_ms: 20_000 },
      { conversation_id: CONVERSATION_ID, role: 'assistant', created_at: '2026-09-23T20:00:45.000Z', processing_ms: 15_000, user_pause_ms: null },
      { conversation_id: other, role: 'user', created_at: '2026-09-23T21:00:00.000Z', processing_ms: null, user_pause_ms: null },
      { conversation_id: other, role: 'assistant', created_at: '2026-09-23T21:00:05.000Z', processing_ms: null, user_pause_ms: null },
    ]);

    expect(index.get(CONVERSATION_ID)).toEqual({
      turnCount: 2,
      agentMs: 25_000,
      pauseMs: 20_000,
      agentSampleSize: 2,
      pauseSampleSize: 1,
      lastActivityAt: '2026-09-23T20:00:45.000Z',
    });
    expect(index.get(other)).toEqual({
      turnCount: 1,
      agentMs: null,
      pauseMs: null,
      agentSampleSize: 0,
      pauseSampleSize: 0,
      lastActivityAt: '2026-09-23T21:00:05.000Z',
    });
  });
});

describe('summarizeTurnTotals', () => {
  it('computes Σ agent, Σ pause and the agent share', () => {
    const { turns } = pairConversationTurns([
      message({ id: 'u1', role: 'user', created_at: '2026-09-23T20:00:00.000Z' }),
      message({ id: 'a1', role: 'assistant', created_at: '2026-09-23T20:00:10.000Z', processing_ms: 30_000 }),
      message({ id: 'u2', role: 'user', created_at: '2026-09-23T20:01:00.000Z', user_pause_ms: 10_000 }),
      message({ id: 'a2', role: 'assistant', created_at: '2026-09-23T20:01:10.000Z', processing_ms: null }),
    ]);
    const totals = summarizeTurnTotals(turns.map((turn) => ({ ...turn, run: null })));
    expect(totals).toEqual({ agentMs: 30_000, pauseMs: 10_000, agentShare: 0.75 });
  });

  it('reports null sums and a null share when nothing was measured', () => {
    const { turns } = pairConversationTurns([
      message({ id: 'u1', role: 'user', created_at: '2026-09-23T20:00:00.000Z' }),
    ]);
    expect(summarizeTurnTotals(turns.map((turn) => ({ ...turn, run: null })))).toEqual({
      agentMs: null,
      pauseMs: null,
      agentShare: null,
    });
  });
});

describe('resolveOwnerDisplay', () => {
  const profiles = new Map([
    ['u-1', { userId: 'u-1', displayName: 'Tom Bird', email: 'tbird@betco.com' }],
  ]);

  it('maps test_run rows to the test, unowned chat rows to unattributed, and owners to people', () => {
    expect(resolveOwnerDisplay({ source: 'test_run', user_id: null, test_name: 'Golden VCT' }, profiles)).toEqual({ kind: 'test', testName: 'Golden VCT' });
    expect(resolveOwnerDisplay({ source: 'chat', user_id: null, test_name: null }, profiles)).toEqual({ kind: 'unattributed' });
    expect(resolveOwnerDisplay({ source: 'chat', user_id: 'u-1', test_name: null }, profiles)).toEqual({
      kind: 'user',
      person: { userId: 'u-1', displayName: 'Tom Bird', email: 'tbird@betco.com' },
    });
    // No app_user row: the bare id still identifies the owner rather than reading as unattributed.
    expect(resolveOwnerDisplay({ source: 'chat', user_id: 'u-2', test_name: null }, profiles)).toEqual({
      kind: 'user',
      person: { userId: 'u-2', displayName: null, email: null },
    });
  });
});
