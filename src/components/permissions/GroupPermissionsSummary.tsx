'use client';

import { ChevronRight } from 'lucide-react';
import { useState } from 'react';

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '~/components/ui/collapsible';
import type { Permission } from '~/types/permissions';

/**
 * Collapsible "(n) View Permissions" list for a group whose permissions are already loaded — no
 * fetch, unlike `FilterablePermissionsList`'s group row. Port of c360's
 * `components/custom/GroupPermissionsSummary`.
 */
export function GroupPermissionsSummary({
  permissions,
}: {
  permissions: Permission[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible onOpenChange={setOpen} open={open}>
      <CollapsibleTrigger
        aria-label={open ? 'Hide permissions' : 'Show permissions in this group'}
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronRight
          className={`size-4 shrink-0 transition-transform${open ? ' rotate-90' : ''}`}
        />
        <span>({permissions.length}) View Permissions</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 border-l-2 border-muted pl-2">
          {permissions.length === 0 ? (
            <p className="py-1 text-sm text-muted-foreground">
              No permissions in this group.
            </p>
          ) : (
            <ul className="space-y-1 py-1 text-sm text-muted-foreground">
              {permissions.map((permission) => (
                <li key={permission.PERMISSION_ID}>{permission.SELECTOR}</li>
              ))}
            </ul>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
