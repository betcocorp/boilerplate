'use client';

import { ChevronRight, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useMemo, useState } from 'react';

import { fetchGroupDetail } from '~/components/permissions/read-actions';
import { Badge } from '~/components/ui/badge';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '~/components/ui/collapsible';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { formatDate } from '~/lib/utils/time';
import type { Permission, PermissionGroup } from '~/types/permissions';

/**
 * A permission row, optionally annotated by the page's catalog audit: `isVirtual` rows are selectors
 * the app checks that have no `public.permission` row, so they have no detail page to link to.
 */
export type PermissionListItem = Permission & {
  deploymentStatus?: 'deployed' | 'undeployed';
  usedInCode?: boolean;
  isVirtual?: boolean;
};

type FilterableListProps =
  | { variant: 'group'; items: PermissionGroup[] }
  | { variant: 'permission'; items: PermissionListItem[] };

/** One group row; expanding it lazily loads that group's permissions. */
function GroupRowWithPermissions({ group }: { group: PermissionGroup }) {
  const [open, setOpen] = useState(false);
  const [permissions, setPermissions] = useState<Permission[] | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchPermissions = useCallback(async () => {
    if (permissions !== null) return;
    setLoading(true);
    try {
      const data = await fetchGroupDetail(group.PERMISSION_GROUP_ID);
      setPermissions(data.success ? data.permissions : []);
    } catch {
      setPermissions([]);
    } finally {
      setLoading(false);
    }
  }, [group.PERMISSION_GROUP_ID, permissions]);

  return (
    <Collapsible
      onOpenChange={(next) => {
        setOpen(next);
        if (next) void fetchPermissions();
      }}
      open={open}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <Link
            className="flex flex-col gap-0 rounded-md focus:ring-2 focus:ring-ring focus:outline-none hover:opacity-80 focus:opacity-80"
            href={`/admin/permissions/groups/${encodeURIComponent(group.PERMISSION_GROUP_ID)}`}
          >
            <div className="flex items-center gap-2">
              <span className="font-medium text-foreground">
                {group.SELECTOR}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground">
                Created {formatDate(group.CREATED_AT)}
              </span>
            </div>
            {group.DESCRIPTION ? (
              <span className="text-sm text-muted-foreground">
                {group.DESCRIPTION}
              </span>
            ) : null}
          </Link>
          <CollapsibleContent>
            <div className="mt-2 border-l-2 border-muted pl-2">
              {loading ? (
                <div className="flex items-center gap-2 py-1 text-sm text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  Loading permissions…
                </div>
              ) : permissions?.length ? (
                <ul className="space-y-1 py-1 text-sm text-muted-foreground">
                  {permissions.map((permission) => (
                    <li key={permission.PERMISSION_ID}>{permission.SELECTOR}</li>
                  ))}
                </ul>
              ) : permissions ? (
                <p className="py-1 text-sm text-muted-foreground">
                  No permissions in this group.
                </p>
              ) : null}
            </div>
          </CollapsibleContent>
        </div>
        <CollapsibleTrigger
          aria-label={open ? 'Hide permissions' : 'Show permissions'}
          className="mt-0.5 shrink-0 rounded p-0.5 hover:bg-muted data-[state=open]:rotate-90"
        >
          <ChevronRight className="size-4 text-muted-foreground transition-transform" />
        </CollapsibleTrigger>
      </div>
    </Collapsible>
  );
}

/**
 * Selector-filtered list of either permission groups or permissions.
 * Port of c360's `components/custom/FilterablePermissionsList`.
 */
export function FilterablePermissionsList(props: FilterableListProps) {
  const [filter, setFilter] = useState('');
  const items = props.items;
  const filtered = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return items;
    return items.filter((item) =>
      item.SELECTOR.toLowerCase().includes(query),
    ) as typeof items;
  }, [items, filter]);

  const isGroup = props.variant === 'group';
  const inputId = isGroup ? 'filter-groups' : 'filter-permissions';

  return (
    <>
      <div className="space-y-2 pb-3">
        <Label className="sr-only" htmlFor={inputId}>
          Filter by selector
        </Label>
        <Input
          className="h-9"
          id={inputId}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={
            isGroup
              ? 'Filter groups by selector…'
              : 'Filter permissions by selector…'
          }
          type="text"
          value={filter}
        />
      </div>
      <div className="mt-4 -mr-1 max-h-[400px] overflow-y-auto pr-1">
        {filtered.length === 0 ? (
          <p className="py-4 text-sm text-muted-foreground">
            {items.length === 0
              ? isGroup
                ? 'No permission groups found.'
                : 'No permissions found.'
              : 'No items match the filter.'}
          </p>
        ) : (
          <ul className="space-y-3">
            {props.variant === 'group'
              ? (filtered as PermissionGroup[]).map((group) => (
                  <li
                    className="border-b border-border pb-3 last:border-0 last:pb-0"
                    key={group.PERMISSION_GROUP_ID}
                  >
                    <GroupRowWithPermissions group={group} />
                  </li>
                ))
              : (filtered as PermissionListItem[]).map((item) => (
                  <li
                    className="flex flex-col gap-0.5 border-b border-border pb-3 last:border-0 last:pb-0"
                    key={item.PERMISSION_ID}
                  >
                    {item.isVirtual ? (
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center gap-2">
                          <span className="flex-1 font-medium text-foreground">
                            {item.SELECTOR}
                          </span>
                          <Badge className="shrink-0" variant="secondary">
                            Used in code
                          </Badge>
                          <Badge className="shrink-0" variant="destructive">
                            Not in DB
                          </Badge>
                        </div>
                        <span className="text-sm text-muted-foreground">
                          Checked by the app but not deployed to the database.
                        </span>
                      </div>
                    ) : (
                      <Link
                        className="flex flex-col gap-0.5 rounded-md focus:ring-2 focus:ring-ring focus:outline-none hover:opacity-80 focus:opacity-80"
                        href={`/admin/permissions/permissions/${encodeURIComponent(item.PERMISSION_ID)}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="flex-1 font-medium text-foreground">
                            {item.SELECTOR}
                          </span>
                          {item.usedInCode ? (
                            <Badge className="shrink-0" variant="secondary">
                              Used in code
                            </Badge>
                          ) : null}
                          <span className="shrink-0 text-xs text-muted-foreground">
                            Created {formatDate(item.CREATED_AT)}
                          </span>
                        </div>
                        {item.DESCRIPTION ? (
                          <span className="text-sm text-muted-foreground">
                            {item.DESCRIPTION}
                          </span>
                        ) : null}
                      </Link>
                    )}
                  </li>
                ))}
          </ul>
        )}
      </div>
    </>
  );
}
