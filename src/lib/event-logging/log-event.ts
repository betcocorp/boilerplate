import { buildSentryPayloadForEvent } from '~/lib/event-logging/collect-sentry-context';
import { normalizeAnalyticsEventName } from '~/lib/event-logging/normalize-event-name';
import { getAnalyticsSessionId } from '~/lib/event-logging/session-id';
import type { EventLogRequestBody, EventLogResult } from '~/lib/event-logging/types';

async function resolveServerEventsLogUrl(): Promise<string> {
  try {
    const { headers } = await import('next/headers');
    const h = await headers();
    const host = h.get('x-forwarded-host') ?? h.get('host');
    if (host) {
      const proto =
        h.get('x-forwarded-proto') ??
        (process.env.NODE_ENV === 'production' ? 'https' : 'http');
      return `${proto}://${host}/api/events/log`;
    }
  } catch {
    // No request scope (e.g. instrumentation) or unsupported runtime.
  }

  const base = (
    process.env.NEXTAUTH_URL ??
    process.env.NEXT_PUBLIC_APP_URL ??
    'http://127.0.0.1:3000'
  ).replace(/\/$/, '');
  return `${base}/api/events/log`;
}

function buildPayload(
  event: string,
  meta?: Record<string, unknown>,
): EventLogRequestBody {
  const trimmed = normalizeAnalyticsEventName(event);
  const metaObject =
    meta != null && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  // B0-761: every client-originated event carries the per-browser-session id so
  // funnel queries can group one user session. Server-side calls have no
  // sessionStorage and are exempt in v1 (see session-id.ts); a caller-provided
  // sessionId is never overwritten.
  const sessionId = getAnalyticsSessionId();
  return {
    event: trimmed.slice(0, 512),
    sentry: buildSentryPayloadForEvent(),
    meta:
      sessionId != null && metaObject.sessionId == null
        ? { sessionId, ...metaObject }
        : metaObject,
  };
}

/**
 * Records a named application event in `public.event_logging`. Names are normalized
 * with an `analytics.` prefix when missing (see {@link normalizeAnalyticsEventName}).
 * Page views use `analytics.page.view*`. Stores a JSON snapshot of the current Sentry
 * scope, SDK metadata, optional active span, and browser hints. Optional `meta` is
 * stored as jsonb (same as `sentry`) for arbitrary context. The `POST /api/events/log`
 * handler resolves `user_id` and `session_id` from the session and payload so callers
 * do not need to pass them.
 *
 * On the client, `meta.sessionId` (per-browser-session UUID from sessionStorage) is added
 * automatically; server-side calls carry no session id in v1 (see {@link getAnalyticsSessionId}).
 *
 * Safe to call from Client Components, Server Components, Server Actions, and route handlers.
 * Failures are swallowed so analytics never break user flows.
 */
export async function logEvent(
  event: string,
  meta?: Record<string, unknown>,
): Promise<EventLogResult | void> {
  const payload = buildPayload(event, meta);
  if (!payload.event) return;

  const url =
    typeof window !== 'undefined'
      ? '/api/events/log'
      : await resolveServerEventsLogUrl();

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) return;

    const json = (await res.json()) as {
      success?: boolean;
      data?: EventLogResult;
    };
    if (json?.success && json.data) return json.data;
  } catch (err) {
    console.error('[logEvent] failed', err);
  }
}
