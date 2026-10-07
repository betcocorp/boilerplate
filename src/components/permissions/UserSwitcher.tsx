import { UserSwitcherClient } from '~/components/permissions/UserSwitcherClient';
import { getAuthUserDetails } from '~/lib/actions/cookies';
import { getUserOrDefault } from '~/lib/cookies-server';
import { getUsers } from '~/lib/permissions/repository';
import type User from '~/types/User';

/**
 * Server half of the "acting as" picker: renders nothing unless the *authenticated* user has
 * `HAS_USER_SWITCHER`, which is the flag `EditUserDialog` gates behind a confirmation.
 *
 * Port of c360's `components/custom/UserSwitcher`. The user list comes from
 * `~/lib/permissions/repository.getUsers()` (B0-404) instead of c360's Express endpoint. That helper
 * swallows failures into `{ data: [] }`, so an outage renders the picker with no options rather than
 * throwing on an admin page.
 *
 * Note this checks `HAS_USER_SWITCHER`, not a permission selector, so it is unaffected by shadow mode.
 */
export default async function UserSwitcher() {
  const [selectedUserFromCookie, canSwitchUsers, usersResponse] =
    await Promise.all([
      getUserOrDefault(),
      getAuthUserDetails('HAS_USER_SWITCHER'),
      getUsers(),
    ]);

  if (!canSwitchUsers) return null;

  const users = (usersResponse.data ?? []).filter((user: User) => user.EMAIL);
  const selectedUser = users.find(
    (user: User) => user.EMAIL === selectedUserFromCookie?.EMAIL,
  );
  const userInitials =
    selectedUser?.NAME?.split(/[\s_]+/)
      .filter(Boolean)
      .map((part: string) => part[0])
      .join('')
      .slice(0, 2) || 'NA';

  return (
    <UserSwitcherClient
      selectedUser={selectedUser}
      userInitials={userInitials}
      users={users}
    />
  );
}
