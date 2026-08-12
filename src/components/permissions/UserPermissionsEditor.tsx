'use client';

import { ChevronRight, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
  PERMISSIONS_API_BASE,
  envelopeErrorMessage,
  readJsonEnvelope,
} from '~/components/permissions/api';
import {
  AssignmentColumn,
  AssignmentEmptyState,
  AssignmentGroupHeading,
  AssignmentRow,
} from '~/components/permissions/assignment-ui';
import { fetchGroupDetail } from '~/components/permissions/read-actions';
import { Button } from '~/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '~/components/ui/collapsible';
import { usePermissionsStore } from '~/lib/stores/permissions';
import type { Permission, PermissionGroup } from '~/types/permissions';

/** Lazily loads and lists a group's permissions, so an admin can see what a group actually grants. */
function GroupRow({
  action,
  group,
  onAction,
}: {
  action: 'add' | 'remove';
  group: PermissionGroup;
  onAction: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [permissions, setPermissions] = useState<Permission[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || permissions !== null) return;
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const data = await fetchGroupDetail(group.PERMISSION_GROUP_ID);
        if (cancelled) return;
        setPermissions(data.success ? data.permissions : []);
      } catch {
        if (!cancelled) setPermissions([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, permissions, group.PERMISSION_GROUP_ID]);

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <AssignmentRow
        action={action}
        description={group.DESCRIPTION}
        expand={
          <CollapsibleTrigger
            aria-label={
              open ? 'Hide group permissions' : 'Show group permissions'
            }
            className="shrink-0 rounded p-1 hover:bg-muted data-[state=open]:rotate-90"
          >
            <ChevronRight className="size-4 text-muted-foreground transition-transform" />
          </CollapsibleTrigger>
        }
        expanded={
          <CollapsibleContent>
            <div className="mt-2 ml-3 border-l-2 border-muted pl-3">
              {loading ? (
                <div className="flex items-center gap-1.5 py-0.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" />
                  Loading…
                </div>
              ) : permissions?.length ? (
                <ul className="space-y-0.5 py-0.5 text-xs text-muted-foreground">
                  {permissions.map((permission) => (
                    <li key={permission.PERMISSION_ID}>
                      {permission.SELECTOR}
                    </li>
                  ))}
                </ul>
              ) : permissions ? (
                <p className="py-0.5 text-xs text-muted-foreground">
                  No permissions.
                </p>
              ) : null}
            </div>
          </CollapsibleContent>
        }
        label={group.SELECTOR}
        onAction={onAction}
        typeLabel="Group"
      />
    </Collapsible>
  );
}

export type UserPermissionsEditorProps = {
  allGroups: PermissionGroup[];
  allPermissions: Permission[];
  initialAssignedGroupIds: string[];
  initialAssignedPermissionIds: string[];
  userId: string;
};

/**
 * Edits one user's group memberships and direct permissions, saved with a single
 * `PUT /api/admin/permissions/users/:userId/assignments` (that handler replaces both lists).
 * Port of c360's `components/custom/UserPermissionsEditor`; see `assignment-ui.tsx` for why the
 * drag-and-drop board became add/remove buttons.
 *
 * After a successful save it asks `POST /api/me/refresh-permissions` to rebuild the *current* admin's
 * Redis bundle and pushes the result into the client store, so editing your own access takes effect
 * without a re-login. That refresh is best-effort: a failure leaves the save intact.
 */
export function UserPermissionsEditor({
  allGroups,
  allPermissions,
  initialAssignedGroupIds,
  initialAssignedPermissionIds,
  userId,
}: UserPermissionsEditorProps) {
  const [assignedGroups, setAssignedGroups] = useState<PermissionGroup[]>(() => {
    const ids = new Set(initialAssignedGroupIds);
    return allGroups.filter((group) => ids.has(group.PERMISSION_GROUP_ID));
  });
  const [assignedPermissions, setAssignedPermissions] = useState<Permission[]>(
    () => {
      const ids = new Set(initialAssignedPermissionIds);
      return allPermissions.filter((permission) =>
        ids.has(permission.PERMISSION_ID),
      );
    },
  );
  const [saving, setSaving] = useState(false);

  const availableGroups = useMemo(
    () =>
      allGroups.filter(
        (group) =>
          !assignedGroups.some(
            (assigned) =>
              assigned.PERMISSION_GROUP_ID === group.PERMISSION_GROUP_ID,
          ),
      ),
    [allGroups, assignedGroups],
  );
  const availablePermissions = useMemo(
    () =>
      allPermissions.filter(
        (permission) =>
          !assignedPermissions.some(
            (assigned) => assigned.PERMISSION_ID === permission.PERMISSION_ID,
          ),
      ),
    [allPermissions, assignedPermissions],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(
        `${PERMISSIONS_API_BASE}/users/${encodeURIComponent(userId)}/assignments`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            permissionGroupIds: assignedGroups.map(
              (group) => group.PERMISSION_GROUP_ID,
            ),
            permissionIds: assignedPermissions.map(
              (permission) => permission.PERMISSION_ID,
            ),
          }),
        },
      );
      const data = await readJsonEnvelope(res);
      if (!res.ok) {
        toast.error(envelopeErrorMessage(data, 'Failed to save'));
        return;
      }
      toast.success('Assignments saved');

      try {
        const refreshRes = await fetch('/api/me/refresh-permissions', {
          method: 'POST',
        });
        const refreshData = await refreshRes.json().catch(() => ({}));
        if (refreshData.user != null && Array.isArray(refreshData.permissions)) {
          usePermissionsStore.getState().setFromApi({
            user: refreshData.user,
            permissions: refreshData.permissions,
          });
        }
      } catch {
        // Non-blocking: the store refreshes on its next load or re-login.
      }
    } catch (err) {
      console.error(err);
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }, [userId, assignedGroups, assignedPermissions]);

  const assignedCount = assignedGroups.length + assignedPermissions.length;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:grid-rows-2">
        <div className="flex min-h-0 flex-col md:row-span-2">
          <AssignmentColumn
            count={assignedCount}
            fullHeight
            title="Assigned to this user"
          >
            {assignedCount === 0 ? (
              <AssignmentEmptyState>
                Nothing assigned yet. Add groups and permissions from the columns
                on the right.
              </AssignmentEmptyState>
            ) : (
              <>
                {assignedGroups.length > 0 ? (
                  <div className="space-y-1.5">
                    <AssignmentGroupHeading>
                      Groups ({assignedGroups.length})
                    </AssignmentGroupHeading>
                    {assignedGroups.map((group) => (
                      <GroupRow
                        action="remove"
                        group={group}
                        key={group.PERMISSION_GROUP_ID}
                        onAction={() =>
                          setAssignedGroups((prev) =>
                            prev.filter(
                              (candidate) =>
                                candidate.PERMISSION_GROUP_ID !==
                                group.PERMISSION_GROUP_ID,
                            ),
                          )
                        }
                      />
                    ))}
                  </div>
                ) : null}
                {assignedPermissions.length > 0 ? (
                  <div className="space-y-1.5">
                    <AssignmentGroupHeading>
                      Permissions ({assignedPermissions.length})
                    </AssignmentGroupHeading>
                    {assignedPermissions.map((permission) => (
                      <AssignmentRow
                        action="remove"
                        description={permission.DESCRIPTION}
                        key={permission.PERMISSION_ID}
                        label={permission.SELECTOR}
                        onAction={() =>
                          setAssignedPermissions((prev) =>
                            prev.filter(
                              (candidate) =>
                                candidate.PERMISSION_ID !==
                                permission.PERMISSION_ID,
                            ),
                          )
                        }
                        typeLabel="Permission"
                      />
                    ))}
                  </div>
                ) : null}
              </>
            )}
          </AssignmentColumn>
        </div>

        <AssignmentColumn count={availableGroups.length} title="Available groups">
          {availableGroups.length === 0 ? (
            <AssignmentEmptyState>
              Every group is already assigned.
            </AssignmentEmptyState>
          ) : (
            availableGroups.map((group) => (
              <GroupRow
                action="add"
                group={group}
                key={group.PERMISSION_GROUP_ID}
                onAction={() =>
                  setAssignedGroups((prev) =>
                    [...prev, group].sort((a, b) =>
                      a.SELECTOR.localeCompare(b.SELECTOR),
                    ),
                  )
                }
              />
            ))
          )}
        </AssignmentColumn>

        <AssignmentColumn
          count={availablePermissions.length}
          title="Available permissions"
        >
          {availablePermissions.length === 0 ? (
            <AssignmentEmptyState>
              Every permission is already assigned.
            </AssignmentEmptyState>
          ) : (
            availablePermissions.map((permission) => (
              <AssignmentRow
                action="add"
                description={permission.DESCRIPTION}
                key={permission.PERMISSION_ID}
                label={permission.SELECTOR}
                onAction={() =>
                  setAssignedPermissions((prev) =>
                    [...prev, permission].sort((a, b) =>
                      a.SELECTOR.localeCompare(b.SELECTOR),
                    ),
                  )
                }
                typeLabel="Permission"
              />
            ))
          )}
        </AssignmentColumn>
      </div>

      <div>
        <Button className="rounded-2xl" disabled={saving} onClick={handleSave}>
          {saving ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Saving…
            </>
          ) : (
            'Save assignments'
          )}
        </Button>
      </div>
    </div>
  );
}
