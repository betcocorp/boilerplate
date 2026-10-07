import type { ReactNode } from 'react';

import { getUserOrDefault } from '~/lib/cookies-server';
import {
  isPermissionsEnforced,
  recordPermissionVerdict,
} from '~/lib/permissions/enforcement';
import {
  getCurrentUserPermissions,
  hasPermission,
} from '~/lib/permissions/permissions-server';

/**
 * Server-component gate: renders `children` only if the effective user holds `permission`.
 *
 * Port of c360's `components/custom/PermissionChecker`, with two this app differences:
 *
 * 1. c360 compared with `permissions.includes(permission)`, so a user holding `admin.*` or `*` was
 *    denied. This uses the shared `hasPermission()` so wildcards resolve the same way here, in
 *    `requirePermission`, and in the client store.
 * 2. It honours shadow mode (B0-408). While `PERMISSIONS_ENFORCED` is off the verdict is
 *    computed and recorded but `children` still render — nothing is hidden until the flag flips.
 *
 * `permission="na"` renders unconditionally, as in c360.
 */
export default async function PermissionChecker({
  children,
  permission,
  route,
}: {
  children: ReactNode;
  permission: string;
  /** Verdict label for the audit trail; defaults to the component name plus the selector. */
  route?: string;
}) {
  if (permission === 'na') return <>{children}</>;

  const [permissions, user] = await Promise.all([
    getCurrentUserPermissions(),
    getUserOrDefault(),
  ]);
  const allowed = hasPermission(permissions, permission);

  await recordPermissionVerdict({
    surface: 'nav',
    selector: permission,
    allowed,
    reason: allowed
      ? 'granted'
      : permissions.length === 0
        ? 'permissions-unavailable'
        : 'missing-permission',
    route: route ?? `PermissionChecker(${permission})`,
    userId: user?.USER_ID ?? null,
    email: user?.EMAIL ?? null,
  });

  if (!allowed && (await isPermissionsEnforced())) return null;
  return <>{children}</>;
}
