// Shared cookie configuration - used by both server and client
export const SELECTED_USER_COOKIE = 'selected-user-details';
export const AUTH_USER_DETAILS_COOKIE = 'auth-user-details';

/** Session lifetime (seconds): NextAuth JWT/session and custom auth cookies stay aligned. */
export const AUTH_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export const COOKIE_OPTIONS = {
  path: '/',
  maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
  sameSite: 'lax' as const,
} as const;
