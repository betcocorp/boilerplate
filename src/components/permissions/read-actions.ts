'use server';

/**
 * Gated server actions for the two lazy row-expansion reads the permissions UI needs.
 *
 * **Why these exist.** c360's list components expanded a row by fetching
 * `GET /api/proxy/permissions/groups/:id` and `GET /api/proxy/permissions/users/:id`. B0-409 ports
 * only the *mutations* (plus `merge-preview`), so neither GET exists under
 * `/api/admin/permissions/**` — those URLs answer 405. Rather than leave four call sites silently
 * rendering empty expansions, they call these actions.
 *
 * Same gate as the mutation handlers (`guardPermissionsAdmin`): a server action is a publicly
 * reachable endpoint, so authentication and `admin.card.permissions` are checked here and not left to
 * the caller. `requirePermission` covers both — no session yields `allowed: false` outright, while an
 * authorization failure is shadow-allowed until `BEX_PERMISSIONS_ENFORCED` flips (B0-408).
 *
 * A refused or failed read returns the same empty-but-valid envelope the repository uses, so the UI
 * shows "nothing assigned" instead of throwing inside a collapsible.
 */

import { PERMISSIONS } from '~/lib/permissions/constants';
import {
  getPermissionGroup,
  getPermissionsUser,
} from '~/lib/permissions/repository';
import { requirePermission } from '~/lib/permissions/require-permission';
import type { Permission } from '~/types/permissions';
import type User from '~/types/User';

async function isPermissionsAdmin(route: string): Promise<boolean> {
  const result = await requirePermission(PERMISSIONS.ADMIN_CARD_PERMISSIONS, {
    route,
  });
  return result.allowed;
}

/** One group's permissions and members, for an expanded group row. */
export async function fetchGroupDetail(groupId: string): Promise<{
  success: boolean;
  permissions: Permission[];
  users: User[];
}> {
  const empty = { success: false, permissions: [], users: [] };
  if (!(await isPermissionsAdmin('action fetchGroupDetail'))) return empty;

  const id = String(groupId ?? '').trim();
  if (!id) return empty;

  const result = await getPermissionGroup(id);
  return {
    success: result.success,
    permissions: result.permissions,
    users: result.users,
  };
}

/** One user's assigned group and permission ids, for an expanded user row. */
export async function fetchUserAssignments(userId: string): Promise<{
  success: boolean;
  permissionGroupIds: string[];
  permissionIds: string[];
}> {
  const empty = {
    success: false,
    permissionGroupIds: [],
    permissionIds: [],
  };
  if (!(await isPermissionsAdmin('action fetchUserAssignments'))) return empty;

  const id = String(userId ?? '').trim();
  if (!id) return empty;

  const result = await getPermissionsUser(id);
  return {
    success: result.success,
    permissionGroupIds: result.permissionGroupIds,
    permissionIds: result.permissionIds,
  };
}
