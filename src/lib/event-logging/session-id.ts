/**
 * Analytics session id (B0-761).
 *
 * A UUID minted once per browser session and carried as `meta.sessionId` on every
 * client-originated `logEvent()` call (injected centrally in log-event.ts, so call
 * sites never have to remember it). Stored in `sessionStorage`, so it is stable
 * across in-tab navigation and reloads, while a new tab/window starts a new session.
 *
 * Server-side calls (Server Components, Server Actions, route handlers) have no
 * `sessionStorage` and are explicitly EXEMPT from carrying a session id in v1.
 * The funnels this powers (page views, chat sends, search submits, result clicks)
 * originate entirely client-side, so exempting server-only events loses nothing the
 * funnels need. Revisit (header/cookie propagation) only if a funnel metric ever
 * depends on a server-only event.
 */

export const ANALYTICS_SESSION_STORAGE_KEY = 'analytics.sessionId';

function generateSessionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID (e.g. non-secure
  // contexts). Non-cryptographic — fine for analytics correlation.
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Returns the analytics session id for this browser session, minting and
 * persisting one on first use. Returns `null` on the server or when
 * `sessionStorage` is unavailable (e.g. blocked by privacy settings) — callers
 * treat `null` as "no session id" and omit the field.
 */
export function getAnalyticsSessionId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const existing = window.sessionStorage.getItem(ANALYTICS_SESSION_STORAGE_KEY);
    if (existing != null && existing.trim() !== '') return existing;
    const id = generateSessionId();
    window.sessionStorage.setItem(ANALYTICS_SESSION_STORAGE_KEY, id);
    return id;
  } catch {
    // sessionStorage can throw (disabled, quota, iframe sandbox). Analytics
    // must never break user flows — degrade to "no session id".
    return null;
  }
}
