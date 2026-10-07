import { withAuth } from "next-auth/middleware";
import { NextResponse } from "next/server";

import {
  AUTH_USER_DETAILS_COOKIE,
  AUTH_USER_REBUILD_FAILED_COOKIE,
} from "~/lib/cookies-config";

/**
 * Next 16 renamed the `middleware` file convention to `proxy` (same behaviour, `middleware.ts` is
 * deprecated) — this is the former `src/middleware.ts`.
 *
 * `withAuth` guarantees a valid NextAuth JWT. On top of that we require the auth-user cookie: the
 * permission helpers (`getUserOrDefault` → `USER_ID`) cannot resolve anything without it, so a
 * session that outlives the cookie would look permission-less on every surface. When it is missing
 * we bounce through `/api/auth/rebuild-user`, which refreshes the cookie from the live session and
 * forwards the user on — no re-authentication.
 *
 * Deliberately flag-free: `PERMISSIONS_ENFORCED` is read inside the rebuild route (a Node
 * handler), not here. That keeps this Edge bundle free of the Supabase/audit imports and means the
 * proxy itself can never sign anyone out.
 *
 * `AUTH_USER_REBUILD_FAILED_COOKIE` is the loop breaker: in shadow mode the rebuild route may be
 * unable to find an `app_user` row and forwards the user anyway, so without this the next request
 * would bounce back to rebuild forever.
 */
export default withAuth(
  function proxy(req) {
    const needsRebuild =
      !req.cookies.has(AUTH_USER_DETAILS_COOKIE) &&
      !req.cookies.has(AUTH_USER_REBUILD_FAILED_COOKIE);

    if (needsRebuild) {
      const callbackUrl = req.nextUrl.pathname + (req.nextUrl.search ?? "");
      const rebuildUrl = new URL("/api/auth/rebuild-user", req.nextUrl.origin);
      rebuildUrl.searchParams.set("callbackUrl", callbackUrl);
      return NextResponse.redirect(rebuildUrl);
    }

    return NextResponse.next();
  },
  {
    pages: {
      signIn: "/",
    },
  },
);

export const config = {
  // `api` is excluded, so the /api/auth/rebuild-user redirect target is not re-intercepted.
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|$).*)"],
};
