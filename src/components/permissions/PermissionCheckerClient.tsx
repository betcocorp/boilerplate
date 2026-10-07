'use client';

import { type ReactNode, useEffect } from 'react';

import { usePermissionsStore } from '~/lib/stores/permissions';

/**
 * Client-side sibling of `PermissionChecker`, for gating UI inside an existing client component
 * (where an async server component cannot be rendered). Port of c360's
 * `components/custom/PermissionCheckerClient`.
 *
 * The store loads itself on first use — there is no global provider (B0-407).
 *
 * `enforced` mirrors `PERMISSIONS_ENFORCED`, which a client component cannot read. It has to be
 * threaded down from a server component; the default of `false` matches phase-1 shadow mode, so
 * nothing is hidden until a caller opts in.
 */
export default function PermissionCheckerClient({
  children,
  enforced = false,
  permission,
}: {
  children: ReactNode;
  enforced?: boolean;
  permission: string;
}) {
  const loaded = usePermissionsStore((state) => state.loaded);
  const load = usePermissionsStore((state) => state.load);
  const hasPermission = usePermissionsStore((state) => state.hasPermission);

  useEffect(() => {
    if (!loaded) void load();
  }, [loaded, load]);

  if (permission === 'na' || !enforced) return <>{children}</>;

  // Never flash protected UI before the store has answered.
  if (!loaded) return null;
  if (!hasPermission(permission)) return null;

  return <>{children}</>;
}
