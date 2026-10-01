'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';

import {
  AUTH_USER_DETAILS_COOKIE,
  COOKIE_OPTIONS,
  SELECTED_USER_COOKIE,
} from '~/lib/cookies-config';
import { setCachedPermissions } from '~/lib/permissions/redis';
import { getPermissionsForUser } from '~/lib/permissions/repository';
import User, { AcceptableUserKeys } from '~/types/User';

function sanitizeGroups(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (group): group is string =>
          typeof group === 'string' && group.trim() !== '',
      )
    : [];
}

async function withResolvedGroups(userDetails: User): Promise<User> {
  const existingGroups = sanitizeGroups(userDetails.GROUPS);
  if (existingGroups.length > 0) {
    return {
      ...userDetails,
      GROUPS: existingGroups,
    };
  }

  const userId = (userDetails as { USER_ID?: string }).USER_ID;
  if (!userId) {
    return userDetails;
  }

  try {
    const { permission_groups } = await getPermissionsForUser(userId);
    return {
      ...userDetails,
      GROUPS: sanitizeGroups(permission_groups),
    };
  } catch (error) {
    console.error('Error loading groups for user cookie:', error);
    return userDetails;
  }
}

/**
 * Server Action to set the selected user details in cookies.
 * This is the preferred method for setting user selection in Next.js.
 * Automatically revalidates all pages to reflect the change.
 *
 * @param userDetails The user object to store
 */
export async function setSelectedUserDetails(userDetails: User) {
  const cookieStore = await cookies();
  const enrichedUser = await withResolvedGroups(userDetails);
  cookieStore.set(SELECTED_USER_COOKIE, JSON.stringify(enrichedUser), {
    ...COOKIE_OPTIONS,
    httpOnly: false, // Set to false so client can also read it
  });

  // Revalidate all pages to reflect the new user selection
  revalidatePath('/', 'layout');
}

/**
 * Sets the selected user (act-as) and loads that user's permissions into Redis,
 * so the app shows the same permissions and data as that user. Call this when
 * switching users via UserSwitcher; then refresh and reload client permissions.
 */
export async function setSelectedUserAndLoadPermissions(userDetails: User) {
  const cookieStore = await cookies();
  const userId = (userDetails as { USER_ID?: string }).USER_ID;
  const nextUserDetails = userDetails;
  if (userId) {
    try {
      const { permissions, permission_groups } =
        await getPermissionsForUser(userId);
      await setCachedPermissions(userId, permissions, permission_groups);
    } catch (error) {
      console.error('Error loading permissions for selected user:', error);
    }
  }

  cookieStore.set(SELECTED_USER_COOKIE, JSON.stringify(nextUserDetails), {
    ...COOKIE_OPTIONS,
    httpOnly: false,
  });

  revalidatePath('/', 'layout');
}

/**
 * Server Action to set the authenticated user details in cookies.
 *
 * @param userDetails The authenticated user object to store
 */
export async function setAuthUserDetails(userDetails: User) {
  const cookieStore = await cookies();
  const enrichedUser = await withResolvedGroups(userDetails);
  cookieStore.set(AUTH_USER_DETAILS_COOKIE, JSON.stringify(enrichedUser), {
    ...COOKIE_OPTIONS,
    // Client hooks need EMAIL when `selected-user-details` is unset.
    httpOnly: false,
  });
}

/**
 * Server Action to clear auth and selected-user cookies (e.g. on logout).
 * Called from the sign-in page when there is no session so we never clear
 * while still on an authenticated page (which would break API requests).
 */
export async function clearAuthCookies() {
  const cookieStore = await cookies();
  cookieStore.delete(AUTH_USER_DETAILS_COOKIE);
  cookieStore.delete(SELECTED_USER_COOKIE);
}

export async function getAuthUserDetails(): Promise<User | null>;
export async function getAuthUserDetails(
  key: AcceptableUserKeys,
): Promise<User[AcceptableUserKeys] | null>;
export async function getAuthUserDetails(
  key?: AcceptableUserKeys,
): Promise<User | User[AcceptableUserKeys] | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(AUTH_USER_DETAILS_COOKIE);
  if (!cookie?.value) {
    return null;
  }

  const parsed = JSON.parse(cookie.value);
  const user = Array.isArray(parsed) ? parsed[0] : parsed;

  return user && key ? user[key] : user || null;
}
