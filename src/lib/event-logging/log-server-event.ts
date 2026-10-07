import { normalizeAnalyticsEventName } from '~/lib/event-logging/normalize-event-name';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { Json } from '~/types/supabase.public';

const MAX_EVENT_CHARS = 512;
const MAX_SESSION_ID_CHARS = 64;

function sanitizeString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Server-side sibling of `logEvent` (B0-761) — writes `public.event_logging` directly.
 *
 * `logEvent` posts to `POST /api/events/log`, which requires a NextAuth session. From the browser
 * that is free (the cookie rides along); from server code it is not — a server-issued `fetch`
 * carries no cookies, so the route would answer 401 and `logEvent` would swallow it. The event
 * would silently never be written.
 *
 * That matters most exactly where c360 logs from the server: the sign-in callbacks, which run
 * before any session cookie exists at all. c360 gets away with the HTTP hop because its route has
 * no auth gate; this app's does (deliberately — machine callers must not be able to manufacture user
 * analytics), so server callers write straight to the table instead.
 *
 * The caller supplies actor identity explicitly here. There is no cookie-based enrichment to fall
 * back on: `getUserOrDefault()` reads a cookie this code path is upstream of.
 *
 * Never throws — analytics must not break a sign-in.
 */
export async function logServerEvent(
  event: string,
  meta: Record<string, unknown> = {},
): Promise<void> {
  const normalized = normalizeAnalyticsEventName(event).slice(0, MAX_EVENT_CHARS);
  if (!normalized) return;

  try {
    const supabase = getSupabaseServiceRoleClient();
    const { error } = await supabase.from('event_logging').insert({
      event: normalized,
      sentry: {} as Json,
      meta: meta as Json,
      user_id: sanitizeString(meta.userId),
      session_id: sanitizeString(meta.sessionId)?.slice(0, MAX_SESSION_ID_CHARS) ?? null,
    });
    if (error) {
      console.error('[logServerEvent] insert failed', {
        event: normalized,
        message: error.message,
      });
    }
  } catch (err) {
    console.error('[logServerEvent] failed', { event: normalized, err });
  }
}
