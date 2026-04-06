'use client';

import Link from 'next/link';
import { useSyncExternalStore } from 'react';
import {
  ChevronsUpDown,
  CircleHelp,
  LogOut,
  Search,
  Settings,
} from 'lucide-react';

import { Avatar, AvatarFallback } from '~/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';

function AccountTrigger() {
  return (
    <button
      className="flex w-full items-center gap-3 rounded-3xl border border-sidebar-border bg-sidebar-accent/60 p-3 text-left transition hover:bg-sidebar-accent"
      type="button"
    >
      <Avatar size="lg">
        <AvatarFallback>CN</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-sidebar-foreground">CN</p>
        <p className="truncate text-xs text-sidebar-foreground/70">
          shadcnm@example.com
        </p>
      </div>
      <ChevronsUpDown className="size-4 text-sidebar-foreground/70" />
    </button>
  );
}

export function AdminAccountMenu() {
  const mounted = useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );

  if (!mounted) {
    return <AccountTrigger />;
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <AccountTrigger />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>My Account</DropdownMenuLabel>
        <DropdownMenuGroup>
          <div className="flex items-center gap-3 rounded-2xl px-3 py-2">
            <Avatar size="lg">
              <AvatarFallback>CN</AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <p className="truncate text-sm font-medium text-foreground">CN</p>
              <p className="truncate text-xs text-muted-foreground">
                shadcnm@example.com
              </p>
            </div>
          </div>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link href="#">
              <Settings className="size-4" />
              Settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="#">
              <CircleHelp className="size-4" />
              Get Help
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link href="/admin/products/rag/search">
              <Search className="size-4" />
              Search
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem>
          <LogOut className="size-4" />
          Log out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
