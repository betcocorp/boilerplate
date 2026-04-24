import { z } from 'zod';
import { BEX_CHAT_AGENT_MODES } from '~/lib/agents/agent-registry';

export const bexChatPostBodySchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    message: z.string().min(1).max(16_000),
    model: z.string().max(128).optional(),
    useValidator: z.boolean().optional(),
    agentMode: z.enum(BEX_CHAT_AGENT_MODES).optional(),
  })
  .strip();

export type BexChatPostBody = z.infer<typeof bexChatPostBodySchema>;

export const sourceRefSchema = z.object({
  documentId: z.string(),
  chunkId: z.string().optional(),
  title: z.string(),
  snippet: z.string().max(2000),
  similarity: z.number().optional(),
});

export type SourceRef = z.infer<typeof sourceRefSchema>;

export const assistantMessageContentSchema = z.object({
  kind: z.literal('assistant_turn'),
  text: z.string(),
  model: z.string().optional(),
  sources: z.array(sourceRefSchema).optional(),
  confidence: z.number().min(0).max(1).optional(),
  workflowRunId: z.string().uuid().optional(),
  routingHint: z
    .object({
      decision: z.string(),
      rationale: z.string().optional(),
    })
    .optional(),
  validation: z
    .object({
      approved: z.boolean(),
      issues: z.array(z.string()),
      requiresHumanReview: z.boolean(),
    })
    .optional(),
  toolSummary: z
    .array(
      z.object({
        name: z.string(),
        ok: z.boolean(),
      }),
    )
    .optional(),
});

export type AssistantMessageContent = z.infer<typeof assistantMessageContentSchema>;

export const userMessageContentSchema = z.object({
  kind: z.literal('user_turn'),
  text: z.string(),
});

export type UserMessageContent = z.infer<typeof userMessageContentSchema>;

export const agentMessageContentSchema = z.union([
  assistantMessageContentSchema,
  userMessageContentSchema,
]);
