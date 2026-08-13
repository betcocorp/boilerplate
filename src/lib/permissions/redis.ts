/**
 * Redis-backed permission cache per permission system plan.
 * Key: user_permissions:{userId} -> JSON { permissions: string[], permission_groups: string[] }
 * (legacy: plain string[] is still read for backward compatibility). TTL 24h.
 *
 * Redis is optional: if UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are not set,
 * getRedis() returns null, getCachedPermissions() returns null, and setCachedPermissions() no-ops.
 * Callers that need permissions (e.g. getCurrentUserPermissions, requirePermission)
 * should fall back to getPermissionsForUser() from the permissions repository when cache is null.
 */

import { Redis } from '@upstash/redis';

const PERMISSION_KEY_PREFIX = 'user_permissions:';
const PERMISSION_TTL_SECONDS = 60 * 60 * 24; // 24 hours

export type CachedPermissionBundle = {
  permissions: string[];
  permission_groups: string[];
};

function getRedis(): Redis | null {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function normalizeRawToBundle(raw: unknown): CachedPermissionBundle | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) {
    return { permissions: raw as string[], permission_groups: [] };
  }
  if (typeof raw === 'object' && raw !== null && 'permissions' in raw) {
    const o = raw as Record<string, unknown>;
    const permissions = Array.isArray(o.permissions)
      ? (o.permissions as string[])
      : [];
    const permission_groups = Array.isArray(o.permission_groups)
      ? (o.permission_groups as string[])
      : [];
    return { permissions, permission_groups };
  }
  return null;
}

/**
 * Full cached bundle (permissions + permission group SELECTORs).
 * Returns null if Redis is not configured or key missing.
 */
export async function getCachedPermissionBundle(
  userId: string,
): Promise<CachedPermissionBundle | null> {
  const redis = getRedis();
  if (!redis) return null;
  try {
    const raw = await redis.get<unknown>(`${PERMISSION_KEY_PREFIX}${userId}`);
    return normalizeRawToBundle(raw);
  } catch {
    return null;
  }
}

/**
 * Get cached permissions for a user. Returns null if Redis is not configured or key missing.
 */
export async function getCachedPermissions(
  userId: string,
): Promise<string[] | null> {
  const bundle = await getCachedPermissionBundle(userId);
  return bundle?.permissions ?? null;
}

/**
 * Get cached permission group SELECTORs (e.g. sales, it-admin) for a user.
 */
export async function getCachedPermissionGroups(
  userId: string,
): Promise<string[] | null> {
  const bundle = await getCachedPermissionBundle(userId);
  return bundle?.permission_groups ?? null;
}

/**
 * Store permissions and permission groups for a user in Redis with TTL.
 */
export async function setCachedPermissions(
  userId: string,
  permissions: string[],
  permission_groups: string[] = [],
  ttlSeconds: number = PERMISSION_TTL_SECONDS,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  const key = `${PERMISSION_KEY_PREFIX}${userId}`;
  const value: CachedPermissionBundle = {
    permissions,
    permission_groups,
  };
  await redis.set(key, value, { ex: ttlSeconds });
}

/**
 * Invalidate permission cache for a user (e.g. when permissions or group membership change).
 */
export async function invalidateCachedPermissions(
  userId: string,
): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(`${PERMISSION_KEY_PREFIX}${userId}`);
}

export function isRedisConfigured(): boolean {
  return Boolean(
    process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN,
  );
}

/**
 * Get permissions for the current user from Redis by userId (server-side only).
 * Returns null if Redis not configured or cache miss.
 */
export async function getPermissionsForCurrentUser(
  userId: string,
): Promise<string[] | null> {
  return getCachedPermissions(userId);
}
