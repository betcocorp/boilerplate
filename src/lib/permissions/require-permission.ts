/**
 * Server-side permission checks for API routes.
 * Validates from Redis when configured; falls back to the permissions repository when Redis is not set up.
 *
 * Every verdict is recorded (structured log, plus a de-duplicated `audit_logs` row on denials) and
 * gated by `BEX_PERMISSIONS_ENFORCED` (B0-408). While the flag is off (shadow mode) an authorization
 * failure is turned into an allow with `shadowAllowed: true` — callers keep working exactly as they
 * do today, and `errorResponse` is only ever set when enforcement is on.
 *
 * The one thing shadow mode does **not** relax is *authentication*: no NextAuth session still yields
 * 401. That is orthogonal to this epic (it is already today's behaviour on every caller here), and
 * shadowing it would risk opening an anonymous hole in any route that gated on `requirePermission`
 * alone.
 */

import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { authOptions } from '~/lib/auth';
import { getUserOrDefault } from '~/lib/cookies-server';
import {
  isPermissionsEnforced,
  recordPermissionVerdict,
  type PermissionVerdictReason,
} from '~/lib/permissions/enforcement';
import {
  getCachedPermissions,
  setCachedPermissions,
} from '~/lib/permissions/redis';
import { getPermissionsForUser } from '~/lib/permissions/repository';

function matchesPermission(required: string, have: string[]): boolean {
  if (have.includes(required)) return true;
  const parts = required.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const wild = [...parts.slice(0, i), '*'].join('.');
    if (have.includes(wild)) return true;
  }
  return have.includes('*');
}

export interface PermissionResult {
  allowed: boolean;
  userId?: string;
  permissions?: string[];
  errorResponse?: NextResponse;
  /** Set when shadow mode (`BEX_PERMISSIONS_ENFORCED` off) turned a denial into an allow. */
  shadowAllowed?: boolean;
}

/** Optional context so verdict logs can name the route they guarded. */
export interface PermissionCheckOptions {
  /** e.g. `GET /api/bex/conversations` — recorded on the verdict. */
  route?: string;
}

/**
 * Records the verdict and applies the flag: allow as-is, shadow-allow a denial, or deny for real.
 * Shared by `requirePermission` and `requireAnyPermission`.
 */
async function resolveVerdict(params: {
  selector: string | string[];
  allowed: boolean;
  reason: PermissionVerdictReason;
  route?: string;
  userId?: string;
  email?: string | null;
  permissions?: string[];
  denyStatus?: number;
  denyError?: string;
}): Promise<PermissionResult> {
  const { selector, allowed, reason, route, userId, email, permissions } =
    params;

  await recordPermissionVerdict({
    surface: 'api',
    selector,
    allowed,
    reason,
    route,
    userId,
    email,
  });

  if (allowed) return { allowed: true, userId, permissions };

  if (!isPermissionsEnforced()) {
    return { allowed: true, shadowAllowed: true, userId, permissions };
  }

  return {
    allowed: false,
    userId,
    permissions,
    errorResponse: NextResponse.json(
      { error: params.denyError ?? 'Forbidden' },
      { status: params.denyStatus ?? 403 },
    ),
  };
}

/**
 * Check if the current user has the required permission (from Redis).
 * Use in API routes: const result = await requirePermission('navigation.sidebar.bex');
 * if (!result.allowed) return result.errorResponse;
 */
export async function requirePermission(
  requiredPermission: string,
  options: PermissionCheckOptions = {},
): Promise<PermissionResult> {
  const { route } = options;
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return {
      allowed: false,
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      ),
    };
  }
  // A session without an email is authenticated but unidentifiable — an authorization problem, so
  // it goes through the flag rather than 401-ing (which would be a change from today's behaviour).
  const email = session.user.email ?? null;

  const user = await getUserOrDefault();
  const userId =
    user && typeof user === 'object' && 'USER_ID' in user
      ? (user as { USER_ID: string }).USER_ID
      : null;
  if (!userId) {
    return resolveVerdict({
      selector: requiredPermission,
      allowed: false,
      reason: 'user-not-found',
      route,
      email,
      denyError: 'User not found',
    });
  }

  let permissions: string[] | null = await getCachedPermissions(userId);
  if (!permissions || permissions.length === 0) {
    try {
      const fresh = await getPermissionsForUser(userId);
      if (Array.isArray(fresh.permissions) && fresh.permissions.length > 0) {
        await setCachedPermissions(
          userId,
          fresh.permissions,
          fresh.permission_groups,
        );
        permissions = fresh.permissions;
      }
    } catch {
      // keep null
    }
  }
  if (!permissions || permissions.length === 0) {
    return resolveVerdict({
      selector: requiredPermission,
      allowed: false,
      reason: 'permissions-unavailable',
      route,
      userId,
      email,
      permissions: [],
      denyError: 'Permissions not available; try signing in again',
    });
  }

  const allowed = matchesPermission(requiredPermission, permissions);
  return resolveVerdict({
    selector: requiredPermission,
    allowed,
    reason: allowed ? 'granted' : 'missing-permission',
    route,
    userId,
    email,
    permissions,
  });
}

/**
 * Check if the current user has any of the given permissions.
 */
export async function requireAnyPermission(
  requiredPermissions: string[],
  options: PermissionCheckOptions = {},
): Promise<PermissionResult> {
  const { route } = options;
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    return {
      allowed: false,
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      ),
    };
  }
  // A session without an email is authenticated but unidentifiable — an authorization problem, so
  // it goes through the flag rather than 401-ing (which would be a change from today's behaviour).
  const email = session.user.email ?? null;

  const user = await getUserOrDefault();
  const userId =
    user && typeof user === 'object' && 'USER_ID' in user
      ? (user as { USER_ID: string }).USER_ID
      : null;
  if (!userId) {
    return resolveVerdict({
      selector: requiredPermissions,
      allowed: false,
      reason: 'user-not-found',
      route,
      email,
      denyError: 'User not found',
    });
  }

  let permissions: string[] | null = await getCachedPermissions(userId);
  if (!permissions || permissions.length === 0) {
    try {
      const fresh = await getPermissionsForUser(userId);
      if (Array.isArray(fresh.permissions) && fresh.permissions.length > 0) {
        await setCachedPermissions(
          userId,
          fresh.permissions,
          fresh.permission_groups,
        );
        permissions = fresh.permissions;
      }
    } catch {
      // keep null
    }
  }
  if (!permissions || permissions.length === 0) {
    return resolveVerdict({
      selector: requiredPermissions,
      allowed: false,
      reason: 'permissions-unavailable',
      route,
      userId,
      email,
      permissions: [],
      denyError: 'Permissions not available; try signing in again',
    });
  }

  const allowed = requiredPermissions.some((p) =>
    matchesPermission(p, permissions),
  );
  return resolveVerdict({
    selector: requiredPermissions,
    allowed,
    reason: allowed ? 'granted' : 'missing-permission',
    route,
    userId,
    email,
    permissions,
  });
}
