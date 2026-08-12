'use client';

import { Check, ChevronsUpDown } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { Avatar, AvatarFallback } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import { ClientOnly } from '~/components/ui/client-only';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '~/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '~/components/ui/popover';
import { Spinner } from '~/components/ui/spinner';
import { setSelectedUserAndLoadPermissions } from '~/lib/actions/cookies';
import { usePermissionsStore } from '~/lib/stores/permissions';
import { cn } from '~/lib/utils';
import type User from '~/types/User';

export type UserSwitcherClientProps = {
  selectedUser: User | undefined;
  userInitials: string;
  users: User[];
};

/**
 * "Acting as" picker: sets the selected-user cookie, loads that user's permissions into Redis, and
 * refreshes so every server component re-renders as them.
 *
 * Port of c360's `components/custom/UserSwitcherClient`, with two changes: the `isAuthUserViewAll`
 * prop is gone (the server half already renders nothing for users without `HAS_USER_SWITCHER`, so the
 * false branch was unreachable), and with it c360's `LogoutButton` fallback — bex logs out through
 * `AdminAccountMenu`.
 */
export function UserSwitcherClient({
  selectedUser,
  userInitials,
  users,
}: UserSwitcherClientProps) {
  const router = useRouter();
  const loadPermissions = usePermissionsStore((state) => state.load);
  const [open, setOpen] = useState(false);
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  /**
   * Derived, not stored: the switch is in flight from the moment a user is picked until the
   * server-refreshed `selectedUser` prop is the one that was picked. c360 tracked this with a second
   * `isUpdating` state kept in sync by an effect, which is exactly the cascading-render pattern
   * `react-hooks/set-state-in-effect` rejects.
   */
  const isUpdating =
    pendingEmail !== null && selectedUser?.EMAIL !== pendingEmail;

  const userOptions = useMemo(
    () => users.map((user) => ({ label: user.NAME, user, value: user.EMAIL })),
    [users],
  );

  const handleUserSelect = useCallback(
    async (user: User) => {
      if (isUpdating || user.EMAIL === selectedUser?.EMAIL) return;
      setPendingEmail(user.EMAIL);
      setOpen(false);
      try {
        await setSelectedUserAndLoadPermissions(user);
        router.refresh();
        await loadPermissions();
      } catch (error) {
        console.error('Error switching user:', error);
        setPendingEmail(null);
      }
    },
    [isUpdating, loadPermissions, router, selectedUser?.EMAIL],
  );

  const trigger = (disabled: boolean) => (
    <Button
      className="gap-2 rounded-2xl"
      disabled={disabled}
      size="sm"
      variant="outline"
    >
      <Avatar className="size-6">
        <AvatarFallback className="text-xs">{userInitials}</AvatarFallback>
      </Avatar>
      <span className="flex flex-col items-start leading-none">
        <span className="text-xs text-muted-foreground">Acting as</span>
        <span className="text-sm font-medium">
          {selectedUser?.NAME ?? 'Unknown user'}
        </span>
      </span>
      {isUpdating ? (
        <Spinner className="size-4" />
      ) : (
        <ChevronsUpDown className="size-4" />
      )}
    </Button>
  );

  return (
    <ClientOnly fallback={trigger(true)}>
      <Popover
        onOpenChange={(next) => {
          if (!isUpdating) setOpen(next);
        }}
        open={open}
      >
        <PopoverTrigger asChild>{trigger(isUpdating)}</PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-0">
          <Command>
            <CommandInput placeholder="Search users…" />
            <CommandList className="max-h-[60vh] overflow-y-auto">
              <CommandEmpty>No users found.</CommandEmpty>
              <CommandGroup>
                {userOptions.map((option) => {
                  const isSelected = option.value === selectedUser?.EMAIL;
                  return (
                    <CommandItem
                      className={cn(
                        !isUpdating && !isSelected && 'cursor-pointer',
                        isSelected && 'bg-accent text-accent-foreground',
                      )}
                      disabled={isUpdating || isSelected}
                      key={option.user.USER_ID}
                      onSelect={() => void handleUserSelect(option.user)}
                      value={`${option.label} ${option.value}`}
                    >
                      <Check
                        className={cn(
                          'mr-2 size-4',
                          isSelected ? 'opacity-100' : 'opacity-0',
                        )}
                      />
                      <div className="flex min-w-0 flex-col">
                        <span className="truncate">{option.label}</span>
                        <span className="truncate text-xs text-muted-foreground">
                          {option.value}
                        </span>
                      </div>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </ClientOnly>
  );
}
