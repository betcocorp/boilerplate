import { getServerSession } from 'next-auth';

import { authOptions } from '~/lib/auth';

/**
 * Auth for the bex UI's own API routes (`/api/bex/*`).
 *
 * These are browser-only surfaces for signed-in bex admins, so they authenticate with the existing
 * NextAuth session (Entra ID + Duo), verified server-side in each route handler. There is no
 * machine/bearer path and no anonymous "non-empty message" bypass here — server-to-server callers
 * use `/api/v1/*` with a client token instead (see `~/lib/api/client-auth`).
 */
export async function hasBexSession(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  return Boolean(session?.user);
}
