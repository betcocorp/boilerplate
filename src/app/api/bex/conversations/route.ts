import { NextResponse } from 'next/server';

import { hasBexSession } from '~/lib/api/bex-api-auth';
import {
  createConversation,
  listConversations,
} from '~/lib/conversations/conversation-repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const rows = await listConversations(80);
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

export async function POST() {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const row = await createConversation();
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
