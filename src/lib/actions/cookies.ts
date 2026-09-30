'use server';

import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';

import { AUTH_USER_DETAILS_COOKIE, COOKIE_OPTIONS } from '~/lib/cookies-config';
import User, { AcceptableUserKeys } from '~/types/User';

/**
 * Server Action to set the authenticated user details in cookies.
 *
 * @param userDetails The authenticated user object to store
 */
export async function setAuthUserDetails(userDetails: User) {
  const cookieStore = await cookies();
  cookieStore.set(AUTH_USER_DETAILS_COOKIE, JSON.stringify(userDetails), {
    ...COOKIE_OPTIONS,
    // Client hooks may need to read this without a round-trip.
    httpOnly: false,
  });
  revalidatePath('/', 'layout');
}

/**
 * Server Action to clear the auth cookie (e.g. on logout). Called from the sign-in page when
 * there is no session so we never clear while still on an authenticated page.
 */
export async function clearAuthCookies() {
  const cookieStore = await cookies();
  cookieStore.delete(AUTH_USER_DETAILS_COOKIE);
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
