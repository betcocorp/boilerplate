/**
 * Server-only permission helpers for RSC (e.g. AdminSidebarNav).
 * Use getCurrentUserPermissions() and hasPermission() to gate nav/UI without a client store.
 */

import { getUserOrDefault } from '~/lib/cookies-server';
import {
  getCachedPermissionGroups,
  getCachedPermissions,
  setCachedPermissions,
} from '~/lib/permissions/redis';
import { getPermissionsForUser } from '~/lib/permissions/repository';
import { getAuthUserDetails } from '../actions/cookies';

export async function userHasSwitcher(): Promise<boolean> {
  const authUserDetails = await getAuthUserDetails();
  return !!authUserDetails?.HAS_USER_SWITCHER;
}

/**
 * Returns the effective user's permission selectors (selected user when act-as, else auth user).
 * From Redis or the permissions repository. Safe to call from async server components.
 * Returns [] if not authenticated or on error.
 */
export async function getCurrentUserPermissions(): Promise<string[]> {
  const user = await getUserOrDefault();
  const userId = (user as { USER_ID?: string } | null)?.USER_ID;

  if (!userId) return [];

  let permissions: string[] | null = await getCachedPermissions(userId);
  if (
    permissions === null ||
    (Array.isArray(permissions) && permissions.length === 0)
  ) {
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
      // keep empty
    }
  }
  return permissions ?? [];
}

/**
 * Returns the effective user's permission group selectors (e.g. "sales", "it-admin").
 * Resolution order: user cookie GROUPS (set at sign-in / user switch), then Redis,
 * then the permissions repository. Returns [] if not authenticated or on error.
 */
export async function getCurrentUserPermissionGroups(): Promise<string[]> {
  const user = await getUserOrDefault();
  const cookieGroups = (user as { GROUPS?: unknown } | null)?.GROUPS;
  if (Array.isArray(cookieGroups)) {
    const groups = cookieGroups.filter(
      (g): g is string => typeof g === 'string' && g.trim() !== '',
    );
    if (groups.length > 0) return groups;
  }

  const userId = (user as { USER_ID?: string } | null)?.USER_ID;
  if (!userId) return [];

  const cached = await getCachedPermissionGroups(userId);
  if (cached && cached.length > 0) return cached;

  // Empty/missing cache also covers bundles cached before groups were wired through
  // (the `groups` key was previously dropped) — refetch and re-cache.
  try {
    const fresh = await getPermissionsForUser(userId);
    const freshGroups = Array.isArray(fresh.permission_groups)
      ? fresh.permission_groups
      : [];
    if (fresh.permissions.length > 0 || freshGroups.length > 0) {
      await setCachedPermissions(userId, fresh.permissions, freshGroups);
    }
    return freshGroups;
  } catch {
    return [];
  }
}

/**
 * Check if a permission array grants access (exact or wildcard).
 * Mirrors client hasPermission logic: e.g. "navigation.*" matches "navigation.sidebar.example".
 */
export function hasPermission(
  permissions: string[],
  permission: string = '',
): boolean {
  if (permissions.includes(permission)) return true;
  const parts = permission.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const wild = [...parts.slice(0, i), '*'].join('.');
    if (permissions.includes(wild)) return true;
  }
  return permissions.includes('*');
}
