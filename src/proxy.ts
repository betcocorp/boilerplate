import { withAuth } from 'next-auth/middleware';

/**
 * Next 16 renamed the `middleware` file convention to `proxy` (same behaviour, `middleware.ts` is
 * deprecated) — this is the former `src/middleware.ts`.
 *
 * `withAuth` guarantees a valid NextAuth JWT for every matched route. Add app-side authorization
 * (e.g. a permissions check) in the wrapped function below, or in a `signIn`/`session` callback in
 * `~/lib/auth.ts`, once you have a user/permission model to check against.
 */
export default withAuth({
  pages: {
    signIn: '/',
  },
});

export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|$).*)'],
};
