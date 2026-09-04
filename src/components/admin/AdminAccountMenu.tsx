'use client';

import {
  BanknoteArrowDown,
  BookOpen,
  ChartNoAxesCombined,
  EllipsisVertical,
  KeyRound,
  LogOut,
  ShieldCheck,
  Sliders,
} from 'lucide-react';
import { signOut } from 'next-auth/react';
import Link from 'next/link';
import { forwardRef, useSyncExternalStore } from 'react';

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

/**
 * Exact-or-wildcard match against a flat permission list (e.g. "navigation.*" matches
 * "navigation.sidebar.user.api_access"). Mirrors permissions-server's hasPermission(), duplicated
 * here because that helper is server-only and this is a client component receiving a plain array.
 */
function hasPermission(permissions: string[], permission: string): boolean {
  if (permissions.includes(permission)) return true;
  const parts = permission.split('.');
  for (let i = parts.length - 1; i > 0; i--) {
    const wild = [...parts.slice(0, i), '*'].join('.');
    if (permissions.includes(wild)) return true;
  }
  return permissions.includes('*');
}

export function AdminAccountMenu({
  permissions = [],
  userName,
  userEmail,
}: {
  permissions?: string[];
  userName?: string | null;
  userEmail?: string | null;
}) {
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  // B0-761 — application usage dashboard (`event_logging` analytics).
  const showAnalytics = hasPermission(
    permissions,
    PERMISSIONS.NAVIGATION_SIDEBAR_USER_ANALYTICS,
  );
  const showApiAccess = hasPermission(
    permissions,
    PERMISSIONS.NAVIGATION_SIDEBAR_USER_API_ACCESS,
  );
  const showAccessControl = hasPermission(
    permissions,
    PERMISSIONS.ADMIN_CARD_PERMISSIONS,
  );
  const showChangelog = hasPermission(
    permissions,
    PERMISSIONS.NAVIGATION_SIDEBAR_USER_CHANGELOG,
  );

  const showCostMonitoring = hasPermission(
    permissions,
    PERMISSIONS.NAVIGATION_SIDEBAR_COST,
  );

  const showSettings = hasPermission(
    permissions,
    PERMISSIONS.NAVIGATION_SIDEBAR_USER_SETTINGS,
  );

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
            </div>
          </div>
        </DropdownMenuGroup>
        {showAnalytics ||
        showApiAccess ||
        showAccessControl ||
        showChangelog ||
        showSettings ||
        showCostMonitoring ? (
          <DropdownMenuSeparator />
        ) : null}
        {showAnalytics ||
        showApiAccess ||
        showAccessControl ||
        showSettings ||
        showCostMonitoring ? (
          <>
            <DropdownMenuGroup>
              {showAnalytics ? (
                <DropdownMenuItem asChild>
                  <Link href="/admin/analytics">
                    <ChartNoAxesCombined className="size-4" />
                    Analytics
                  </Link>
                </DropdownMenuItem>
              ) : null}
              {showApiAccess ? (
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
              ) : null}
              {showAccessControl ? (
                <DropdownMenuItem asChild>
                  <Link href="/admin/permissions">
                    <ShieldCheck className="size-4" />
                    Access control
                  </Link>
                </DropdownMenuItem>
              ) : null}

              {showCostMonitoring && (
                <DropdownMenuItem asChild>
                  <Link href="/admin/cost">
                    <BanknoteArrowDown className="size-4" />
                    Cost monitoring
                  </Link>
                </DropdownMenuItem>
              )}

              {showSettings && (
                <DropdownMenuItem asChild>
                  <Link href="/admin/settings">
                    <Sliders className="size-4" />
                    Settings
                  </Link>
                </DropdownMenuItem>
              )}
            </DropdownMenuGroup>
            {showChangelog ? <DropdownMenuSeparator /> : null}
          </>
        ) : null}
        {showChangelog ? (
          <DropdownMenuGroup>
            <DropdownMenuItem asChild>
              <Link href="/admin/changelog">
                <BookOpen className="size-4" />
                Changelog
              </Link>
            </DropdownMenuItem>
          </DropdownMenuGroup>
        ) : null}
        <DropdownMenuSeparator />
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
