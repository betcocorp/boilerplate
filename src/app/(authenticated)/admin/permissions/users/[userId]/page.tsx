import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { DetailItem } from '~/components/permissions/LabelValueDisplay';
import { PermissionsPageHeader } from '~/components/permissions/PermissionsPageHeader';
import { UserPermissionsEditor } from '~/components/permissions/UserPermissionsEditor';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import {
  getPermissionGroup,
  getPermissionGroupsList,
  getPermissionsList,
  getPermissionsUser,
} from '~/lib/permissions/repository';

type Props = { params: Promise<{ userId: string }> };

type AccessBadgeItem = { href?: string; key: string; label: string };

/** Monospaced selector badges, linked to their detail page where there is one. */
function AccessBadgeList({
  emptyLabel,
  items,
}: {
  emptyLabel: string;
  items: AccessBadgeItem[];
}) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {items.map((item) => (
        <Badge
          asChild={Boolean(item.href)}
          className="font-mono text-xs"
          key={item.key}
          variant="secondary"
        >
          {item.href ? (
            <Link href={item.href}>{item.label}</Link>
          ) : (
            <span>{item.label}</span>
          )}
        </Badge>
      ))}
    </div>
  );
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { userId } = await params;
  const res = await getPermissionsUser(userId);
  return { title: `User: ${res.data?.NAME || 'User'}` };
}

export default async function PermissionUserPage({ params }: Props) {
  await connection();
  const { userId } = await params;

  const [userRes, groupsRes, permissionsRes] = await Promise.all([
    getPermissionsUser(userId),
    getPermissionGroupsList(),
    getPermissionsList(),
  ]);

  if (!userRes.success || !userRes.data) notFound();

  const user = userRes.data;
  const allGroups = groupsRes.data;
  const allPermissions = permissionsRes.data;

  // Each assigned group is fetched for its permissions, which is what makes the inherited list below
  // possible. Bounded by the number of groups a single user is in (7 groups exist in total).
  const assignedGroupDetails = await Promise.all(
    userRes.permissionGroupIds.map((groupId) => getPermissionGroup(groupId)),
  );

  const groupSelectorById = new Map(
    allGroups.map((group) => [group.PERMISSION_GROUP_ID, group.SELECTOR]),
  );
  const permissionSelectorById = new Map(
    allPermissions.map((permission) => [
      permission.PERMISSION_ID,
      permission.SELECTOR,
    ]),
  );

  const assignedGroups = userRes.permissionGroupIds
    .map((groupId) => ({
      href: `/admin/permissions/groups/${encodeURIComponent(groupId)}`,
      key: groupId,
      label: groupSelectorById.get(groupId) ?? groupId,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const assignedPermissions = userRes.permissionIds
    .map((permissionId) => ({
      href: `/admin/permissions/permissions/${encodeURIComponent(permissionId)}`,
      key: permissionId,
      label: permissionSelectorById.get(permissionId) ?? permissionId,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));

  // De-duplicated by permission id: two groups granting the same permission list it once.
  const inheritedPermissions = [
    ...new Map(
      assignedGroupDetails
        .filter((groupRes) => groupRes.success)
        .flatMap((groupRes) =>
          groupRes.permissions.map((permission) => [
            permission.PERMISSION_ID,
            {
              href: `/admin/permissions/permissions/${encodeURIComponent(permission.PERMISSION_ID)}`,
              key: permission.PERMISSION_ID,
              label: permission.SELECTOR,
            },
          ]),
        ),
    ).values(),
  ].sort((a, b) => a.label.localeCompare(b.label));

  return (
    <main className="min-w-0 space-y-4 p-4 sm:p-6">
      <PermissionsPageHeader
        description={user.EMAIL || 'User permissions'}
        eyebrow="User"
        title={user.NAME || user.EMAIL || userId}
      >
        <Button asChild className="mt-2 -ml-3" size="sm" variant="ghost">
          <Link href="/admin/permissions">
            <ArrowLeft className="size-4" />
            Back to Permissions
          </Link>
        </Button>
      </PermissionsPageHeader>

      <Card className="w-full rounded-3xl border border-border/60 shadow-none">
        <CardHeader className="gap-0">
          <CardTitle className="text-lg">Details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-0 md:grid-cols-2">
          <DetailItem label="Name" value={user.NAME || '—'} />
          <DetailItem label="Email" value={user.EMAIL || '—'} />
          {user.PHONE ? <DetailItem label="Phone" value={user.PHONE} /> : null}
          {user.TITLE || user.DEPARTMENT ? (
            <DetailItem
              label="Title / department"
              value={
                [user.TITLE, user.DEPARTMENT].filter(Boolean).join(' · ') || '—'
              }
            />
          ) : null}
          <DetailItem
            className="md:col-span-2"
            label="Assigned groups"
            value={
              <div className="space-y-3">
                <AccessBadgeList
                  emptyLabel="No groups assigned."
                  items={assignedGroups}
                />
                <div className="space-y-2">
                  <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Inherited permissions from groups
                  </p>
                  <AccessBadgeList
                    emptyLabel="No inherited permissions from assigned groups."
                    items={inheritedPermissions}
                  />
                </div>
              </div>
            }
          />
          <DetailItem
            className="md:col-span-2"
            label="Assigned permissions"
            value={
              <AccessBadgeList
                emptyLabel="No direct permissions assigned."
                items={assignedPermissions}
              />
            }
          />
        </CardContent>
      </Card>

      <UserPermissionsEditor
        allGroups={allGroups}
        allPermissions={allPermissions}
        initialAssignedGroupIds={userRes.permissionGroupIds}
        initialAssignedPermissionIds={userRes.permissionIds}
        userId={userId}
      />
    </main>
  );
}
