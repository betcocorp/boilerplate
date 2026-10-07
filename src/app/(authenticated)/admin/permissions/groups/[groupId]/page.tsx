import { ArrowLeft } from 'lucide-react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { DeleteGroupDialog } from '~/components/permissions/DeleteGroupDialog';
import { GroupAssignmentsEditor } from '~/components/permissions/GroupAssignmentsEditor';
import { GroupPermissionsSummary } from '~/components/permissions/GroupPermissionsSummary';
import { DetailItem } from '~/components/permissions/LabelValueDisplay';
import { MergeGroupDialog } from '~/components/permissions/MergeGroupDialog';
import PermissionChecker from '~/components/permissions/PermissionChecker';
import { PermissionsPageHeader } from '~/components/permissions/PermissionsPageHeader';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { PERMISSIONS } from '~/lib/permissions/constants';
import {
  getPermissionGroup,
  getPermissionGroupsList,
  getPermissionsList,
  getPermissionsUsersList,
} from '~/lib/permissions/repository';
import { formatDate } from '~/lib/utils/time';

type Props = { params: Promise<{ groupId: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { groupId } = await params;
  const res = await getPermissionGroup(groupId);
  return { title: `Permission Group: ${res.data?.SELECTOR ?? 'Group'}` };
}

export default async function PermissionGroupPage({ params }: Props) {
  await connection();
  const { groupId } = await params;

  const [groupRes, allPermsRes, allGroupsRes, allUsersRes] = await Promise.all([
    getPermissionGroup(groupId),
    getPermissionsList(),
    getPermissionGroupsList(),
    getPermissionsUsersList(),
  ]);

  // The repository returns the same empty envelope for "no such group" and "the query failed", so
  // both land on the 404 — as they did in c360.
  if (!groupRes.success || !groupRes.data) notFound();

  const group = groupRes.data;

  return (
    <main className="min-w-0 space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <PermissionsPageHeader
          description={group.DESCRIPTION ?? 'Permission group details'}
          eyebrow="Permission group"
          title={group.SELECTOR}
        >
          <Button asChild className="mt-2 -ml-3" size="sm" variant="ghost">
            <Link href="/admin/permissions">
              <ArrowLeft className="size-4" />
              Back to Permissions
            </Link>
          </Button>
        </PermissionsPageHeader>
        <PermissionChecker
          permission={PERMISSIONS.ADMIN_CARD_PERMISSIONS}
          route="/admin/permissions/groups/[groupId] actions"
        >
          <div className="flex flex-wrap items-center gap-2">
            <MergeGroupDialog
              allGroups={allGroupsRes.data}
              sourceGroup={{
                PERMISSION_GROUP_ID: group.PERMISSION_GROUP_ID,
                SELECTOR: group.SELECTOR,
              }}
            />
            <DeleteGroupDialog
              group={{
                PERMISSION_GROUP_ID: group.PERMISSION_GROUP_ID,
                SELECTOR: group.SELECTOR,
              }}
            />
          </div>
        </PermissionChecker>
      </div>

      <Card className="w-full rounded-3xl border border-border/60 shadow-none">
        <CardHeader className="gap-0">
          <CardTitle className="text-lg">Details</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-0 md:grid-cols-2">
          <DetailItem label="Selector" value={group.SELECTOR} />
          {group.DESCRIPTION ? (
            <DetailItem label="Description" value={group.DESCRIPTION} />
          ) : null}
          {group.START_AT || group.END_AT ? (
            <DetailItem
              label="Active window"
              value={
                <span className="flex flex-wrap gap-4">
                  {group.START_AT ? (
                    <span>Start {formatDate(group.START_AT)}</span>
                  ) : null}
                  {group.END_AT ? (
                    <span>End {formatDate(group.END_AT)}</span>
                  ) : null}
                </span>
              }
            />
          ) : null}
          <DetailItem
            className="md:col-span-2"
            label="Permissions in this group"
            value={<GroupPermissionsSummary permissions={groupRes.permissions} />}
          />
          <div className="col-span-1 flex justify-between border-t border-border pt-2 text-xs text-muted-foreground md:col-span-2">
            <span>Created {formatDate(group.CREATED_AT)}</span>
            <span>
              {group.UPDATED_AT ? `Updated ${formatDate(group.UPDATED_AT)}` : ''}
            </span>
          </div>
        </CardContent>
      </Card>

      <GroupAssignmentsEditor
        allGroups={allGroupsRes.data}
        allPermissions={allPermsRes.data}
        allUsers={allUsersRes.data}
        groupId={groupId}
        initialPermissionsInGroup={groupRes.permissions}
        initialUsersInGroup={groupRes.users}
      />
    </main>
  );
}
