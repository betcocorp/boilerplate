'use client';

import { ChevronRight, Loader2 } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import {
  PERMISSIONS_API_BASE,
  envelopeErrorMessage,
  readJsonEnvelope,
} from '~/components/permissions/api';
import {
  AssignmentColumn,
  AssignmentEmptyState,
  AssignmentFilterInput,
  AssignmentGroupHeading,
  AssignmentRow,
} from '~/components/permissions/assignment-ui';
import { fetchUserAssignments } from '~/components/permissions/read-actions';
import { Button } from '~/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '~/components/ui/collapsible';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import type { Permission, PermissionGroup } from '~/types/permissions';
import type User from '~/types/User';

export type AssignedFilterType = 'all' | 'users' | 'permissions';

type UserAssignments = {
  permissionGroupIds: string[];
  permissionIds: string[];
};

/**
 * A user row that can expand to show that user's *other* groups and permissions — the context an
 * admin needs before removing them from this group.
 */
function UserRow({
  action,
  allGroups,
  allPermissions,
  onAction,
  user,
}: {
  action: 'add' | 'remove';
  allGroups: PermissionGroup[];
  allPermissions: Permission[];
  onAction: () => void;
  user: User;
}) {
  const [open, setOpen] = useState(false);
  const [assignments, setAssignments] = useState<UserAssignments | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchAssignments = useCallback(async () => {
    if (assignments !== null) return;
    setLoading(true);
    try {
      const data = await fetchUserAssignments(user.USER_ID);
      setAssignments(
        data.success
          ? {
              permissionGroupIds: data.permissionGroupIds,
              permissionIds: data.permissionIds,
            }
          : { permissionGroupIds: [], permissionIds: [] },
      );
    } catch {
      setAssignments({ permissionGroupIds: [], permissionIds: [] });
    } finally {
      setLoading(false);
    }
  }, [assignments, user.USER_ID]);

  const groupSelectors = useMemo(
    () =>
      (assignments?.permissionGroupIds ?? []).map(
        (id) =>
          allGroups.find((group) => group.PERMISSION_GROUP_ID === id)
            ?.SELECTOR ?? id,
      ),
    [assignments, allGroups],
  );
  const permissionSelectors = useMemo(
    () =>
      (assignments?.permissionIds ?? []).map(
        (id) =>
          allPermissions.find((permission) => permission.PERMISSION_ID === id)
            ?.SELECTOR ?? id,
      ),
    [assignments, allPermissions],
  );

  return (
    <Collapsible
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void fetchAssignments();
      }}
      open={open}
    >
      <AssignmentRow
        action={action}
        description={user.EMAIL || null}
        expand={
          <CollapsibleTrigger
            aria-label={
              open
                ? 'Hide groups and permissions'
                : 'Show groups and permissions'
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
                <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading groups and permissions…
                </div>
              ) : assignments ? (
                <div className="space-y-2 py-1 text-sm text-muted-foreground">
                  {groupSelectors.length > 0 ? (
                    <div>
                      <span className="font-medium text-foreground/80">
                        Groups:
                      </span>
                      <ul className="mt-0.5 list-none space-y-0.5 pl-0">
                        {groupSelectors.map((selector) => (
                          <li key={selector}>{selector}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {permissionSelectors.length > 0 ? (
                    <div>
                      <span className="font-medium text-foreground/80">
                        Permissions:
                      </span>
                      <ul className="mt-0.5 list-none space-y-0.5 pl-0">
                        {permissionSelectors.map((selector) => (
                          <li key={selector}>{selector}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {groupSelectors.length === 0 &&
                  permissionSelectors.length === 0 ? (
                    <p>No groups or permissions assigned.</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </CollapsibleContent>
        }
        label={user.NAME || user.EMAIL || user.USER_ID}
        meta={[user.TITLE, user.DEPARTMENT].filter(Boolean).join(' · ') || null}
        onAction={onAction}
        typeLabel="User"
      />
    </Collapsible>
  );
}

export type GroupAssignmentsEditorProps = {
  allGroups?: PermissionGroup[];
  allPermissions: Permission[];
  allUsers: User[];
  groupId: string;
  initialPermissionsInGroup: Permission[];
  initialUsersInGroup: User[];
};

/**
 * Edits one permission group's members **and** its permissions, then saves both with a single
 * `PUT /api/admin/permissions/groups/:groupId/assignments` (that handler replaces both lists, which
 * is why they are edited together). Port of c360's `components/custom/GroupAssignmentsEditor`; see
 * `assignment-ui.tsx` for why the drag-and-drop board became add/remove buttons.
 */
export function GroupAssignmentsEditor({
  allGroups = [],
  allPermissions,
  allUsers,
  groupId,
  initialPermissionsInGroup,
  initialUsersInGroup,
}: GroupAssignmentsEditorProps) {
  const [assignedUsers, setAssignedUsers] =
    useState<User[]>(initialUsersInGroup);
  const [assignedPermissions, setAssignedPermissions] = useState<Permission[]>(
    initialPermissionsInGroup,
  );
  const [availableUsersFilter, setAvailableUsersFilter] = useState('');
  const [availablePermsFilter, setAvailablePermsFilter] = useState('');
  const [assignedFilterType, setAssignedFilterType] =
    useState<AssignedFilterType>('all');
  const [assignedFilterText, setAssignedFilterText] = useState('');
  const [saving, setSaving] = useState(false);

  const availableUsers = useMemo(
    () =>
      allUsers.filter(
        (user) =>
          !assignedUsers.some(
            (assigned) => assigned.USER_ID === user.USER_ID,
          ),
      ),
    [allUsers, assignedUsers],
  );
  const availableUsersFiltered = useMemo(() => {
    const query = availableUsersFilter.trim().toLowerCase();
    if (!query) return availableUsers;
    return availableUsers.filter(
      (user) =>
        (user.NAME ?? '').toLowerCase().includes(query) ||
        (user.EMAIL ?? '').toLowerCase().includes(query),
    );
  }, [availableUsers, availableUsersFilter]);

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
  const availablePermissionsFiltered = useMemo(() => {
    const query = availablePermsFilter.trim().toLowerCase();
    if (!query) return availablePermissions;
    return availablePermissions.filter(
      (permission) =>
        (permission.SELECTOR ?? '').toLowerCase().includes(query) ||
        (permission.DESCRIPTION ?? '').toLowerCase().includes(query),
    );
  }, [availablePermissions, availablePermsFilter]);

  const assignedUsersFiltered = useMemo(() => {
    if (assignedFilterType === 'permissions') return [];
    const query = assignedFilterText.trim().toLowerCase();
    const sorted = [...assignedUsers].sort((a, b) =>
      (a.NAME ?? '').localeCompare(b.NAME ?? ''),
    );
    if (!query) return sorted;
    return sorted.filter(
      (user) =>
        (user.NAME ?? '').toLowerCase().includes(query) ||
        (user.EMAIL ?? '').toLowerCase().includes(query),
    );
  }, [assignedUsers, assignedFilterText, assignedFilterType]);

  const assignedPermissionsFiltered = useMemo(() => {
    if (assignedFilterType === 'users') return [];
    const query = assignedFilterText.trim().toLowerCase();
    const sorted = [...assignedPermissions].sort((a, b) =>
      a.SELECTOR.localeCompare(b.SELECTOR),
    );
    if (!query) return sorted;
    return sorted.filter(
      (permission) =>
        permission.SELECTOR.toLowerCase().includes(query) ||
        (permission.DESCRIPTION ?? '').toLowerCase().includes(query),
    );
  }, [assignedPermissions, assignedFilterText, assignedFilterType]);

  const assignedTotalCount = assignedUsers.length + assignedPermissions.length;
  const assignedShownCount =
    assignedUsersFiltered.length + assignedPermissionsFiltered.length;

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch(
        `${PERMISSIONS_API_BASE}/groups/${encodeURIComponent(groupId)}/assignments`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            userIds: assignedUsers.map((user) => user.USER_ID),
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
      toast.success('Group assignments saved');
    } catch (err) {
      console.error(err);
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }, [groupId, assignedUsers, assignedPermissions]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 md:grid-rows-2">
        <div className="flex min-h-0 flex-col md:row-span-2">
          <AssignmentColumn
            controls={
              <div className="grid grid-cols-1 gap-2 lg:grid-cols-2 lg:gap-4">
                <AssignmentFilterInput
                  ariaLabel="Filter items in this group"
                  onChange={setAssignedFilterText}
                  placeholder="Search by name, email, or selector…"
                  value={assignedFilterText}
                />
                <Select
                  onValueChange={(value) =>
                    setAssignedFilterType(value as AssignedFilterType)
                  }
                  value={assignedFilterType}
                >
                  <SelectTrigger className="h-9 w-full">
                    <SelectValue placeholder="Show…" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="users">Users only</SelectItem>
                    <SelectItem value="permissions">
                      Permissions only
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            }
            count={assignedShownCount}
            fullHeight
            title="In this group"
            totalCount={assignedTotalCount}
          >
            {assignedShownCount === 0 ? (
              <AssignmentEmptyState>
                {assignedTotalCount === 0
                  ? 'Nothing is in this group yet. Add users and permissions from the columns on the right.'
                  : 'Nothing matches the filter.'}
              </AssignmentEmptyState>
            ) : (
              <>
                {assignedUsersFiltered.length > 0 ? (
                  <div className="space-y-1.5">
                    <AssignmentGroupHeading>
                      Users ({assignedUsersFiltered.length})
                    </AssignmentGroupHeading>
                    {assignedUsersFiltered.map((user) => (
                      <UserRow
                        action="remove"
                        allGroups={allGroups}
                        allPermissions={allPermissions}
                        key={user.USER_ID}
                        onAction={() =>
                          setAssignedUsers((prev) =>
                            prev.filter(
                              (candidate) =>
                                candidate.USER_ID !== user.USER_ID,
                            ),
                          )
                        }
                        user={user}
                      />
                    ))}
                  </div>
                ) : null}
                {assignedPermissionsFiltered.length > 0 ? (
                  <div className="space-y-1.5">
                    <AssignmentGroupHeading>
                      Permissions ({assignedPermissionsFiltered.length})
                    </AssignmentGroupHeading>
                    {assignedPermissionsFiltered.map((permission) => (
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

        <AssignmentColumn
          controls={
            <AssignmentFilterInput
              ariaLabel="Filter available users"
              onChange={setAvailableUsersFilter}
              placeholder="Search by name or email…"
              value={availableUsersFilter}
            />
          }
          count={availableUsersFiltered.length}
          title="Available users"
          totalCount={availableUsers.length}
        >
          {availableUsersFiltered.length === 0 ? (
            <AssignmentEmptyState>
              {availableUsers.length === 0
                ? 'Every user is already in this group.'
                : 'No users match the filter.'}
            </AssignmentEmptyState>
          ) : (
            availableUsersFiltered.map((user) => (
              <UserRow
                action="add"
                allGroups={allGroups}
                allPermissions={allPermissions}
                key={user.USER_ID}
                onAction={() =>
                  setAssignedUsers((prev) =>
                    [...prev, user].sort((a, b) =>
                      (a.NAME ?? '').localeCompare(b.NAME ?? ''),
                    ),
                  )
                }
                user={user}
              />
            ))
          )}
        </AssignmentColumn>

        <AssignmentColumn
          controls={
            <AssignmentFilterInput
              ariaLabel="Filter available permissions"
              onChange={setAvailablePermsFilter}
              placeholder="Filter by selector or description…"
              value={availablePermsFilter}
            />
          }
          count={availablePermissionsFiltered.length}
          title="Available permissions"
          totalCount={availablePermissions.length}
        >
          {availablePermissionsFiltered.length === 0 ? (
            <AssignmentEmptyState>
              {availablePermissions.length === 0
                ? 'Every permission is already in this group.'
                : 'No permissions match the filter.'}
            </AssignmentEmptyState>
          ) : (
            availablePermissionsFiltered.map((permission) => (
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
