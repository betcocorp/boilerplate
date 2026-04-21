import { NextResponse } from 'next/server';
import { z } from 'zod';

import { canReadBexConversations } from '~/lib/api/bex-api-auth';
import { upsertMessageFeedback } from '~/lib/conversations/message-feedback-repository';
import { getMessageById } from '~/lib/conversations/message-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const feedbackBodySchema = z
  .object({
    rating: z.enum(['up', 'down']),
    reasonCode: z
      .string()
      .trim()
      .max(80)
      .optional(),
    comment: z
      .string()
      .trim()
      .max(2000)
      .optional(),
  })
  .strip();

type RouteParams = { params: Promise<{ id: string }> };

export async function POST(request: Request, ctx: RouteParams) {
  if (!canReadBexConversations(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id: messageId } = await ctx.params;

  let body: unknown = {};
  try {
    body = await request.json();
  } catch {
    body = {};
  }

  const parsed = feedbackBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  try {
    const message = await getMessageById(messageId);
    if (!message) {
      return NextResponse.json({ error: 'Message not found' }, { status: 404 });
    }
    if (message.role !== 'assistant') {
      return NextResponse.json(
        { error: 'Feedback is only supported on assistant messages' },
        { status: 400 },
      );
    }

    const content =
      message.content && typeof message.content === 'object' && !Array.isArray(message.content)
        ? (message.content as Record<string, unknown>)
        : null;
    const workflowRunId =
      content && typeof content.workflowRunId === 'string' ? content.workflowRunId : null;

    const feedback = await upsertMessageFeedback({
      messageId: message.id,
      conversationId: message.conversation_id,
      workflowRunId,
      rating: parsed.data.rating,
      reasonCode: parsed.data.reasonCode,
      comment: parsed.data.comment,
    });

    return NextResponse.json({
      ok: true,
      feedback: {
        messageId: feedback.message_id,
        rating: feedback.rating,
        reasonCode: feedback.reason_code,
        comment: feedback.comment,
        createdAt: feedback.created_at,
        updatedAt: feedback.updated_at,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to save feedback.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
