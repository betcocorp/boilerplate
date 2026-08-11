import { AdminSidebarNavClient } from '~/components/admin/AdminSidebarNavClient';
import { getUserOrDefault } from '~/lib/cookies-server';
import { PERMISSIONS } from '~/lib/permissions/constants';
import {
  isPermissionsEnforced,
  recordPermissionVerdict,
} from '~/lib/permissions/enforcement';
import {
  getCurrentUserPermissions,
  hasPermission,
} from '~/lib/permissions/permissions-server';

/**
 * The admin surfaces the sidebar can gate. Derived from the permission catalog so the nav and
 * `public.permission` stay in sync — every `navigation.sidebar.*` selector is evaluated here, plus
 * `admin.card.permissions`, which gates the Access control → Permissions link (B0-410) and is the one
 * nav selector that does not carry the `navigation.sidebar.` prefix. Without it that link would stay
 * visible even under enforcement, since only selectors in this list can end up in `denied`.
 */
const NAV_SELECTORS: string[] = [
  ...Object.values(PERMISSIONS).filter((selector) =>
    selector.startsWith('navigation.sidebar.'),
  ),
  PERMISSIONS.ADMIN_CARD_PERMISSIONS,
];

/**
 * Server half of the admin sidebar (B0-408): resolves the effective user's permissions once per
 * render, records one aggregated verdict for the nav surface, and hands the client component the
 * selectors to hide.
 *
 * While `BEX_PERMISSIONS_ENFORCED` is off nothing is hidden — that is the point of shadow mode. The
 * verdict log still tells us exactly which surfaces would vanish once the flag flips.
 */
export async function AdminSidebarNav() {
  const [permissions, user] = await Promise.all([
    getCurrentUserPermissions(),
    getUserOrDefault(),
  ]);
  const denied = NAV_SELECTORS.filter(
    (selector) => !hasPermission(permissions, selector),
  );
  const allowed = denied.length === 0;

  // One record for the whole surface rather than ten — the sidebar renders on every admin
  // navigation, and the denied set is the signal we care about.
  await recordPermissionVerdict({
    surface: 'nav',
    selector: allowed ? NAV_SELECTORS : denied,
    allowed,
    reason: allowed
      ? 'granted'
      : permissions.length === 0
        ? 'permissions-unavailable'
        : 'missing-permission',
    route: 'AdminSidebarNav',
    userId: user?.USER_ID ?? null,
    email: user?.EMAIL ?? null,
    detail: { grantedSelectorCount: NAV_SELECTORS.length - denied.length },
  });

  return (
    <AdminSidebarNavClient
      hiddenSelectors={isPermissionsEnforced() ? denied : []}
    />
  );
}
