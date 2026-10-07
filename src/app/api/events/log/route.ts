import { NextResponse } from 'next/server';

import { hasBexSession } from '~/lib/api/bex-api-auth';
import { getUserOrDefault } from '~/lib/cookies-server';
import { normalizeAnalyticsEventName } from '~/lib/event-logging/normalize-event-name';
import { eventLogRequestBodySchema } from '~/lib/event-logging/types';
import { getCurrentUserPermissionGroups } from '~/lib/permissions/permissions-server';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { Json } from '~/types/supabase.public';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Room for event + sentry + meta; mirrors c360's cap on the same payload. */
const MAX_BODY_CHARS = 450_000;
/** c360 stores SESSION_ID as VARCHAR(64); truncation beats a failed insert. */
const MAX_SESSION_ID_CHARS = 64;
const MAX_EVENT_CHARS = 512;

/** Identity keys the server owns outright — a client-supplied value is never persisted. */
const SERVER_OWNED_META_KEYS = [
  'userId',
  'email',
  'name',
  'permission_groups',
] as const;

function sanitizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * B0-761 — analytics ingest for the bex UI.
 *
 * In c360 the browser posts here and this route forwards to the Express `/events/log` service; bex
 * is a single full-stack app, so that hop collapses and the row is written straight to Supabase
 * with the service-role client (`public.event_logging` is RLS-enabled with no policies).
 *
 * This is a browser surface only — a NextAuth session is required and there is deliberately no
 * service-token path, so machine callers cannot manufacture user analytics.
 */
export async function POST(request: Request) {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return NextResponse.json({ error: 'Invalid body' }, { status: 400 });
  }

  if (text.length > MAX_BODY_CHARS) {
    return NextResponse.json({ error: 'Body too large' }, { status: 413 });
  }

  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const parsed = eventLogRequestBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request body', issues: parsed.error.issues },
      { status: 400 },
    );
  }

  const event = normalizeAnalyticsEventName(parsed.data.event).slice(
    0,
    MAX_EVENT_CHARS,
  );
  if (!event) {
    return NextResponse.json({ error: 'event required' }, { status: 400 });
  }

  // Strip the server-owned identity keys *before* enrichment, so a client's self-reported identity
  // is dropped even if the enrichment below fails — the client never gets to claim who it is.
  const meta: Record<string, unknown> = { ...parsed.data.meta };
  for (const key of SERVER_OWNED_META_KEYS) {
    delete meta[key];
  }

  let userId: string | null = null;
  try {
    const user = await getUserOrDefault();
    userId = sanitizeString(user?.USER_ID);
    const email = sanitizeString(user?.EMAIL);
    const name = sanitizeString(user?.NAME);
    const permissionGroups = await getCurrentUserPermissionGroups();

    meta.userId = userId;
    meta.email = email;
    meta.name = name;
    meta.permission_groups = permissionGroups;
  } catch (error) {
    // Never block logging on enrichment failure.
    console.error('[api/events/log] actor enrichment failed', error);
  }

  // Denormalized columns kept in step with the meta payload they came from (c360 does the same
  // derivation in-SQL), so dashboards can filter without unpacking jsonb.
  const sessionId =
    sanitizeString(meta.sessionId)?.slice(0, MAX_SESSION_ID_CHARS) ?? null;

  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('event_logging')
      .insert({
        event,
        sentry: parsed.data.sentry as Json,
        meta: meta as Json,
        user_id: userId,
        session_id: sessionId,
      })
      .select('id, event, created_at')
      .single();

    if (error || !data) {
      console.error('[api/events/log] insert failed', error);
      return NextResponse.json(
        { error: 'Failed to log event' },
        { status: 500 },
      );
    }

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('[api/events/log]', error);
    return NextResponse.json({ error: 'Failed to log event' }, { status: 500 });
  }
}
