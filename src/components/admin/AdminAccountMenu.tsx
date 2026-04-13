'use client';

import {
  Bell,
  CircleUserRound,
  CreditCard,
  EllipsisVertical,
  LogOut,
  Search,
} from 'lucide-react';
import { signOut, useSession } from 'next-auth/react';
import Link from 'next/link';
import { forwardRef, useSyncExternalStore } from 'react';

import { Avatar, AvatarFallback } from '~/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';

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
  ({ userEmail, userName, ...buttonProps }, ref) => {
    return (
      <button
        className="flex w-full items-center gap-3 rounded-3xl border border-sidebar-border bg-sidebar-accent/60 p-3 text-left transition hover:bg-sidebar-accent"
        ref={ref}
        type="button"
        {...buttonProps}
      >
        <Avatar size="lg">
          <AvatarFallback>{getInitials(userName)}</AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-sidebar-foreground">
            {userName || 'User'}
          </p>
          <p className="truncate text-xs text-sidebar-foreground/70">
            {userEmail || 'No email'}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <EllipsisVertical className="size-4 text-sidebar-foreground/70" />
        </div>
      </button>
    );
  },
);

AccountTrigger.displayName = 'AccountTrigger';

export function AdminAccountMenu() {
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
            </div>
          </div>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href="#">
              <CircleUserRound className="size-4" />
              Account
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="#">
              <CreditCard className="size-4" />
              Billing
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="#">
              <Bell className="size-4" />
              Notifications
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/admin/products/rag">
              <Search className="size-4" />
              Search
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>
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
