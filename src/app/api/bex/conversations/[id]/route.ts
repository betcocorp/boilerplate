import { NextResponse } from 'next/server';

import { getBexActor, type BexActor } from '~/lib/api/bex-actor';
import { hasBexSession } from '~/lib/api/bex-api-auth';
import { writeAuditLog } from '~/lib/audit/audit-log';
import { resolveConversationOwnerAttribution } from '~/lib/conversations/conversation-owner-view';
import {
  deleteConversation,
  getConversationById,
  getConversationOwnerInfo,
} from '~/lib/conversations/conversation-repository';
import { listMessageFeedbackForConversation } from '~/lib/conversations/message-feedback-repository';
import { listMessagesForConversation } from '~/lib/conversations/message-repository';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ id: string }> };

/** True when `actor` may read/manage `ownerUserId` (a conversation's `user_id`): owner, view-all, or service. */
function actorMayAccessConversation(
  actor: Exclude<BexActor, null>,
  ownerUserId: string | null,
): boolean {
  return (
    actor.kind === 'service' ||
    actor.canViewAll ||
    (actor.kind === 'user' && ownerUserId === actor.userId)
  );
}

async function auditAccessDenied(params: {
  conversationId: string;
  actor: Exclude<BexActor, null>;
  route: string;
}): Promise<void> {
  await writeAuditLog(
    'bex.conversation.access_denied',
    {
      conversationId: params.conversationId,
      requestedByUserId: params.actor.kind === 'user' ? params.actor.userId : null,
      route: params.route,
    },
    { traceId: newCorrelationId() },
  );
}

export async function GET(request: Request, ctx: RouteParams) {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.BEX_CHAT_USE,
    'GET /api/bex/conversations/[id]',
  );
  if (denied) return denied;

  const actor = await getBexActor(request);
  if (!actor) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;

  try {
    const conversation = await getConversationById(id);
    if (!conversation) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    if (!actorMayAccessConversation(actor, conversation.user_id)) {
      await auditAccessDenied({
        conversationId: id,
        actor,
        route: 'GET /api/bex/conversations/[id]',
      });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // B0-451 — owner join is only needed for a real (non-test-run) conversation that has a
    // user_id; skip the lookup otherwise rather than querying app_user for nothing.
    const ownerInfo =
      conversation.source !== 'test_run' && conversation.user_id
        ? await getConversationOwnerInfo(conversation.user_id)
        : { ownerName: null, ownerEmail: null };
    const attribution = resolveConversationOwnerAttribution(
      {
        source: conversation.source,
        user_id: conversation.user_id,
        ...ownerInfo,
      },
      actor,
    );

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
        owner: attribution.owner,
        source: attribution.source,
        isOwner: attribution.isOwner,
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

export async function DELETE(request: Request, ctx: RouteParams) {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.BEX_CHAT_USE,
    'DELETE /api/bex/conversations/[id]',
  );
  if (denied) return denied;

  const actor = await getBexActor(request);
  if (!actor) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await ctx.params;

  try {
    const existing = await getConversationById(id);
    if (!existing) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    if (!actorMayAccessConversation(actor, existing.user_id)) {
      await auditAccessDenied({
        conversationId: id,
        actor,
        route: 'DELETE /api/bex/conversations/[id]',
      });
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // B0-449 — view-all admins (and service callers) may delete conversations they don't own (e.g.
    // purging stray test-run rows); an admin_delete audit entry makes that traceable. `isOwner` is
    // false for a service actor too (ownership is always a user id), so a service-caller delete of
    // someone else's conversation is logged the same way.
    const isOwner = actor.kind === 'user' && existing.user_id === actor.userId;
    if (!isOwner) {
      await writeAuditLog(
        'bex.conversation.admin_delete',
        {
          conversationId: id,
          deletedByUserId: actor.kind === 'user' ? actor.userId : null,
          ownerUserId: existing.user_id,
        },
        { traceId: newCorrelationId() },
      );
    }

    await deleteConversation(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to delete conversation.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
