import type { Metadata } from 'next';
import { connection } from 'next/server';

import { PermissionCoverageTiles } from '~/components/permissions/PermissionCoverageTiles';
import type { PermissionListItem } from '~/components/permissions/FilterablePermissionsList';
import { PermissionsPageHeader } from '~/components/permissions/PermissionsPageHeader';
import { PermissionsPageInteractive } from '~/components/permissions/PermissionsPageInteractive';
import UserSwitcher from '~/components/permissions/UserSwitcher';
import { summarizePermissionCatalog } from '~/components/permissions/catalog-audit';
import { PERMISSIONS } from '~/lib/permissions/constants';
import {
  getPermissionGroupsList,
  getPermissionsList,
  getPermissionsUsersList,
} from '~/lib/permissions/repository';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';

export const metadata: Metadata = {
  title: 'Permissions | Betco BEX Admin',
  description: 'Manage users, permission groups, and permission selectors.',
};

export default async function PermissionsPage() {
  await requirePagePermission(
    PERMISSIONS.ADMIN_CARD_PERMISSIONS,
    'GET /admin/permissions',
  );

  await connection();

  const [permissionsRes, groupsRes, usersRes] = await Promise.all([
    getPermissionsList(),
    getPermissionGroupsList(),
    getPermissionsUsersList(),
  ]);

  // The repository swallows failures into `{ success: false, data: [] }`, so these are always arrays
  // and every panel below degrades to its own empty state rather than throwing.
  const permissions = permissionsRes.data;
  const groups = groupsRes.data;
  const users = usersRes.data;

  const audit = summarizePermissionCatalog(
    Object.values(PERMISSIONS),
    permissions.map((permission) => permission.SELECTOR),
  );
  const catalogSelectors = new Set(audit.catalogSelectors);

  /** Does the app check `selector` (directly, or via a `.*` row covering catalog selectors)? */
  const isUsedInCode = (selector: string): boolean => {
    if (selector === '*') return catalogSelectors.size > 0;
    if (selector.endsWith('.*')) {
      const prefix = selector.slice(0, -2);
      return audit.catalogSelectors.some((candidate) =>
        candidate.startsWith(`${prefix}.`),
      );
    }
    return catalogSelectors.has(selector);
  };

  const permissionItems: PermissionListItem[] = [
    ...permissions.map((permission) => ({
      ...permission,
      deploymentStatus: 'deployed' as const,
      isVirtual: false,
      usedInCode: isUsedInCode(permission.SELECTOR),
    })),
    // Selectors the app checks with no `public.permission` row: shown, but with no detail page.
    ...audit.missingInDb.map((selector) => ({
      PERMISSION_ID: `virtual-${selector}`,
      SELECTOR: selector,
      DESCRIPTION: null,
      CREATED_AT: '',
      UPDATED_AT: '',
      DELETED_AT: null,
      deploymentStatus: 'undeployed' as const,
      isVirtual: true,
      usedInCode: true,
    })),
  ];

  return (
    <main className="min-w-0 space-y-4 p-4 sm:p-6">
      <PermissionsPageHeader
        description="Every user, permission group, and permission selector, plus how well the deployed selectors match the ones the app checks."
        title="Users, Groups & Permissions"
      />

      <PermissionCoverageTiles audit={audit} />

      <PermissionsPageInteractive
        groups={groups}
        permissionItems={permissionItems}
        permissions={permissions}
        users={users}
      />
    </main>
  );
}
