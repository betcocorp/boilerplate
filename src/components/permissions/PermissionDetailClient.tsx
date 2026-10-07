'use client';

import { Pencil, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { type ReactNode, useState } from 'react';
import { toast } from 'sonner';

import PermissionCheckerClient from '~/components/permissions/PermissionCheckerClient';
import {
  PERMISSIONS_API_BASE,
  envelopeErrorMessage,
  readJsonEnvelope,
} from '~/components/permissions/api';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { formatDate } from '~/lib/utils/time';
import type { Permission, PermissionGroup } from '~/types/permissions';
import type User from '~/types/User';

const CARD_CLASS = 'rounded-3xl border border-border/60 shadow-none';

/** Card listing links to related groups or users, with an empty state. */
function RelatedListCard({
  children,
  description,
  emptyLabel,
  isEmpty,
  title,
}: {
  children: ReactNode;
  description: string;
  emptyLabel: string;
  isEmpty: boolean;
  title: string;
}) {
  return (
    <Card className={CARD_CLASS}>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <p className="text-sm text-muted-foreground">{description}</p>
      </CardHeader>
      <CardContent>
        {isEmpty ? (
          <p className="text-sm text-muted-foreground">{emptyLabel}</p>
        ) : (
          <ul className="space-y-2">{children}</ul>
        )}
      </CardContent>
    </Card>
  );
}

export type PermissionDetailClientProps = {
  /** Mirrors `PERMISSIONS_ENFORCED`; gates the Danger zone once enforcement is on. */
  enforced?: boolean;
  groups: PermissionGroup[];
  permission: Permission;
  permissionId: string;
  usersDirect: User[];
  usersViaGroups: User[];
};

/**
 * Inline editor plus the reverse index for one permission: which groups contain it, and which users
 * hold it directly or through a group. Port of c360's
 * `components/custom/PermissionDetailClient`, pointed at `PUT|DELETE /api/admin/permissions/:id`.
 */
export function PermissionDetailClient({
  enforced = false,
  groups,
  permission,
  permissionId,
  usersDirect,
  usersViaGroups,
}: PermissionDetailClientProps) {
  const router = useRouter();
  const [isEditing, setIsEditing] = useState(false);
  const [selector, setSelector] = useState(permission.SELECTOR);
  const [description, setDescription] = useState(permission.DESCRIPTION ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const handleSave = async () => {
    if (!selector.trim()) {
      toast.error('Selector is required');
      return;
    }
    setIsSaving(true);
    try {
      const res = await fetch(
        `${PERMISSIONS_API_BASE}/${encodeURIComponent(permissionId)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            selector: selector.trim(),
            description: description.trim() || null,
          }),
        },
      );
      const data = await readJsonEnvelope(res);
      if (!res.ok || !data.success) {
        toast.error(envelopeErrorMessage(data, 'Failed to update permission'));
        return;
      }
      toast.success('Permission updated');
      setIsEditing(false);
      router.refresh();
    } catch {
      toast.error('Failed to update permission');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      const res = await fetch(
        `${PERMISSIONS_API_BASE}/${encodeURIComponent(permissionId)}`,
        { method: 'DELETE' },
      );
      const data = await readJsonEnvelope(res);
      if (!res.ok || !data.success) {
        toast.error(envelopeErrorMessage(data, 'Failed to delete permission'));
        return;
      }
      toast.success('Permission deleted');
      router.push('/admin/permissions');
      router.refresh();
    } catch {
      toast.error('Failed to delete permission');
    } finally {
      setIsDeleting(false);
    }
  };

  // Users listed under "direct access" are not repeated under "via groups".
  const uniqueUsersViaGroups = usersViaGroups.filter(
    (user) => !usersDirect.some((direct) => direct.USER_ID === user.USER_ID),
  );

  const userLink = (user: User) => (
    <li key={user.USER_ID}>
      <Link
        className="text-sm font-medium text-primary hover:underline"
        href={`/admin/permissions/users/${encodeURIComponent(user.USER_ID)}`}
      >
        {user.NAME || user.EMAIL || user.USER_ID}
      </Link>
      <span className="ml-2 text-sm text-muted-foreground">{user.EMAIL}</span>
    </li>
  );

  return (
    <div className="flex flex-col gap-4">
      <Card className={CARD_CLASS}>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <CardTitle className="text-lg">Details</CardTitle>
          <div className="flex shrink-0 gap-2">
            {isEditing ? (
              <>
                <Button
                  onClick={() => {
                    setIsEditing(false);
                    setSelector(permission.SELECTOR);
                    setDescription(permission.DESCRIPTION ?? '');
                  }}
                  size="sm"
                  variant="outline"
                >
                  Cancel
                </Button>
                <Button disabled={isSaving} onClick={handleSave} size="sm">
                  {isSaving ? 'Saving…' : 'Save'}
                </Button>
              </>
            ) : (
              <Button
                onClick={() => setIsEditing(true)}
                size="sm"
                variant="outline"
              >
                <Pencil className="size-4" />
                Edit
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {isEditing ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="perm-selector">Selector</Label>
                <Input
                  id="perm-selector"
                  onChange={(event) => setSelector(event.target.value)}
                  placeholder="e.g. navigation.sidebar.example"
                  value={selector}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="perm-description">Description</Label>
                <Textarea
                  className="resize-none"
                  id="perm-description"
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="Optional description"
                  rows={2}
                  value={description}
                />
              </div>
            </>
          ) : (
            <>
              <div>
                <span className="text-sm font-medium text-muted-foreground">
                  Selector
                </span>
                <p className="mt-0.5 font-mono text-sm">
                  {permission.SELECTOR}
                </p>
              </div>
              {permission.DESCRIPTION ? (
                <div>
                  <span className="text-sm font-medium text-muted-foreground">
                    Description
                  </span>
                  <p className="mt-0.5 text-sm">{permission.DESCRIPTION}</p>
                </div>
              ) : null}
              <div className="flex flex-wrap gap-4 border-t border-border pt-2 text-xs text-muted-foreground">
                <span>Created {formatDate(permission.CREATED_AT)}</span>
                {permission.UPDATED_AT ? (
                  <span>Updated {formatDate(permission.UPDATED_AT)}</span>
                ) : null}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <PermissionCheckerClient
        enforced={enforced}
        permission={PERMISSIONS.ADMIN_CARD_PERMISSIONS}
      >
        <Card className={CARD_CLASS}>
          <CardHeader className="flex flex-row items-center justify-between gap-4">
            <CardTitle className="text-lg">Danger zone</CardTitle>
            <Dialog>
              <DialogTrigger asChild>
                <Button size="sm" variant="destructive">
                  <Trash2 className="size-4" />
                  Delete permission
                </Button>
              </DialogTrigger>
              <DialogContent className="rounded-3xl">
                <DialogHeader>
                  <DialogTitle>Delete this permission?</DialogTitle>
                  <DialogDescription>
                    This soft-deletes the permission. Groups and users will no
                    longer have it. An administrator can reverse this.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button type="button" variant="outline">
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button
                    disabled={isDeleting}
                    onClick={handleDelete}
                    variant="destructive"
                  >
                    {isDeleting ? 'Deleting…' : 'Delete'}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </CardHeader>
        </Card>
      </PermissionCheckerClient>

      <RelatedListCard
        description={`${groups.length} group${groups.length === 1 ? '' : 's'} include this permission.`}
        emptyLabel="No groups have this permission."
        isEmpty={groups.length === 0}
        title="Groups with this permission"
      >
        {groups.map((group) => (
          <li key={group.PERMISSION_GROUP_ID}>
            <Link
              className="text-sm font-medium text-primary hover:underline"
              href={`/admin/permissions/groups/${encodeURIComponent(group.PERMISSION_GROUP_ID)}`}
            >
              {group.SELECTOR}
            </Link>
            {group.DESCRIPTION ? (
              <span className="ml-2 text-sm text-muted-foreground">
                — {group.DESCRIPTION}
              </span>
            ) : null}
          </li>
        ))}
      </RelatedListCard>

      <RelatedListCard
        description="Users assigned this permission directly (not via a group)."
        emptyLabel="No users have direct access."
        isEmpty={usersDirect.length === 0}
        title="Users with direct access"
      >
        {usersDirect.map(userLink)}
      </RelatedListCard>

      <RelatedListCard
        description="Users who have this permission through at least one of the groups above."
        emptyLabel="No users have access only via groups."
        isEmpty={uniqueUsersViaGroups.length === 0}
        title="Users with access via groups"
      >
        {uniqueUsersViaGroups.map(userLink)}
      </RelatedListCard>
    </div>
  );
}
