import { getServerSession } from 'next-auth';

import { authOptions } from '~/lib/auth';

/**
 * Auth for the app's own API routes. These are browser surfaces for signed-in users, so they
 * authenticate with the NextAuth session, verified server-side in each route handler. There is no
 * anonymous bypass, no shared secret and no `NODE_ENV` allow-all here.
 */
export async function hasSession(): Promise<boolean> {
  const session = await getServerSession(authOptions);
  return Boolean(session?.user);
}
