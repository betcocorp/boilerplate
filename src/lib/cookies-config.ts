// Shared cookie configuration - used by both server and client
export const SELECTED_USER_COOKIE = 'selected-user-details';
export const AUTH_USER_DETAILS_COOKIE = 'auth-user-details';

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
