import { z } from 'zod';

const chatOkSchema = z.object({
  ok: z.literal(true),
  traceId: z.string(),
  conversationId: z.string().uuid(),
  assistant: z.object({
    text: z.string(),
    sources: z
      .array(
        z.object({
          documentId: z.string(),
          chunkId: z.string().optional(),
          title: z.string(),
          snippet: z.string(),
          similarity: z.number().optional(),
        }),
      )
      .optional(),
    confidence: z.number().optional(),
    workflowRunId: z.string().uuid(),
    validation: z.object({
      approved: z.boolean(),
      confidence: z.number(),
      issues: z.array(z.string()),
      requires_human_review: z.boolean(),
    }),
    latestOpenaiResponseId: z.string(),
    routingDecision: z.string().optional(),
  }),
});

export type BexChatResponse = z.infer<typeof chatOkSchema>;

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

export async function apiPostBexChat(options: {
  conversationId?: string | null;
  message: string;
  model: string;
  useValidator?: boolean;
}): Promise<BexChatResponse> {
  const res = await fetch('/api/bex/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      conversationId: options.conversationId ?? undefined,
      message: options.message,
      model: options.model,
      useValidator: options.useValidator,
    }),
  });

  const data: unknown = await res.json();

  if (!res.ok) {
    throw new Error(
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error?: string }).error)
        : `Chat request failed (${res.status})`,
    );
  }

  const parsed = chatOkSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error('Unexpected chat response shape');
  }

  return parsed.data;
}
