import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runBexChatTurn } from '~/lib/bex/run-chat-turn';
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
