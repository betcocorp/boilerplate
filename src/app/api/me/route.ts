import { NextResponse } from 'next/server';

import { hasSession } from '~/lib/api/session-auth';
import { getUserOrDefault } from '~/lib/cookies-server';
import {
  getCachedPermissionBundle,
  setCachedPermissions,
} from '~/lib/permissions/redis';
import { getPermissionsForUser } from '~/lib/permissions/repository';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/me
 * Returns effective user (selected user when act-as, else auth user) and their permissions for UI.
 * Permissions are from Redis (populated at login or when switching user). If cache is empty,
 * refetches from the permissions repository (Supabase).
 */
export async function GET() {
  if (!(await hasSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await getUserOrDefault();
  if (!user) {
    return NextResponse.json(
      { error: 'User details not found', permissions: [] },
      { status: 200 },
    );
  }

  const userId = (user as { USER_ID?: string }).USER_ID;
  const bundle = userId ? await getCachedPermissionBundle(userId) : null;
  let permissions: string[] | null = bundle?.permissions ?? null;
  let permission_groups: string[] = bundle?.permission_groups ?? [];

  if (
    userId &&
    (permissions === null ||
      (Array.isArray(permissions) && permissions.length === 0))
  ) {
    try {
      const fresh = await getPermissionsForUser(userId);
      permission_groups = fresh.permission_groups;
      if (Array.isArray(fresh.permissions) && fresh.permissions.length > 0) {
        await setCachedPermissions(
          userId,
          fresh.permissions,
          fresh.permission_groups,
        );
        permissions = fresh.permissions;
      }
    } catch {
      // Keep permissions as null/empty; client can retry or re-login
    }
  }

  return NextResponse.json({
    user: {
      USER_ID: (user as { USER_ID?: string }).USER_ID,
      EMAIL: (user as { EMAIL?: string }).EMAIL,
      NAME: (user as { NAME?: string }).NAME,
    },
    permissions: permissions ?? [],
    permission_groups,
  });
}
