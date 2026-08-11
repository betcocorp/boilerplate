/**
 * Server-side permission checks for API routes.
 * Validates from Redis when configured; falls back to the permissions repository when Redis is not set up.
 */

import { getServerSession } from 'next-auth';
import { NextResponse } from 'next/server';

import { authOptions } from '~/lib/auth';
import { getUserOrDefault } from '~/lib/cookies-server';
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
}

/**
 * Check if the current user has the required permission (from Redis).
 * Use in API routes: const result = await requirePermission('navigation.sidebar.bex');
 * if (!result.allowed) return result.errorResponse;
 */
export async function requirePermission(
  requiredPermission: string,
): Promise<PermissionResult> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return {
      allowed: false,
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      ),
    };
  }

  const user = await getUserOrDefault();
  const userId =
    user && typeof user === 'object' && 'USER_ID' in user
      ? (user as { USER_ID: string }).USER_ID
      : null;
  if (!userId) {
    return {
      allowed: false,
      errorResponse: NextResponse.json(
        { error: 'User not found' },
        { status: 403 },
      ),
    };
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
    return {
      allowed: false,
      userId,
      permissions: [],
      errorResponse: NextResponse.json(
        { error: 'Permissions not available; try signing in again' },
        { status: 403 },
      ),
    };
  }

  const allowed = matchesPermission(requiredPermission, permissions);
  return {
    allowed,
    userId,
    permissions,
    errorResponse: allowed
      ? undefined
      : NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
  };
}

/**
 * Check if the current user has any of the given permissions.
 */
export async function requireAnyPermission(
  requiredPermissions: string[],
): Promise<PermissionResult> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.email) {
    return {
      allowed: false,
      errorResponse: NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 },
      ),
    };
  }

  const user = await getUserOrDefault();
  const userId =
    user && typeof user === 'object' && 'USER_ID' in user
      ? (user as { USER_ID: string }).USER_ID
      : null;
  if (!userId) {
    return {
      allowed: false,
      errorResponse: NextResponse.json(
        { error: 'User not found' },
        { status: 403 },
      ),
    };
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
    return {
      allowed: false,
      userId,
      permissions: [],
      errorResponse: NextResponse.json(
        { error: 'Permissions not available; try signing in again' },
        { status: 403 },
      ),
    };
  }

  const allowed = requiredPermissions.some((p) =>
    matchesPermission(p, permissions),
  );
  return {
    allowed,
    userId,
    permissions,
    errorResponse: allowed
      ? undefined
      : NextResponse.json({ error: 'Forbidden' }, { status: 403 }),
  };
}
