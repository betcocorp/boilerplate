import type { BexChatAgentMode } from '~/lib/agents/agent-registry';
import { logEvent } from '~/lib/event-logging/log-event';

/**
 * Payload builders for the Bex chat surface events (B0-761).
 *
 * Privacy: the same rule as search-events.ts — user free text is NEVER logged.
 * The prompt is reduced to `promptLength`, and feedback carries only the rating
 * and (when present) the structured `reasonCode`; the free-text comment is
 * deliberately excluded. Adding either would need a separate, explicit decision
 * on retention and access.
 */

export const BEX_CHAT_MESSAGE_SENT_EVENT = 'analytics.bex.chat.message.sent';
export const BEX_CHAT_CONVERSATION_CREATED_EVENT =
  'analytics.bex.chat.conversation.created';
export const BEX_CHAT_CONVERSATION_DELETED_EVENT =
  'analytics.bex.chat.conversation.deleted';
export const BEX_CHAT_FEEDBACK_SUBMITTED_EVENT =
  'analytics.bex.chat.feedback.submitted';
export const BEX_CHAT_CONVERSATION_EXPORTED_EVENT =
  'analytics.bex.chat.conversation.exported';

/** JSON-safe extra context. Never put prompt or comment text here. */
type BexEventExtra = Record<string, string | number | boolean>;

/** Thumbs rating stored on a chat message (`ChatMessage.feedback.rating`). */
export type BexFeedbackRating = 'up' | 'down';

type BuiltEvent = { event: string; meta: Record<string, unknown> };

export type BexChatMessageSentArgs = {
  conversationId: string;
  /** Length of the trimmed prompt. The prompt text itself is never logged. */
  promptLength: number;
  model: string;
  agentMode: BexChatAgentMode;
  useValidator: boolean;
  extra?: BexEventExtra;
};

export type BexChatConversationArgs = {
  conversationId: string;
  extra?: BexEventExtra;
};

export type BexChatFeedbackArgs = {
  conversationId: string;
  messageId: string;
  rating: BexFeedbackRating;
  /** Structured reason from the feedback picker. The free-text comment is never logged. */
  reasonCode?: string | null;
  extra?: BexEventExtra;
};

export type BexChatConversationExportArgs = {
  conversationId: string;
  /** Export target, e.g. 'markdown' | 'json'. */
  format: string;
  extra?: BexEventExtra;
};

/** Coerces to a non-negative integer; invalid input becomes 0. */
function toCount(value: number): number {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export function buildBexChatMessageSentEvent(
  args: BexChatMessageSentArgs,
): BuiltEvent {
  const { conversationId, promptLength, model, agentMode, useValidator, extra } = args;
  return {
    event: BEX_CHAT_MESSAGE_SENT_EVENT,
    meta: {
      ...extra,
      conversationId,
      promptLength: toCount(promptLength),
      model,
      agentMode,
      useValidator,
    },
  };
}

export function buildBexChatConversationCreatedEvent(
  args: BexChatConversationArgs,
): BuiltEvent {
  return {
    event: BEX_CHAT_CONVERSATION_CREATED_EVENT,
    meta: { ...args.extra, conversationId: args.conversationId },
  };
}

export function buildBexChatConversationDeletedEvent(
  args: BexChatConversationArgs,
): BuiltEvent {
  return {
    event: BEX_CHAT_CONVERSATION_DELETED_EVENT,
    meta: { ...args.extra, conversationId: args.conversationId },
  };
}

export function buildBexChatFeedbackSubmittedEvent(
  args: BexChatFeedbackArgs,
): BuiltEvent {
  const { conversationId, messageId, rating, reasonCode, extra } = args;
  return {
    event: BEX_CHAT_FEEDBACK_SUBMITTED_EVENT,
    meta: {
      ...extra,
      conversationId,
      messageId,
      rating,
      // Omitted entirely when absent so the field is never a null in jsonb.
      ...(reasonCode != null && reasonCode !== '' ? { reasonCode } : {}),
    },
  };
}

export function buildBexChatConversationExportedEvent(
  args: BexChatConversationExportArgs,
): BuiltEvent {
  return {
    event: BEX_CHAT_CONVERSATION_EXPORTED_EVENT,
    meta: {
      ...args.extra,
      conversationId: args.conversationId,
      format: args.format,
    },
  };
}

/** Fire-and-forget `analytics.bex.chat.message.sent`. */
export function logBexChatMessageSent(args: BexChatMessageSentArgs): void {
  const { event, meta } = buildBexChatMessageSentEvent(args);
  void logEvent(event, meta);
}

/** Fire-and-forget `analytics.bex.chat.conversation.created`. */
export function logBexChatConversationCreated(args: BexChatConversationArgs): void {
  const { event, meta } = buildBexChatConversationCreatedEvent(args);
  void logEvent(event, meta);
}

/** Fire-and-forget `analytics.bex.chat.conversation.deleted`. */
export function logBexChatConversationDeleted(args: BexChatConversationArgs): void {
  const { event, meta } = buildBexChatConversationDeletedEvent(args);
  void logEvent(event, meta);
}

/** Fire-and-forget `analytics.bex.chat.feedback.submitted`. */
export function logBexChatFeedbackSubmitted(args: BexChatFeedbackArgs): void {
  const { event, meta } = buildBexChatFeedbackSubmittedEvent(args);
  void logEvent(event, meta);
}

/** Fire-and-forget `analytics.bex.chat.conversation.exported`. */
export function logBexChatConversationExported(
  args: BexChatConversationExportArgs,
): void {
  const { event, meta } = buildBexChatConversationExportedEvent(args);
  void logEvent(event, meta);
}
