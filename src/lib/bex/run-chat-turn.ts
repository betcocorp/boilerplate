import { newCorrelationId } from '~/lib/observability/correlation-id';
import {
  DEFAULT_BEX_CHAT_AGENT_MODE,
  type BexChatAgentMode,
} from '~/lib/agents/agent-registry';
import {
  createConversation,
  getConversationById,
  updateConversation,
} from '~/lib/conversations/conversation-repository';
import {
  insertMessage,
  jsonContent,
  listMessagesForConversation,
} from '~/lib/conversations/message-repository';
import {
  runProductSupportWorkflow,
  type ProductSupportWorkflowEvent,
} from '~/lib/workflows/product-support/run-product-support-workflow';

import type { RunSource } from '~/types/observability';

export type BexChatTurnResult = Awaited<ReturnType<typeof runProductSupportWorkflow>> & {
  conversationId: string;
  traceId: string;
};

export async function runBexChatTurn(input: {
  conversationId?: string | null;
  message: string;
  /**
   * B0-416 — which entry point is driving this turn (`'harness'` for the golden-set runner,
   * `'bex_chat'` for `/api/bex/chat/stream`, `'orchestrator_api'` for `/api/v1/orchestrator`).
   * Passed straight through to `workflow_runs.source`; required so every caller has to say.
   */
  source: RunSource;
  modelTag?: string;
  useValidator?: boolean;
  agentMode?: BexChatAgentMode;
  onWorkflowEvent?: (event: ProductSupportWorkflowEvent) => void;
  onAssistantDelta?: (delta: string) => void;
}): Promise<BexChatTurnResult> {
  const traceId = newCorrelationId();
  const trimmed = input.message.trim();

  let conversation =
    input.conversationId != null
      ? await getConversationById(input.conversationId)
      : null;

  if (!conversation) {
    conversation = await createConversation();
  }

  const priorMessages = await listMessagesForConversation(conversation.id);
  const isFirstUserMessage = priorMessages.length === 0;

  if (isFirstUserMessage) {
    const title =
      `${trimmed.slice(0, 56)}${trimmed.length > 56 ? '…' : ''}` || 'New conversation';
    await updateConversation(conversation.id, { title });
    conversation = { ...conversation, title };
  }

  await insertMessage({
    conversation_id: conversation.id,
    role: 'user',
    plain_text: trimmed,
    content: jsonContent({ kind: 'user_turn', text: trimmed }),
  });

  const workflowOut = await runProductSupportWorkflow({
    traceId,
    conversationId: conversation.id,
    userMessage: trimmed,
    source: input.source,
    modelTag: input.modelTag,
    useValidator: input.useValidator ?? false,
    agentMode: input.agentMode ?? DEFAULT_BEX_CHAT_AGENT_MODE,
    previousOpenaiResponseId: conversation.latest_openai_response_id,
    priorMessages: priorMessages.map((message) => ({
      role: message.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: message.plain_text ?? '',
    })),
    onEvent: input.onWorkflowEvent,
    onAssistantDelta: input.onAssistantDelta,
  });

  return {
    ...workflowOut,
    conversationId: conversation.id,
    traceId,
  };
}
