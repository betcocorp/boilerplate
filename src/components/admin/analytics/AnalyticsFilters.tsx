'use client';

/**
 * B0-761 — the dashboard's two controls: the day range and the group multi-select.
 *
 * Both live ENTIRELY in searchParams (`?days=`, `?groups=a,b`), the same contract `/admin/bex/health`
 * and `/admin/projects/analytics` use, so a pasted URL reproduces the exact view and browser
 * back/forward works. This component therefore holds no filter state beyond the popover's open flag
 * and the router transition's pending flag — `days` and `selectedGroups` are props read back off the
 * server-resolved summary, never local state that could drift from the URL.
 *
 * The group list is derived from the data (`availableGroups`), so it is empty on a fresh install;
 * the trigger disables itself in that case rather than opening onto an empty list.
 */

import { Check, ChevronsUpDown } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';

import { Button } from '~/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '~/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';

/** Trailing-window presets; values are the day count as a string, matching `?days=`. */
const RANGE_OPTIONS = [
  { value: '7', label: 'Last 7 days' },
  { value: '14', label: 'Last 14 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '60', label: 'Last 60 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '180', label: 'Last 6 months' },
  { value: '365', label: 'Last 1 year' },
] as const;

function describeGroups(selectedGroups: string[]): string {
  if (selectedGroups.length === 0) return 'All groups';
  if (selectedGroups.length === 1) return selectedGroups[0];
  return `${selectedGroups.length} groups selected`;
}

export function AnalyticsFilters({
  availableGroups,
  days,
  selectedGroups,
}: {
  /** Derived from the data; empty on a fresh install. */
  availableGroups: string[];
  days: number;
  selectedGroups: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const [groupsOpen, setGroupsOpen] = useState(false);

  const pushFilters = (nextDays: number, nextGroups: string[]) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('days', String(nextDays));
    if (nextGroups.length === 0) {
      params.delete('groups');
    } else {
      params.set('groups', nextGroups.join(','));
    }
    const query = params.toString();
    startTransition(() => {
      router.replace(query ? `${pathname}?${query}` : pathname);
    });
  };

  const toggleGroup = (group: string) => {
    const nextGroups = selectedGroups.includes(group)
      ? selectedGroups.filter((value) => value !== group)
      : [...selectedGroups, group].sort((a, b) => a.localeCompare(b));
    pushFilters(days, nextGroups);
  };

  // A pasted URL may name a range that is not a preset; echo it so the control stays truthful
  // instead of silently reporting one of the presets.
  const isPresetRange = RANGE_OPTIONS.some((option) => option.value === String(days));

  return (
    <div
      className={`flex flex-col gap-3 transition-opacity sm:flex-row sm:items-center ${
        isPending ? 'opacity-60' : ''
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Range</span>
        <Select
          onValueChange={(value) => {
            const nextDays = Number.parseInt(value, 10);
            pushFilters(Number.isFinite(nextDays) ? nextDays : days, selectedGroups);
          }}
          value={String(days)}
        >
          <SelectTrigger aria-label="Day range" className="w-[180px]" size="sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {RANGE_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
            {isPresetRange ? null : (
              <SelectItem disabled value={String(days)}>
                Last {days} days (from URL)
              </SelectItem>
            )}
          </SelectContent>
        </Select>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Groups</span>
        <Popover onOpenChange={setGroupsOpen} open={groupsOpen}>
          <PopoverTrigger asChild>
            <Button
              aria-label="Filter by group"
              className="w-[240px] justify-between"
              disabled={availableGroups.length === 0}
              size="sm"
              variant="outline"
            >
              <span className="truncate">
                {availableGroups.length === 0 ? 'No groups yet' : describeGroups(selectedGroups)}
              </span>
              <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-[280px] p-0">
            <Command>
              <CommandInput placeholder="Filter groups..." />
              <CommandList>
                <CommandEmpty>No groups found.</CommandEmpty>
                <CommandGroup>
                  <CommandItem
                    onSelect={() => {
                      pushFilters(days, []);
                    }}
                  >
                    <Check
                      className={`size-4 ${selectedGroups.length === 0 ? 'opacity-100' : 'opacity-0'}`}
                    />
                    <span>All groups</span>
                  </CommandItem>
                  {availableGroups.map((group) => (
                    <CommandItem
                      key={group}
                      onSelect={() => {
                        toggleGroup(group);
                      }}
                      value={group}
                    >
                      <Check
                        className={`size-4 ${
                          selectedGroups.includes(group) ? 'opacity-100' : 'opacity-0'
                        }`}
                      />
                      <span className="truncate">{group}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </div>
  );
}
