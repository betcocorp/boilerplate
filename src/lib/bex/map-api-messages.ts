import {
  assistantMessageContentSchema,
  userMessageContentSchema,
} from '~/lib/conversations/conversation-schemas';
import type { ChatMessage } from '~/types/bex';

type ApiMsg = {
  id: string;
  role: string;
  content: unknown;
  plainText?: string | null;
  createdAt: string;
  feedback?: {
    rating?: 'up' | 'down';
    reasonCode?: string | null;
    comment?: string | null;
    createdAt?: string;
    updatedAt?: string;
  } | null;
};

export function mapApiMessageToChatMessage(row: ApiMsg): ChatMessage {
  const createdAt = Date.parse(row.createdAt);
  const safeTime = Number.isFinite(createdAt) ? createdAt : Date.now();

  if (row.role === 'user') {
    const parsed = userMessageContentSchema.safeParse(row.content);
    const text =
      row.plainText?.trim() ||
      (parsed.success ? parsed.data.text : '') ||
      (typeof row.content === 'object' &&
      row.content &&
      'text' in row.content &&
      typeof (row.content as { text?: unknown }).text === 'string'
        ? (row.content as { text: string }).text
        : '') ||
      '';

    return {
      id: row.id,
      role: 'user',
      content: text,
      createdAt: safeTime,
    };
  }

  if (row.role === 'assistant') {
    const parsed = assistantMessageContentSchema.safeParse(row.content);
    const text =
      row.plainText?.trim() ||
      (parsed.success ? parsed.data.text : '') ||
      '';

    const meta =
      parsed.success
        ? {
            model: parsed.data.model,
            confidence: parsed.data.confidence,
            sources: parsed.data.sources,
            workflowRunId: parsed.data.workflowRunId,
            validation: parsed.data.validation
              ? {
                  approved: parsed.data.validation.approved,
                  requiresHumanReview:
                    parsed.data.validation.requiresHumanReview,
                  issues: parsed.data.validation.issues,
                }
              : undefined,
          }
        : undefined;

    return {
      id: row.id,
      role: 'assistant',
      content: text,
      createdAt: safeTime,
      workflowRunId: parsed.success ? parsed.data.workflowRunId : undefined,
      feedback:
        row.feedback && (row.feedback.rating === 'up' || row.feedback.rating === 'down')
          ? {
              rating: row.feedback.rating,
              reasonCode: row.feedback.reasonCode ?? null,
              comment: row.feedback.comment ?? null,
              createdAt: row.feedback.createdAt
                ? Date.parse(row.feedback.createdAt)
                : undefined,
              updatedAt: row.feedback.updatedAt
                ? Date.parse(row.feedback.updatedAt)
                : undefined,
            }
          : null,
      meta,
    };
  }

  return {
    id: row.id,
    role: 'assistant',
    content: row.plainText ?? JSON.stringify(row.content),
    createdAt: safeTime,
  };
}
