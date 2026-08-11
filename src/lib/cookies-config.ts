// Shared cookie configuration - used by both server and client
export const SELECTED_USER_COOKIE = 'selected-user-details';
export const AUTH_USER_DETAILS_COOKIE = 'auth-user-details';

/**
 * Short-lived circuit breaker set by `/api/auth/rebuild-user` when it could not rebuild the
 * auth-user cookie. `src/proxy.ts` skips its redirect while this is present, so a user whose record
 * is missing (expected in shadow mode) keeps browsing instead of bouncing in a redirect loop.
 */
export const AUTH_USER_REBUILD_FAILED_COOKIE = 'auth-user-rebuild-failed';

/** How long the rebuild breaker suppresses further rebuild attempts (seconds). */
export const AUTH_USER_REBUILD_BREAKER_MAX_AGE_SECONDS = 60;

const DEFAULT_AUTH_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

function resolveSessionMaxAge(): number {
  const parsed = Number(process.env.AUTH_SESSION_MAX_AGE_SECONDS);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_AUTH_SESSION_MAX_AGE_SECONDS;
}

/**
 * Session lifetime (seconds): NextAuth JWT/session and custom auth cookies stay aligned.
 * Override with `AUTH_SESSION_MAX_AGE_SECONDS`; anything non-numeric or <= 0 keeps the 7-day default.
 */
export const AUTH_SESSION_MAX_AGE_SECONDS = resolveSessionMaxAge();

export const COOKIE_OPTIONS = {
  path: '/',
  maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
  sameSite: 'lax' as const,
} as const;
