import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { hasBexSession } from '~/lib/api/bex-api-auth';
import {
  AUTH_USER_DETAILS_COOKIE,
  COOKIE_OPTIONS,
  SELECTED_USER_COOKIE,
} from '~/lib/cookies-config';
import { getUserOrDefault } from '~/lib/cookies-server';
import { setCachedPermissions } from '~/lib/permissions/redis';
import { getPermissionsForUser } from '~/lib/permissions/repository';
import type User from '~/types/User';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/me/refresh-permissions
 * Refetches the effective user's (selected-user cookie or auth) permissions from the permissions
 * repository and updates Redis.
 * Returns { user, permissions, permission_groups } so the client can update the permissions store.
 * Updates the relevant user cookie with GROUPS for event meta / client parity.
 * Call this after saving permission assignments so the UI sees new permissions without re-login.
 */
export async function POST() {
  if (!(await hasBexSession())) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const user = await getUserOrDefault();
  if (!user) {
    return NextResponse.json(
      { error: 'User details not found', user: null, permissions: [] },
      { status: 200 },
    );
  }

  const userId = (user as { USER_ID?: string }).USER_ID;
  if (!userId) {
    return NextResponse.json({
      user: {
        USER_ID: undefined,
        EMAIL: (user as { EMAIL?: string }).EMAIL,
        NAME: (user as { NAME?: string }).NAME,
      },
      permissions: [],
      permission_groups: [],
    });
  }

  try {
    const { permissions, permission_groups } =
      await getPermissionsForUser(userId);
    await setCachedPermissions(userId, permissions, permission_groups);

    const cookieStore = await cookies();
    const selectedCookie = cookieStore.get(SELECTED_USER_COOKIE);
    const useSelected =
      selectedCookie?.value != null && selectedCookie.value !== '';
    const cookieKey = useSelected
      ? SELECTED_USER_COOKIE
      : AUTH_USER_DETAILS_COOKIE;
    const prevRaw = cookieStore.get(cookieKey)?.value;
    const baseUser =
      prevRaw != null && prevRaw !== ''
        ? (JSON.parse(prevRaw) as User)
        : (user as User);
    const updatedUser: User = {
      ...baseUser,
      ...user,
      GROUPS: permission_groups,
    };
    cookieStore.set(cookieKey, JSON.stringify(updatedUser), {
      ...COOKIE_OPTIONS,
      httpOnly: false,
    });

    return NextResponse.json({
      user: {
        USER_ID: userId,
        EMAIL: (user as { EMAIL?: string }).EMAIL,
        NAME: (user as { NAME?: string }).NAME,
        GROUPS: permission_groups,
      },
      permissions,
      permission_groups,
    });
  } catch (error) {
    console.error('refresh-permissions error:', error);
    return NextResponse.json(
      { error: 'Failed to refresh permissions', user: null, permissions: [] },
      { status: 500 },
    );
  }
}
