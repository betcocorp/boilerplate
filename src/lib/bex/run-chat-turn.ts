import { z } from 'zod';

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
  type AgentMessageRow,
} from '~/lib/conversations/message-repository';
import {
  formatPriorTurnToolContext,
  type ReplayedHistoryMessage,
} from '~/lib/openai/responses-runtime';
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

/**
 * B0-378 — how many retrieved document titles one prior turn contributes to its replayed tool
 * context. A single answer routinely cites a dozen chunks across several documents; replaying all of
 * them for every prior turn would re-open the unbounded prompt growth `capConversationHistory`
 * (B0-519) exists to close. Eight is enough to name the products/labels a follow-up question is
 * likely to refer back to, and the block states how many were dropped.
 */
export const PRIOR_TURN_SOURCE_TITLE_LIMIT = 8;

/**
 * B0-378 — the two fields of a persisted assistant turn (`agent_messages.content`) that carry
 * recoverable tool information. Deliberately narrower and more forgiving than
 * `assistantMessageContentSchema`: this is best-effort context enrichment, so one malformed legacy
 * row must degrade to "no tool context" rather than fail the turn. `.catch([])` isolates each array,
 * so a bad `sources` entry does not also cost us `toolSummary`.
 */
const priorTurnToolFactsSchema = z.object({
  toolSummary: z.array(z.object({ name: z.string() })).catch([]),
  sources: z.array(z.object({ title: z.string() })).catch([]),
});

/**
 * B0-378 — recovers the prior turn's tool activity from one persisted assistant message.
 *
 * Returns the rendered summary block, or `null` when the row records no tool activity (an early
 * decline, a legacy row predating `toolSummary`, or anything unparseable).
 */
export function buildPriorTurnToolContext(content: unknown): string | null {
  const parsed = priorTurnToolFactsSchema.safeParse(content);
  if (!parsed.success) {
    return null;
  }

  const toolNames = [...new Set(parsed.data.toolSummary.map((tool) => tool.name))];
  const allTitles = [...new Set(parsed.data.sources.map((source) => source.title))];

  return formatPriorTurnToolContext({
    toolNames,
    sourceTitles: allTitles.slice(0, PRIOR_TURN_SOURCE_TITLE_LIMIT),
    omittedSourceCount: Math.max(0, allTitles.length - PRIOR_TURN_SOURCE_TITLE_LIMIT),
  });
}

/**
 * B0-378 — maps persisted conversation rows to the history both generation runtimes replay.
 *
 * The text-only `{ role, content }` mapping this replaces is where the AI SDK runtime lost every
 * prior turn's tool context: the Responses runtime got it back for free through
 * `previous_response_id`, the stateless AI SDK path simply never saw it. Assistant rows now also
 * carry a `toolContext` summary (see `buildPriorTurnToolContext`).
 *
 * NOTE on the wire: `runProductSupportWorkflow`'s `priorMessages` parameter is still declared as
 * `Array<{ role; content }>`, so `toolContext` travels as an undeclared-but-preserved extra property
 * (`capConversationHistory` shallow-copies the array, keeping the objects). It reaches the runtimes
 * intact and is dropped by every other consumer, which is exactly right — `priorTurnsForRouting`
 * re-maps to `{ id, role, content }`, so the intent classifier and semantic router see the same
 * clean text they saw before this ticket and no routing decision moves. Widening that parameter's
 * declared type to `ReplayedHistoryMessage[]` is the one-line follow-up that makes this explicit.
 */
export function buildPriorTurnHistory(
  rows: ReadonlyArray<Pick<AgentMessageRow, 'role' | 'plain_text' | 'content'>>,
): ReplayedHistoryMessage[] {
  return rows.map((row): ReplayedHistoryMessage => {
    const content = row.plain_text ?? '';
    if (row.role !== 'assistant') {
      return { role: 'user', content };
    }

    const toolContext = buildPriorTurnToolContext(row.content);
    return toolContext
      ? { role: 'assistant', content, toolContext }
      : { role: 'assistant', content };
  });
}

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
   * Who owns the conversation this turn creates, if any. Chat routes pass `{ kind: 'user', userId,
   * actedByUserId }` from `resolveConversationStamp()` — B0-1084: `userId` is the act-as-aware actor
   * and `actedByUserId` the true session user when acting-as (else null).
   * The test runner (B0-450) always passes `{ kind: 'system' }` so eval-harness conversations are
   * explicitly source='test_run', never attributed to whoever kicked off the run.
   *
   * Only consulted when no `conversationId` is supplied — continuing turns never re-stamp an
   * existing conversation.
   */
  owner?:
    | { kind: 'user'; userId: string; actedByUserId?: string | null }
    | { kind: 'system' };
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
        ? { user_id: input.owner.userId, acted_by_user_id: input.owner.actedByUserId ?? null }
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
    // B0-378 — carries each assistant turn's summarised tool context alongside its text, so the
    // stateless AI SDK runtime replays what the Responses chain remembers server-side.
    priorMessages: buildPriorTurnHistory(priorMessages),
    onEvent: input.onWorkflowEvent,
    onAssistantDelta: input.onAssistantDelta,
  });

  return {
    ...workflowOut,
    conversationId: conversation.id,
    traceId,
  };
}
