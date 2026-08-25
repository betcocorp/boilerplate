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
  type RouterTypeOverride,
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
  /** B0-681 — see `RouterTypeOverride`. Only the test-run workbench passes this. */
  routerTypeOverride?: RouterTypeOverride;
  /**
   * Who owns the conversation this turn creates, if any. Chat routes resolve
   * `resolveConversationOwnerUserId()` and pass `{ kind: 'user', userId }` when it resolves, or omit
   * `owner` entirely when it doesn't (falls back to the DB default: user_id null, source 'chat').
   * The test runner (B0-450) always passes `{ kind: 'system' }` so eval-harness conversations are
   * explicitly source='test_run', never attributed to whoever kicked off the run.
   *
   * Only consulted when no `conversationId` is supplied — continuing turns never re-stamp an
   * existing conversation.
   */
  owner?: { kind: 'user'; userId: string } | { kind: 'system' };
  /**
   * B0-645 — the source test's `tests.name`, stamped onto the conversation at creation for
   * `owner: { kind: 'system' }` turns so the admin sidebar can show which test produced it instead
   * of a generic "Admin" badge. Ignored for `owner: { kind: 'user' }`/no-owner turns, and only
   * consulted alongside `owner` (i.e. only when no `conversationId` is supplied).
   */
  testName?: string | null;
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
    conversation = await createConversation(
      input.owner?.kind === 'user'
        ? { user_id: input.owner.userId }
        : input.owner?.kind === 'system'
          ? { user_id: null, source: 'test_run', test_name: input.testName ?? null }
          : undefined,
    );
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
    routerTypeOverride: input.routerTypeOverride,
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
