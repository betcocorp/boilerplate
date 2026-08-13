'use client';

import {
  AddGroupForm,
  AddPermissionForm,
  AddUserForm,
} from '~/components/permissions/AddPermissionForms';
import { FilterablePermissionsList } from '~/components/permissions/FilterablePermissionsList';
import type { PermissionListItem } from '~/components/permissions/FilterablePermissionsList';
import { FilterableUserList } from '~/components/permissions/FilterableUserList';
import { Badge } from '~/components/ui/badge';
import { ClientOnly } from '~/components/ui/client-only';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import type { Permission, PermissionGroup } from '~/types/permissions';
import type User from '~/types/User';

const CARD_CLASS = 'rounded-3xl border border-border/60 shadow-none';

export type PermissionsPageInteractiveProps = {
  groups: PermissionGroup[];
  permissionItems: PermissionListItem[];
  permissions: Permission[];
  users: User[];
};

function PermissionsSkeleton() {
  return (
    <div
      aria-hidden
      className="grid animate-pulse grid-cols-1 gap-4 lg:grid-cols-2"
    >
      <div className="h-72 rounded-3xl bg-muted/40" />
      <div className="h-72 rounded-3xl bg-muted/40" />
      <div className="h-112 rounded-3xl bg-muted/40 lg:col-span-2" />
    </div>
  );
}

/**
 * The three interactive panels on `/admin/permissions`: groups, permissions, and users.
 *
 * Port of c360's `components/custom/PermissionsPageInteractive`, including its reason for existing:
 * Radix `Collapsible` derives `aria-controls` from a `useId` value that a layout effect can rewrite,
 * so under React 19 the SSR markup and the hydrated tree disagree. Rendering the panels only after
 * mount means there is no server markup to mismatch. c360 open-coded that with `useEffect`; here it
 * is the `ClientOnly` primitive this ticket adds.
 */
export function PermissionsPageInteractive({
  groups,
  permissionItems,
  permissions,
  users,
}: PermissionsPageInteractiveProps) {
  return (
    <ClientOnly fallback={<PermissionsSkeleton />}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <AddGroupForm />
          <Card className={`h-full ${CARD_CLASS}`}>
            <CardHeader className="gap-0">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Badge>{groups.length}</Badge>
                Groups
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FilterablePermissionsList items={groups} variant="group" />
            </CardContent>
          </Card>
        </div>

        <div className="flex flex-col gap-2">
          <AddPermissionForm />
          <Card className={`h-full ${CARD_CLASS}`}>
            <CardHeader className="gap-0">
              <CardTitle className="flex items-center gap-2 text-lg">
                <Badge>{permissions.length}</Badge>
                Permissions
              </CardTitle>
            </CardHeader>
            <CardContent>
              <FilterablePermissionsList
                items={permissionItems}
                variant="permission"
              />
            </CardContent>
          </Card>
        </div>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        <AddUserForm />
        <Card className={CARD_CLASS}>
          <CardHeader>
            <CardTitle className="text-lg">Users</CardTitle>
            <p className="text-sm text-muted-foreground">
              {users.length} user{users.length === 1 ? '' : 's'}. Select users to
              assign groups or permissions in bulk.
            </p>
          </CardHeader>
          <CardContent>
            <FilterableUserList
              groups={groups}
              permissions={permissions}
              users={users}
            />
          </CardContent>
        </Card>
      </div>
    </ClientOnly>
  );
}
