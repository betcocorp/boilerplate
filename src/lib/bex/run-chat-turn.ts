import { newCorrelationId } from '~/lib/observability/correlation-id';
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
import { runProductSupportWorkflow } from '~/lib/workflows/product-support/run-product-support-workflow';

export type BexChatTurnResult = Awaited<ReturnType<typeof runProductSupportWorkflow>> & {
  conversationId: string;
  traceId: string;
};

export async function runBexChatTurn(input: {
  conversationId?: string | null;
  message: string;
  modelTag?: string;
  useValidator?: boolean;
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
    modelTag: input.modelTag,
    useValidator: input.useValidator ?? false,
    previousOpenaiResponseId: conversation.latest_openai_response_id,
  });

  return {
    ...workflowOut,
    conversationId: conversation.id,
    traceId,
  };
}
