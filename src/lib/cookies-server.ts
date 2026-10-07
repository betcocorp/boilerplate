import { cookies } from 'next/headers';

import { getAuthUserDetails } from '~/lib/actions/cookies';
import { SELECTED_USER_COOKIE } from '~/lib/cookies-config';
import User, { AcceptableUserKeys } from '~/types/User';

/**
 * Server-side function to get the selected user from cookies.
 * Used in Server Components and Server Actions.
 *
 * @returns The selected user object, or null if not found
 */
export async function getSelectedUser(): Promise<User | null> {
  const cookieStore = await cookies();
  const cookie = cookieStore.get(SELECTED_USER_COOKIE);

  if (!cookie?.value) {
    return null;
  }

  return JSON.parse(cookie.value);
}

export async function getUserOrDefault(): Promise<User | null>;
export async function getUserOrDefault(
  key: AcceptableUserKeys,
): Promise<User[AcceptableUserKeys] | null>;
export async function getUserOrDefault(
  key?: AcceptableUserKeys,
): Promise<User | User[AcceptableUserKeys] | null> {
  try {
    const selectedUser = await getSelectedUser();
    if (selectedUser) {
      return key ? selectedUser[key] : selectedUser;
    }

    const authUserDetails = await getAuthUserDetails();
    return key && authUserDetails
      ? authUserDetails[key]
      : authUserDetails || null;
  } catch (error) {
    console.error('Error getting user or default user:', error);
    return null;
  }
}
