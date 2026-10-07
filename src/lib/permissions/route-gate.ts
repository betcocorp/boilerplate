/**
 * One-liner permission gate for API route handlers (B0-408).
 *
 * ```ts
 * const denied = await gateRoute(PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS, 'GET /api/example');
 * if (denied) return denied;
 * ```
 *
 * Returns the response to send when the request must be refused, or `null` to continue. While
 * `PERMISSIONS_ENFORCED` is off this always returns `null` for authorization failures — the
 * verdict is still logged (and audited) by `requirePermission`, so phase 1 can see what would break.
 * Authentication is untouched: a request with no NextAuth session still gets a 401, exactly as the
 * handlers' own session checks already do.
 */

import type { NextResponse } from 'next/server';

import { requirePermission } from '~/lib/permissions/require-permission';

export async function gateRoute(
  selector: string,
  route: string,
): Promise<NextResponse | null> {
  const result = await requirePermission(selector, { route });
  return result.errorResponse ?? null;
}
