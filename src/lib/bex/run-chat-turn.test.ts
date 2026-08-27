import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildPriorTurnHistory,
  buildPriorTurnToolContext,
  PRIOR_TURN_SOURCE_TITLE_LIMIT,
  runBexChatTurn,
} from '~/lib/bex/run-chat-turn';
import { PRIOR_TURN_TOOL_CONTEXT_HEADER } from '~/lib/openai/responses-runtime';
import {
  createConversation,
  getConversationById,
  updateConversation,
} from '~/lib/conversations/conversation-repository';
import {
  insertMessage,
  listMessagesForConversation,
} from '~/lib/conversations/message-repository';
import { runProductSupportWorkflow } from '~/lib/workflows/product-support/run-product-support-workflow';

vi.mock('~/lib/conversations/conversation-repository', () => ({
  createConversation: vi.fn(),
  getConversationById: vi.fn(),
  updateConversation: vi.fn(),
}));

vi.mock('~/lib/conversations/message-repository', () => ({
  insertMessage: vi.fn(),
  jsonContent: (value: unknown) => value,
  listMessagesForConversation: vi.fn(),
}));

vi.mock('~/lib/workflows/product-support/run-product-support-workflow', () => ({
  runProductSupportWorkflow: vi.fn(),
}));

const CONVERSATION_ID = '7ad779f1-2af3-4a82-ae68-bf1372f6cd99';

function baseConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: CONVERSATION_ID,
    title: 'New conversation',
    status: 'active',
    latest_model: null,
    latest_openai_response_id: null,
    openai_conversation_id: null,
    source: 'chat',
    user_id: null,
    workspace_id: null,
    created_at: '2026-08-11T00:00:00.000Z',
    updated_at: '2026-08-11T00:00:00.000Z',
    ...overrides,
  };
}

describe('runBexChatTurn — conversation ownership (B0-449/450)', () => {
  beforeEach(() => {
    vi.mocked(createConversation).mockReset();
    vi.mocked(getConversationById).mockReset();
    vi.mocked(updateConversation).mockReset();
    vi.mocked(insertMessage).mockReset();
    vi.mocked(listMessagesForConversation).mockReset();
    vi.mocked(runProductSupportWorkflow).mockReset();

    vi.mocked(getConversationById).mockResolvedValue(null);
    vi.mocked(listMessagesForConversation).mockResolvedValue([]);
    vi.mocked(insertMessage).mockResolvedValue({} as never);
    vi.mocked(updateConversation).mockResolvedValue(undefined);
    vi.mocked(runProductSupportWorkflow).mockResolvedValue({
      answerText: 'answer',
      workflowRunId: 'wr-1',
      latestOpenaiResponseId: null,
      validation: undefined,
      routingDecision: 'orchestrator',
      timingBreakdown: { toolRounds: 0, cacheSource: null, searchMs: null },
      confidence: undefined,
      sources: [],
    } as never);
  });

  it("owner: {kind:'user', userId} creates the conversation with that user_id", async () => {
    vi.mocked(createConversation).mockResolvedValue(baseConversation({ user_id: 'user-1' }));

    await runBexChatTurn({
      conversationId: null,
      message: 'hello',
      source: 'bex_chat',
      owner: { kind: 'user', userId: 'user-1' },
    });

    expect(createConversation).toHaveBeenCalledWith({ user_id: 'user-1' });
  });

  it("owner: {kind:'system'} creates the conversation with user_id null and source test_run", async () => {
    vi.mocked(createConversation).mockResolvedValue(
      baseConversation({ user_id: null, source: 'test_run' }),
    );

    await runBexChatTurn({
      conversationId: null,
      message: 'hello',
      source: 'harness',
      owner: { kind: 'system' },
    });

    expect(createConversation).toHaveBeenCalledWith({
      user_id: null,
      source: 'test_run',
      test_name: null,
    });
  });

  it("owner: {kind:'system'} with testName stamps it onto the created conversation (B0-645)", async () => {
    vi.mocked(createConversation).mockResolvedValue(
      baseConversation({ user_id: null, source: 'test_run' }),
    );

    await runBexChatTurn({
      conversationId: null,
      message: 'hello',
      source: 'harness',
      owner: { kind: 'system' },
      testName: 'Product Golden Test Set',
    });

    expect(createConversation).toHaveBeenCalledWith({
      user_id: null,
      source: 'test_run',
      test_name: 'Product Golden Test Set',
    });
  });

  it('no owner creates the conversation with no override, so the DB default (user_id null, source chat) applies', async () => {
    vi.mocked(createConversation).mockResolvedValue(baseConversation());

    await runBexChatTurn({
      conversationId: null,
      message: 'hello',
      source: 'bex_chat',
    });

    expect(createConversation).toHaveBeenCalledWith(undefined);
  });
});

/**
 * B0-378 — prior-turn tool context recovered from persisted messages. Only `toolSummary` and
 * `sources` survive on `agent_messages.content`, so this is a summary by necessity: the tool
 * arguments/outputs were never stored on the message.
 */
describe('buildPriorTurnToolContext / buildPriorTurnHistory (B0-378)', () => {
  const assistantContent = {
    kind: 'assistant_turn',
    text: 'Yes — see the label.',
    toolSummary: [
      { name: 'search_product_docs', ok: true },
      { name: 'get_efficacy_data', ok: true },
      { name: 'search_product_docs', ok: true },
    ],
    sources: [
      { documentId: 'doc-1', title: 'pH7Q Dual Label (US)', snippet: '2 oz per gallon' },
      { documentId: 'doc-2', title: 'pH7Q Dual SDS', snippet: 'irritant' },
    ],
  };

  it('summarises tool names (deduped, in order) and retrieved document titles', () => {
    const block = buildPriorTurnToolContext(assistantContent)!;

    expect(block).toContain(PRIOR_TURN_TOOL_CONTEXT_HEADER);
    expect(block).toContain('Tools called, in order: search_product_docs, get_efficacy_data');
    expect(block).toContain('"pH7Q Dual Label (US)"; "pH7Q Dual SDS"');
  });

  it('never replays source snippets, so no regulated value is re-injected out of context', () => {
    const block = buildPriorTurnToolContext(assistantContent)!;

    expect(block).not.toContain('2 oz per gallon');
    expect(block).not.toContain('irritant');
  });

  it('caps the titles it replays and says how many it dropped', () => {
    const block = buildPriorTurnToolContext({
      toolSummary: [],
      sources: Array.from({ length: PRIOR_TURN_SOURCE_TITLE_LIMIT + 3 }, (_, i) => ({
        title: `Doc ${i}`,
      })),
    })!;

    expect(block).toContain('(+3 more)');
    expect(block).toContain('"Doc 0"');
    expect(block).not.toContain(`"Doc ${PRIOR_TURN_SOURCE_TITLE_LIMIT}"`);
  });

  it('returns null for a turn with no recorded tool activity, and for unparseable content', () => {
    expect(buildPriorTurnToolContext({ kind: 'assistant_turn', text: 'declined' })).toBeNull();
    expect(buildPriorTurnToolContext(null)).toBeNull();
    expect(buildPriorTurnToolContext('legacy string content')).toBeNull();
  });

  it('attaches toolContext to assistant rows only, leaving user rows as plain text', () => {
    const history = buildPriorTurnHistory([
      { role: 'user', plain_text: 'Is pH7Q effective against norovirus?', content: null },
      { role: 'assistant', plain_text: 'Yes — see the label.', content: assistantContent },
    ] as never);

    expect(history[0]).toEqual({
      role: 'user',
      content: 'Is pH7Q effective against norovirus?',
    });
    expect(history[1]?.role).toBe('assistant');
    expect(history[1]?.content).toBe('Yes — see the label.');
    expect(history[1]?.toolContext).toContain(PRIOR_TURN_TOOL_CONTEXT_HEADER);
  });
});

describe('runBexChatTurn — prior-turn tool context reaches the workflow (B0-378)', () => {
  beforeEach(() => {
    vi.mocked(createConversation).mockReset();
    vi.mocked(getConversationById).mockReset();
    vi.mocked(updateConversation).mockReset();
    vi.mocked(insertMessage).mockReset();
    vi.mocked(listMessagesForConversation).mockReset();
    vi.mocked(runProductSupportWorkflow).mockReset();

    vi.mocked(getConversationById).mockResolvedValue(baseConversation());
    vi.mocked(insertMessage).mockResolvedValue({} as never);
    vi.mocked(updateConversation).mockResolvedValue(undefined);
    vi.mocked(runProductSupportWorkflow).mockResolvedValue({ answerText: 'answer' } as never);
  });

  it('passes toolContext through on the assistant history entry', async () => {
    vi.mocked(listMessagesForConversation).mockResolvedValue([
      { role: 'user', plain_text: 'Is pH7Q effective against norovirus?', content: null },
      {
        role: 'assistant',
        plain_text: 'Yes — see the label.',
        content: {
          kind: 'assistant_turn',
          text: 'Yes — see the label.',
          toolSummary: [{ name: 'get_efficacy_data', ok: true }],
          sources: [{ documentId: 'doc-1', title: 'pH7Q Dual Label (US)', snippet: 's' }],
        },
      },
    ] as never);

    await runBexChatTurn({
      conversationId: CONVERSATION_ID,
      message: 'And what dilution did that use?',
      source: 'bex_chat',
    });

    const passed = vi.mocked(runProductSupportWorkflow).mock.calls[0]?.[0] as {
      priorMessages?: Array<{ role: string; content: string; toolContext?: string }>;
    };

    expect(passed.priorMessages?.[0]).toEqual({
      role: 'user',
      content: 'Is pH7Q effective against norovirus?',
    });
    expect(passed.priorMessages?.[1]?.toolContext).toContain('get_efficacy_data');
  });
});
