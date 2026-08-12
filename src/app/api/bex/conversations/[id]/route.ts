import { NextResponse } from 'next/server';

import { hasBexSession } from '~/lib/api/bex-api-auth';
import {
  deleteConversation,
  getConversationById,
} from '~/lib/conversations/conversation-repository';
import { listMessageFeedbackForConversation } from '~/lib/conversations/message-feedback-repository';
import { listMessagesForConversation } from '~/lib/conversations/message-repository';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(_request: Request, ctx: RouteParams) {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.BEX_CHAT_USE,
    'GET /api/bex/conversations/[id]',
  );
  if (denied) return denied;

  const { id } = await ctx.params;

  try {
    const conversation = await getConversationById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const [messages, feedbackRows] = await Promise.all([
      listMessagesForConversation(id),
      listMessageFeedbackForConversation(id),
    ]);
    const feedbackByMessageId = new Map(
      feedbackRows.map((row) => [row.message_id, row]),
    );

    return NextResponse.json({
      ok: true,
      conversation: {
        id: conversation.id,
        title: conversation.title,
        updatedAt: conversation.updated_at,
        latestOpenaiResponseId: conversation.latest_openai_response_id,
        latestModel: conversation.latest_model,
        status: conversation.status,
      },
      messages: messages.map((m) => ({
        feedback: feedbackByMessageId.has(m.id)
          ? {
              rating: feedbackByMessageId.get(m.id)?.rating,
              reasonCode: feedbackByMessageId.get(m.id)?.reason_code,
              comment: feedbackByMessageId.get(m.id)?.comment,
              createdAt: feedbackByMessageId.get(m.id)?.created_at,
              updatedAt: feedbackByMessageId.get(m.id)?.updated_at,
            }
          : null,
        id: m.id,
        role: m.role,
        content: m.content,
        plainText: m.plain_text,
        createdAt: m.created_at,
        toolName: m.tool_name,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to load conversation.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(_request: Request, ctx: RouteParams) {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.BEX_CHAT_USE,
    'DELETE /api/bex/conversations/[id]',
  );
  if (denied) return denied;

  const { id } = await ctx.params;

  try {
    const existing = await getConversationById(id);
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    await deleteConversation(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to delete conversation.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
