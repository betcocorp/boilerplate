'use client';

import { EllipsisVertical, KeyRound, LogOut, ShieldCheck } from 'lucide-react';
import { signOut, useSession } from 'next-auth/react';
import Link from 'next/link';
import { forwardRef, useSyncExternalStore } from 'react';

import { version as appVersion } from '../../../package.json';
import { Avatar, AvatarFallback } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { cn } from '~/lib/utils';

function getInitials(value: string | null | undefined) {
  const raw = value?.trim();
  if (!raw) {
    return 'U';
  }

  const parts = raw.split(/\s+/).slice(0, 2);
  return parts.map((part) => part[0]?.toUpperCase() || '').join('') || 'U';
}

type AccountTriggerProps = {
  userEmail: string | null | undefined;
  userName: string | null | undefined;
} & React.ComponentPropsWithoutRef<'button'>;

const AccountTrigger = forwardRef<HTMLButtonElement, AccountTriggerProps>(
  ({ userEmail, userName, className, ...buttonProps }, ref) => {
    return (
      <Button
        className={cn(
          'flex h-auto w-full items-center gap-3 rounded-3xl border border-sidebar-border bg-sidebar-accent/60 p-3 text-left transition hover:bg-sidebar-accent group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:rounded-2xl group-data-[collapsible=icon]:p-1.5',
          className,
        )}
        ref={ref}
        type="button"
        variant="ghost"
        {...buttonProps}
      >
        <Avatar size="lg">
          <AvatarFallback>{getInitials(userName)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
          <p className="truncate text-sm font-medium text-sidebar-foreground">
            {userName || 'User'}
          </p>
          <p className="truncate text-xs text-sidebar-foreground/70">
            {userEmail || 'No email'}
          </p>
        </div>
        <div className="flex items-center gap-1 group-data-[collapsible=icon]:hidden">
          <EllipsisVertical className="size-4 text-sidebar-foreground/70" />
        </div>
      </Button>
    );
  },
);

AccountTrigger.displayName = 'AccountTrigger';

export function AdminAccountMenu({
  permissions = [],
}: {
  permissions?: string[];
}) {
  const { data: session } = useSession();
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
  const userName = session?.user?.name;
  const userEmail = session?.user?.email;

  if (!mounted) {
    return <AccountTrigger userEmail={userEmail} userName={userName} />;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <AccountTrigger userEmail={userEmail} userName={userName} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64" side="right">
        <DropdownMenuGroup>
          <div className="flex items-center gap-3 rounded-2xl px-3 py-2">
            <Avatar size="lg">
              <AvatarFallback>{getInitials(userName)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">
                {userName || 'User'}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {userEmail || 'No email'}
              </p>
              <p className="truncate text-xs font-light text-foreground">
                Version: {appVersion}
              </p>
            </div>
          </div>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {permissions.includes(
          PERMISSIONS.SIDEBAR_NAVIGATION_API_PERMISSIONS,
        ) ? (
          <>
            <DropdownMenuGroup>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <KeyRound className="size-4" />
                  API access
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuItem asChild>
                    <Link href="/admin/projects">Projects</Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link href="/admin/projects/analytics">Analytics</Link>
                  </DropdownMenuItem>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuItem asChild>
                <Link href="/admin/permissions">
                  <ShieldCheck className="size-4" />
                  Access control
                </Link>
              </DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            void signOut({ callbackUrl: '/' });
          }}
        >
          <LogOut className="size-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
