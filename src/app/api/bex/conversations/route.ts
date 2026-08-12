import { NextResponse } from 'next/server';
import { z } from 'zod';

import { getBexActor } from '~/lib/api/bex-actor';
import { hasBexSession } from '~/lib/api/bex-api-auth';
import { resolveConversationOwnerAttribution } from '~/lib/conversations/conversation-owner-view';
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

/**
 * B0-451 — `source`/`userFilter` are honored only on the view-all-or-service branch of GET below;
 * an invalid value here is treated as "not supplied" rather than a 400, since these are optional
 * narrowing filters, not required input.
 */
const conversationsQuerySchema = z.object({
  source: z.enum(['chat', 'test_run']).optional(),
  userFilter: z.string().trim().min(1).optional(),
});

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
    // B0-451 — a non-view-all user's own list is always their own `source = 'chat'` rows: owner is
    // by construction `null` ("me") and `isOwner` is always true, so there is no need to run the
    // owner-join query for these rows.
    if (actor.kind === 'user' && !actor.canViewAll) {
      const rows = await listConversationsForUser(actor.userId, 80);
      return NextResponse.json({
        ok: true,
        conversations: rows.map((c) => ({
          id: c.id,
          title: c.title,
          updatedAt: c.updated_at,
          status: c.status,
          latestModel: c.latest_model,
          owner: null,
          source: 'chat' as const,
          isOwner: true,
        })),
      });
    }

    // B0-451 — `source`/`userFilter` only apply here (view-all admin or service caller); a
    // non-admin's request never reaches this branch, so a client-supplied query param can never
    // widen their visibility.
    const url = new URL(request.url);
    const parsedQuery = conversationsQuerySchema.safeParse({
      source: url.searchParams.get('source') ?? undefined,
      userFilter: url.searchParams.get('userFilter') ?? undefined,
    });
    const query = parsedQuery.success ? parsedQuery.data : {};

    const rows = await listAllConversations({
      limit: 80,
      ...(query.source ? { source: query.source } : {}),
      ...(query.userFilter ? { userFilter: query.userFilter } : {}),
    });
    return NextResponse.json({
      ok: true,
      conversations: rows.map((c) => {
        const attribution = resolveConversationOwnerAttribution(c, actor);
        return {
          id: c.id,
          title: c.title,
          updatedAt: c.updated_at,
          status: c.status,
          latestModel: c.latest_model,
          owner: attribution.owner,
          source: attribution.source,
          isOwner: attribution.isOwner,
        };
      }),
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
