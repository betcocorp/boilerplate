import { NextResponse } from 'next/server';

import { getBexActor } from '~/lib/api/bex-actor';
import { hasBexSession } from '~/lib/api/bex-api-auth';
import { resolveConversationOwnerUserId } from '~/lib/conversations/conversation-owner';
import {
  createConversation,
  listAllConversations,
  listConversationsForUser,
} from '~/lib/conversations/conversation-repository';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.BEX_CHAT_USE,
    'GET /api/bex/conversations',
  );
  if (denied) return denied;

  // B0-449 — scoping actor (act-as-aware). A non-view-all user only ever sees their own
  // `source = 'chat'` rows; a service caller or a `bex.chat.view-all` admin sees everything.
  const actor = await getBexActor(request);
  if (!actor) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const rows =
      actor.kind === 'user' && !actor.canViewAll
        ? await listConversationsForUser(actor.userId, 80)
        : await listAllConversations({ limit: 80 });
    return NextResponse.json({
      ok: true,
      conversations: rows.map((c) => ({
        id: c.id,
        title: c.title,
        updatedAt: c.updated_at,
        status: c.status,
        latestModel: c.latest_model,
      })),
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to list conversations.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const denied = await gateRoute(
    PERMISSIONS.BEX_CHAT_USE,
    'POST /api/bex/conversations',
  );
  if (denied) return denied;

  const actor = await getBexActor(request);
  if (!actor) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // B0-449 — ownership stamping always uses the true authenticated owner (ignoring act-as), never
    // the scoping actor above. A missing match (no session-email/app_user row) falls back to the DB
    // default (user_id null, source 'chat') exactly as before.
    let row;
    if (actor.kind === 'service') {
      row = await createConversation();
    } else {
      const ownerUserId = await resolveConversationOwnerUserId();
      row = await createConversation(ownerUserId ? { user_id: ownerUserId } : undefined);
    }
    return NextResponse.json({
      ok: true,
      conversation: {
        id: row.id,
        title: row.title,
        updatedAt: row.updated_at,
      },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Failed to create conversation.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
