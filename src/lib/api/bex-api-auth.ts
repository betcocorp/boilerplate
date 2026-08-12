import { getServerSession } from 'next-auth';

import { authenticateApiToken } from '~/lib/api/client-auth';
import { authOptions } from '~/lib/auth';

/**
 * Auth for the bex UI's own API routes (`/api/bex/*`).
 *
 * These are browser surfaces for signed-in bex admins, so they authenticate with the existing
 * NextAuth session (Entra ID + Duo), verified server-side in each route handler. There is no
 * anonymous "non-empty message" bypass, no shared secret and no `NODE_ENV` allow-all here.
 */
export async function hasBexSession(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  return Boolean(session?.user);
}

/**
 * Auth for the bex read surfaces that a trusted machine caller may also poll (B0-387:
 * `/api/bex/workflow-runs/[id]`, so a service can follow a run it kicked off via `/api/v1/*`).
 *
 * Passes when EITHER a signed-in NextAuth session exists OR the request presents a client token
 * that authenticates against the `api_project` → `api_app` → `api_key` registry — the same
 * `authenticateApiToken` chain check `/api/v1/*` uses, so a missing, malformed, unknown, revoked or
 * expired token (or one under a deactivated app/project) fails exactly like no credential at all.
 */
export async function hasBexSessionOrServiceToken(
  request: Request,
): Promise<boolean> {
  return (await resolveBexActor(request)) !== null;
}

/** Which credential let the request through, or `null` if neither did. */
export type BexActor = 'session' | 'service' | null;

/**
 * Same check as `hasBexSessionOrServiceToken`, but reports *who* authenticated. Callers that apply
 * per-user authorization (B0-408 permission gates) need the distinction: a service token carries no
 * NextAuth user, so a user-permission check can only ever fail for it.
 */
export async function resolveBexActor(request: Request): Promise<BexActor> {
  if (await hasBexSession()) {
    return 'session';
  }

  const auth = await authenticateApiToken(request);
  return auth.ok ? 'service' : null;
}
