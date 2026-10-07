import { NextResponse } from 'next/server';

import { resolveBexActor } from '~/lib/api/bex-api-auth';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { gateRoute } from '~/lib/permissions/route-gate';

/**
 * B0-465 — auth for the `/api/admin/tests/runs*` endpoints the CI eval gate drives.
 *
 * These started as browser-only surfaces (NextAuth session + the sidebar-tests permission gate),
 * which is why `scripts/run-eval-gate.ts` could never actually authenticate: it sends a Bearer
 * token that no handler read, so every CI request 401'd regardless of which run id it checked.
 *
 * Same shape as `hasBexSessionOrServiceToken` (B0-387) for `/api/bex/workflow-runs/[id]`: a
 * signed-in admin OR a client token verified against the `api_project` → `api_app` → `api_key`
 * registry chain. A missing, malformed, unknown, revoked or expired token — or one under a
 * deactivated app/project — fails exactly like no credential at all.
 */
export async function authorizeAdminTestsRoute(
  request: Request,
  route: string,
): Promise<NextResponse | null> {
  const actor = await resolveBexActor(request);

  if (actor === null) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  /**
   * The permission gate is a PER-USER check, so it can only ever fail for a service token — which
   * carries no NextAuth user (see `resolveBexActor`). For machine callers the registry chain check
   * IS the authorization; applying the navigation gate on top would lock CI out permanently.
   */
  if (actor === 'session') {
    return gateRoute(PERMISSIONS.NAVIGATION_SIDEBAR_TESTS, route);
  }

  return null;
}
