'use client';

import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  UserPlus,
} from 'lucide-react';
import Link from 'next/link';
import { type ReactNode, useCallback, useMemo, useState } from 'react';
import { toast } from 'sonner';

import { EditUserDialog } from '~/components/permissions/EditUserDialog';
import {
  PERMISSIONS_API_BASE,
  envelopeErrorMessage,
  readJsonEnvelope,
} from '~/components/permissions/api';
import { fetchUserAssignments } from '~/components/permissions/read-actions';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Checkbox } from '~/components/ui/checkbox';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '~/components/ui/collapsible';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import type { Permission, PermissionGroup } from '~/types/permissions';
import type User from '~/types/User';

type UserAssignments = {
  permissionGroupIds: string[];
  permissionIds: string[];
};

/**
 * `IS_ACTIVE` is a real boolean on `app_user`, but the wire shape has carried 0/1 and 'true'/'t'
 * from Snowflake, so the coercion c360 needed is kept.
 */
function isActiveUser(user: User): boolean {
  const raw = (user as Record<string, unknown>).IS_ACTIVE;
  if (raw === true || raw === 1) return true;
  if (typeof raw === 'string') {
    const value = raw.trim().toLowerCase();
    return value === 'true' || value === 't' || value === '1' || value === 'yes';
  }
  return false;
}

/** One user row; expanding it lazily loads that user's group and permission assignments. */
function UserRowWithAssignments({
  checkbox,
  groups,
  onEdit,
  permissions,
  user,
}: {
  checkbox: ReactNode;
  groups: PermissionGroup[];
  onEdit?: (user: User) => void;
  permissions: Permission[];
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
  }, [user.USER_ID, assignments]);

  const groupSelectors = useMemo(
    () =>
      (assignments?.permissionGroupIds ?? []).map(
        (id) =>
          groups.find((group) => group.PERMISSION_GROUP_ID === id)?.SELECTOR ??
          id,
      ),
    [assignments, groups],
  );
  const permissionSelectors = useMemo(
    () =>
      (assignments?.permissionIds ?? []).map(
        (id) =>
          permissions.find((permission) => permission.PERMISSION_ID === id)
            ?.SELECTOR ?? id,
      ),
    [assignments, permissions],
  );

  return (
    <Collapsible
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void fetchAssignments();
      }}
      open={open}
    >
      <div className="flex min-w-0 items-center gap-3">
        {checkbox}
        <div className="flex flex-1 flex-col gap-0.5 lg:flex-row">
          <Link
            className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-md py-1 focus:ring-2 focus:ring-ring focus:outline-none hover:opacity-80 focus:opacity-80"
            href={`/admin/permissions/users/${encodeURIComponent(user.USER_ID)}`}
          >
            <span className="flex items-center gap-2 font-medium text-foreground">
              {user.NAME || user.EMAIL || user.USER_ID}
              {isActiveUser(user) ? (
                <Badge className="text-xs" variant="ghost">
                  Active
                </Badge>
              ) : (
                <span className="text-xs text-muted-foreground">Inactive</span>
              )}
            </span>
            <span className="truncate text-sm text-muted-foreground">
              {user.EMAIL}
            </span>
            {user.PHONE ? (
              <span className="text-xs text-muted-foreground">
                {user.PHONE}
              </span>
            ) : null}
          </Link>
          {user.TITLE || user.DEPARTMENT ? (
            <span className="max-w-[350px] shrink-0 truncate text-xs text-muted-foreground">
              {[user.TITLE, user.DEPARTMENT].filter(Boolean).join(' · ')}
            </span>
          ) : null}
        </div>
        {onEdit ? (
          <Button
            aria-label={`Edit ${user.NAME || user.EMAIL}`}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onEdit(user);
            }}
            size="icon-sm"
            type="button"
            variant="outline"
          >
            <Pencil className="size-4" />
          </Button>
        ) : null}
        <CollapsibleTrigger
          aria-label={
            open ? 'Hide groups and permissions' : 'Show groups and permissions'
          }
          className="shrink-0 rounded p-1 hover:bg-muted data-[state=open]:rotate-90"
        >
          <ChevronRight className="size-4 text-muted-foreground transition-transform" />
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent>
        <div className="mt-2 ml-6 border-l-2 border-muted pl-3">
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
    </Collapsible>
  );
}

/**
 * Filterable user list with multi-select bulk assignment.
 * Port of c360's `components/custom/FilterableUserList`.
 */
export function FilterableUserList({
  groups,
  permissions,
  users,
}: {
  groups: PermissionGroup[];
  permissions: Permission[];
  users: User[];
}) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [showInactive, setShowInactive] = useState(false);

  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return users.filter((user) => {
      // Default to `IS_ACTIVE = true`; the toggle also includes inactive users.
      if (!showInactive && !isActiveUser(user)) return false;
      if (!query) return true;
      return (
        (user.NAME || '').toLowerCase().includes(query) ||
        (user.EMAIL || '').toLowerCase().includes(query) ||
        (user.PHONE || '').toLowerCase().includes(query)
      );
    });
  }, [users, filter, showInactive]);

  const selectAll = filtered.length > 0 && selected.size === filtered.length;
  const someSelected = selected.size > 0;

  const toggleAll = () => {
    setSelected(
      selectAll ? new Set() : new Set(filtered.map((user) => user.USER_ID)),
    );
  };

  const toggleOne = (userId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  };

  /**
   * One bulk-assign call for the current selection. `POST …/users/bulk-assign` rejects blank ids and
   * requires at least one group or permission (B0-409), both of which hold by construction here.
   */
  const bulkAssign = useCallback(
    async (
      payload: { permissionGroupIds: string[]; permissionIds: string[] },
      successMessage: string,
      failureMessage: string,
    ) => {
      const userIds = Array.from(selected);
      if (userIds.length === 0) return;
      setLoading(true);
      try {
        const res = await fetch(`${PERMISSIONS_API_BASE}/users/bulk-assign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userIds, ...payload }),
        });
        const data = await readJsonEnvelope(res);
        if (!res.ok) {
          toast.error(envelopeErrorMessage(data, failureMessage));
          return;
        }
        toast.success(successMessage);
        setSelected(new Set());
      } catch (err) {
        console.error(err);
        toast.error(failureMessage);
      } finally {
        setLoading(false);
      }
    },
    [selected],
  );

  return (
    <>
      <EditUserDialog
        onOpenChange={(next) => {
          setEditDialogOpen(next);
          if (!next) setEditingUser(null);
        }}
        open={editDialogOpen}
        user={editingUser}
      />

      <div className="space-y-2 pb-3">
        <Label className="sr-only" htmlFor="filter-users">
          Filter by name, email, or phone
        </Label>
        <Input
          className="h-9"
          id="filter-users"
          onChange={(event) => setFilter(event.target.value)}
          placeholder="Filter by name, email, or phone…"
          type="text"
          value={filter}
        />
      </div>

      <div className="flex w-full flex-wrap items-center gap-6 py-2">
        <div className="flex flex-1 items-center gap-6">
          <div className="flex items-center gap-2">
            <Checkbox
              aria-label="Select all"
              checked={selectAll}
              onCheckedChange={toggleAll}
            />
            <span className="shrink-0 text-xs font-medium text-muted-foreground">
              Select all
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Checkbox
              aria-label="Show inactive"
              checked={showInactive}
              onCheckedChange={() => setShowInactive((prev) => !prev)}
            />
            <span className="shrink-0 text-xs font-medium text-muted-foreground">
              Show inactive
            </span>
          </div>
        </div>

        {someSelected ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {selected.size} selected
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button disabled={loading} size="sm" variant="outline">
                  {loading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <UserPlus className="size-4" />
                  )}
                  Assign to group
                  <ChevronDown className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {groups.length === 0 ? (
                  <DropdownMenuItem disabled>No groups</DropdownMenuItem>
                ) : (
                  groups.map((group) => (
                    <DropdownMenuItem
                      key={group.PERMISSION_GROUP_ID}
                      onSelect={() =>
                        void bulkAssign(
                          {
                            permissionGroupIds: [group.PERMISSION_GROUP_ID],
                            permissionIds: [],
                          },
                          'Group assigned to selected users',
                          'Failed to assign group',
                        )
                      }
                    >
                      {group.SELECTOR}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button disabled={loading} size="sm" variant="outline">
                  {loading ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <UserPlus className="size-4" />
                  )}
                  Assign to permission
                  <ChevronDown className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {permissions.length === 0 ? (
                  <DropdownMenuItem disabled>No permissions</DropdownMenuItem>
                ) : (
                  permissions.map((permission) => (
                    <DropdownMenuItem
                      key={permission.PERMISSION_ID}
                      onSelect={() =>
                        void bulkAssign(
                          {
                            permissionGroupIds: [],
                            permissionIds: [permission.PERMISSION_ID],
                          },
                          'Permission assigned to selected users',
                          'Failed to assign permission',
                        )
                      }
                    >
                      {permission.SELECTOR}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        ) : null}
      </div>

      <div className="-mr-1 max-h-[400px] overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            {users.length === 0
              ? 'No users found.'
              : 'No users match the filter.'}
          </p>
        ) : (
          <ul className="space-y-2">
            {filtered.map((user) => (
              <li
                className="border-b border-border pb-3 last:border-0 last:pb-0"
                key={user.USER_ID}
              >
                <UserRowWithAssignments
                  checkbox={
                    <Checkbox
                      aria-label={`Select ${user.NAME || user.EMAIL}`}
                      checked={selected.has(user.USER_ID)}
                      onCheckedChange={() => toggleOne(user.USER_ID)}
                      onClick={(event) => event.stopPropagation()}
                    />
                  }
                  groups={groups}
                  onEdit={(next) => {
                    setEditingUser(next);
                    setEditDialogOpen(true);
                  }}
                  permissions={permissions}
                  user={user}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
