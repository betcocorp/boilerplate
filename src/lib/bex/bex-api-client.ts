import { z } from 'zod';

export type BexChatStreamResponse = {
  conversationId: string;
  traceId: string;
  assistantText: string;
  workflowRunId?: string;
  latestOpenaiResponseId?: string;
  routingDecision?: string;
  streamMetrics?: {
    totalMs: number;
    timeToFirstTokenMs: number | null;
    deltaCount: number;
    usedFallbackChunking: boolean;
  };
};

const conversationListSchema = z.object({
  ok: z.literal(true),
  conversations: z.array(
    z.object({
      id: z.string().uuid(),
      title: z.string(),
      updatedAt: z.string(),
      status: z.string(),
      latestModel: z.string().nullable().optional(),
    }),
  ),
});

const conversationDetailSchema = z.object({
  ok: z.literal(true),
  conversation: z.object({
    id: z.string().uuid(),
    title: z.string(),
    updatedAt: z.string(),
    latestOpenaiResponseId: z.string().nullable().optional(),
    latestModel: z.string().nullable().optional(),
    status: z.string(),
  }),
  messages: z.array(
    z.object({
      id: z.string().uuid(),
      role: z.string(),
      content: z.unknown(),
      plainText: z.string().nullable().optional(),
      createdAt: z.string(),
      toolName: z.string().nullable().optional(),
      feedback: z
        .object({
          rating: z.enum(['up', 'down']),
          reasonCode: z.string().nullable().optional(),
          comment: z.string().nullable().optional(),
          createdAt: z.string().optional(),
          updatedAt: z.string().optional(),
        })
        .nullable()
        .optional(),
    }),
  ),
});

export async function apiListConversations(): Promise<
  z.infer<typeof conversationListSchema>['conversations']
> {
  const res = await fetch('/api/bex/conversations', { method: 'GET' });
  const data: unknown = await res.json();
  if (!res.ok) {
    throw new Error(
      data &&
        typeof data === 'object' &&
        'error' in data &&
        typeof (data as { error?: unknown }).error === 'string'
        ? (data as { error: string }).error
        : `Request failed (${res.status})`,
    );
  }
  const parsed = conversationListSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error('Unexpected conversation list response');
  }
  return parsed.data.conversations;
}

export async function apiCreateConversation(): Promise<string> {
  const res = await fetch('/api/bex/conversations', { method: 'POST' });
  const data: unknown = await res.json();
  if (!res.ok) {
    throw new Error(
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error?: string }).error)
        : `Request failed (${res.status})`,
    );
  }
  const parsed = z
    .object({
      ok: z.literal(true),
      conversation: z.object({ id: z.string().uuid() }),
    })
    .safeParse(data);
  if (!parsed.success) {
    throw new Error('Unexpected create conversation response');
  }
  return parsed.data.conversation.id;
}

export async function apiFetchConversation(id: string) {
  const res = await fetch(`/api/bex/conversations/${id}`, { method: 'GET' });
  const data: unknown = await res.json();
  if (!res.ok) {
    throw new Error(
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error?: string }).error)
        : `Request failed (${res.status})`,
    );
  }
  const parsed = conversationDetailSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error('Unexpected conversation detail response');
  }
  return parsed.data;
}

export async function apiDeleteConversation(id: string): Promise<void> {
  const res = await fetch(`/api/bex/conversations/${id}`, { method: 'DELETE' });
  if (!res.ok) {
    const data: unknown = await res.json();
    throw new Error(
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error?: string }).error)
        : `Request failed (${res.status})`,
    );
  }
}

export async function apiSubmitMessageFeedback(input: {
  messageId: string;
  rating: 'up' | 'down';
  reasonCode?: string;
  comment?: string;
}): Promise<void> {
  const res = await fetch(`/api/bex/messages/${input.messageId}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      rating: input.rating,
      reasonCode: input.reasonCode,
      comment: input.comment,
    }),
  });

  const data: unknown = await res.json();
  if (!res.ok) {
    throw new Error(
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error?: string }).error)
        : `Request failed (${res.status})`,
    );
  }
}

function extractStreamMeta(
  data: unknown,
): Omit<BexChatStreamResponse, 'assistantText'> | null {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const candidate = data as {
    traceId?: unknown;
    conversationId?: unknown;
    workflowRunId?: unknown;
    latestOpenaiResponseId?: unknown;
    routingDecision?: unknown;
    streamMetrics?: unknown;
  };

  if (
    typeof candidate.traceId !== 'string' ||
    typeof candidate.conversationId !== 'string'
  ) {
    return null;
  }

  return {
    traceId: candidate.traceId,
    conversationId: candidate.conversationId,
    workflowRunId:
      typeof candidate.workflowRunId === 'string'
        ? candidate.workflowRunId
        : undefined,
    latestOpenaiResponseId:
      typeof candidate.latestOpenaiResponseId === 'string'
        ? candidate.latestOpenaiResponseId
        : undefined,
    routingDecision:
      typeof candidate.routingDecision === 'string'
        ? candidate.routingDecision
        : undefined,
    streamMetrics:
      candidate.streamMetrics &&
      typeof candidate.streamMetrics === 'object' &&
      typeof (candidate.streamMetrics as { totalMs?: unknown }).totalMs === 'number' &&
      typeof (candidate.streamMetrics as { deltaCount?: unknown }).deltaCount === 'number' &&
      typeof (candidate.streamMetrics as { usedFallbackChunking?: unknown }).usedFallbackChunking ===
        'boolean'
        ? {
            totalMs: (candidate.streamMetrics as { totalMs: number }).totalMs,
            timeToFirstTokenMs:
              typeof
                (candidate.streamMetrics as { timeToFirstTokenMs?: unknown })
                  .timeToFirstTokenMs === 'number'
                ? (candidate.streamMetrics as { timeToFirstTokenMs: number })
                    .timeToFirstTokenMs
                : null,
            deltaCount: (candidate.streamMetrics as { deltaCount: number }).deltaCount,
            usedFallbackChunking: (
              candidate.streamMetrics as { usedFallbackChunking: boolean }
            ).usedFallbackChunking,
          }
        : undefined,
  };
}

export async function apiPostBexChatStream(options: {
  conversationId?: string | null;
  message: string;
  model: string;
  useValidator?: boolean;
  agentMode?: 'orchestrator' | 'product' | 'bathroom' | 'dilution' | 'floor';
  onTextDelta?: (delta: string) => void;
  onEvent?: (event: unknown) => void;
}): Promise<BexChatStreamResponse> {
  const rolloutCohort = process.env.NEXT_PUBLIC_BEX_STREAMING_ROLLOUT_COHORT?.trim();
  const res = await fetch('/api/bex/chat/stream', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(rolloutCohort ? { 'x-bex-streaming-cohort': rolloutCohort } : {}),
    },
    body: JSON.stringify({
      conversationId: options.conversationId ?? undefined,
      message: options.message,
      model: options.model,
      useValidator: options.useValidator,
      agentMode: options.agentMode,
    }),
  });

  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null);
    throw new Error(
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error?: string }).error)
        : `Chat stream request failed (${res.status})`,
    );
  }

  if (!res.body) {
    throw new Error('Streaming response did not include a body.');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let assistantText = '';
  let meta: Omit<BexChatStreamResponse, 'assistantText'> | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) {
        continue;
      }

      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') {
        continue;
      }

      try {
        const chunk = JSON.parse(payload) as {
          type?: unknown;
          delta?: unknown;
          data?: unknown;
        };

        if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
          assistantText += chunk.delta;
          options.onTextDelta?.(chunk.delta);
        }

        if (chunk.type === 'data-bex-meta') {
          const parsedMeta = extractStreamMeta(chunk.data);
          if (parsedMeta) {
            meta = parsedMeta;
          }
        }

        if (chunk.type === 'data-bex-event') {
          options.onEvent?.(chunk.data);
        }
      } catch {
        // Ignore malformed chunks to preserve stream resilience.
      }
    }
  }

  if (!meta) {
    throw new Error('Streaming response missing conversation metadata.');
  }

  return {
    ...meta,
    assistantText,
  };
}
