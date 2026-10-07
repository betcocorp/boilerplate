import { getServerSession } from 'next-auth';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';

import { authOptions } from '~/lib/auth';
import {
  AUTH_SESSION_MAX_AGE_SECONDS,
  AUTH_USER_DETAILS_COOKIE,
  AUTH_USER_REBUILD_BREAKER_MAX_AGE_SECONDS,
  AUTH_USER_REBUILD_FAILED_COOKIE,
  SELECTED_USER_COOKIE,
} from '~/lib/cookies-config';
import { logError, logInfo, logWarn } from '~/lib/observability/logger';
import { isPermissionsEnforced } from '~/lib/permissions/enforcement';
import { setCachedPermissions } from '~/lib/permissions/redis';
import { getPermissionsForUser, getUser } from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_CALLBACK_URL = '/admin';

/** NextAuth session-token cookie names (differs by environment). */
const SESSION_COOKIE_NAMES = [
  'next-auth.session-token',
  '__Secure-next-auth.session-token',
];

/**
 * Only same-origin app paths are acceptable forwarding targets: `/api/*` would bounce straight back
 * here (or return JSON to a browser navigation), and `//host` / `https://host` would be an open
 * redirect.
 */
const callbackUrlSchema = z
  .string()
  .refine(
    (value) =>
      value.startsWith('/') &&
      !value.startsWith('//') &&
      !value.startsWith('/api'),
    { message: 'callbackUrl must be a relative app path outside /api' },
  );

function resolveCallbackUrl(raw: string | null): string {
  const parsed = callbackUrlSchema.safeParse(raw ?? '');
  return parsed.success ? parsed.data : DEFAULT_CALLBACK_URL;
}

/** Full sign-out: drop every auth cookie so the sign-in page does not bounce straight back. */
function redirectToSignIn(
  request: NextRequest,
  callbackUrl: string,
): NextResponse {
  const signInUrl = new URL('/', request.nextUrl.origin);
  signInUrl.searchParams.set('callbackUrl', callbackUrl);
  const response = NextResponse.redirect(signInUrl);
  for (const name of SESSION_COOKIE_NAMES) response.cookies.delete(name);
  response.cookies.delete(AUTH_USER_DETAILS_COOKIE);
  response.cookies.delete(SELECTED_USER_COOKIE);
  return response;
}

/**
 * Shadow-mode fallback: carry on to the requested page without the cookie, and set a short-lived
 * breaker so `src/proxy.ts` stops redirecting here for the next minute.
 */
function forwardWithoutRebuild(
  request: NextRequest,
  callbackUrl: string,
): NextResponse {
  const response = NextResponse.redirect(
    new URL(callbackUrl, request.nextUrl.origin),
  );
  response.cookies.set(AUTH_USER_REBUILD_FAILED_COOKIE, '1', {
    path: '/',
    maxAge: AUTH_USER_REBUILD_BREAKER_MAX_AGE_SECONDS,
    sameSite: 'lax',
    httpOnly: false,
  });
  return response;
}

/**
 * GET /api/auth/rebuild-user?callbackUrl=/some/path
 *
 * Called by `src/proxy.ts` when the NextAuth JWT is valid but the auth-user cookie is missing
 * (B0-406). Re-fetches the `app_user` row, re-sets the cookie (with `GROUPS`), warms the Redis
 * permission bundle, and forwards the user to their original destination — no re-authentication.
 *
 * On failure the behaviour depends on `PERMISSIONS_ENFORCED`: enforced signs the user out;
 * shadow mode forwards them anyway with the loop-breaker cookie, so a user who is missing from the
 * `app_user` seed can never be locked out.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const callbackUrl = resolveCallbackUrl(
    request.nextUrl.searchParams.get('callbackUrl'),
  );

  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    // No session at all — there is nothing to rebuild from and nothing to lock out.
    logWarn('auth.rebuild_user.no_session', { callbackUrl });
    return redirectToSignIn(request, callbackUrl);
  }

  const email = session.user.email.trim();

  try {
    const result = await getUser(email);
    const appUser = result.success ? result.data[0] : undefined;

    if (appUser?.USER_ID) {
      const { permissions, permission_groups } = await getPermissionsForUser(
        appUser.USER_ID,
      );
      await setCachedPermissions(
        appUser.USER_ID,
        permissions,
        permission_groups,
      );

      const response = NextResponse.redirect(
        new URL(callbackUrl, request.nextUrl.origin),
      );
      response.cookies.set(
        AUTH_USER_DETAILS_COOKIE,
        JSON.stringify({ ...appUser, GROUPS: permission_groups }),
        {
          path: '/',
          maxAge: AUTH_SESSION_MAX_AGE_SECONDS,
          sameSite: 'lax',
          // Client hooks read EMAIL/USER_ID from this cookie.
          httpOnly: false,
        },
      );
      response.cookies.delete(AUTH_USER_REBUILD_FAILED_COOKIE);

      logInfo('auth.rebuild_user.rebuilt', {
        email,
        userId: appUser.USER_ID,
        callbackUrl,
        groups: permission_groups,
      });
      return response;
    }

    const enforced = await isPermissionsEnforced();
    logWarn('auth.rebuild_user.user_not_found', {
      email,
      callbackUrl,
      enforced,
      outcome: enforced ? 'signed-out' : 'forwarded-without-cookie',
    });
    return enforced
      ? redirectToSignIn(request, callbackUrl)
      : forwardWithoutRebuild(request, callbackUrl);
  } catch (error) {
    const enforced = await isPermissionsEnforced();
    logError('auth.rebuild_user.failed', {
      email,
      callbackUrl,
      enforced,
      error: String(error),
    });
    return enforced
      ? redirectToSignIn(request, callbackUrl)
      : forwardWithoutRebuild(request, callbackUrl);
  }
}
