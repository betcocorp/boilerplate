'use client';

import { type ReactNode, useCallback, useMemo, useState } from 'react';

import { Button } from '~/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '~/components/ui/command';
import { Label } from '~/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '~/components/ui/popover';
import { cn } from '~/lib/utils';
import { ChevronDownIcon, XIcon } from 'lucide-react';

/** When the search box is empty, show this many distinct options so the list is useful without typing. */
const INITIAL_VISIBLE_OPTIONS = 25;

function mergeSuggestions(presets: readonly string[], fromRows: readonly string[]): string[] {
  const set = new Set<string>();
  for (const p of presets) {
    const t = p.trim();
    if (t) {
      set.add(t);
    }
  }
  for (const r of fromRows) {
    const t = r.trim();
    if (t) {
      set.add(t);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function UseTypedValueItem({
  options,
  onUse,
  search,
}: {
  options: readonly string[];
  onUse: (text: string) => void;
  search: string;
}) {
  const trimmed = search.trim();
  if (!trimmed) {
    return null;
  }
  const collision = options.some((o) => o.toLowerCase() === trimmed.toLowerCase());
  if (collision) {
    return null;
  }

  return (
    <CommandItem keywords={[trimmed, `use ${trimmed}`, 'custom']} onSelect={() => onUse(trimmed)} value={trimmed}>
      Use &quot;{trimmed}&quot;
    </CommandItem>
  );
}

function SuggestionCommandItems({
  options,
  onPick,
  search,
}: {
  options: readonly string[];
  onPick: (value: string) => void;
  search: string;
}) {
  const { displayed, totalMatched, isCapped } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matched = q
      ? options.filter((o) => o.toLowerCase().includes(q))
      : options;
    if (!q && matched.length > INITIAL_VISIBLE_OPTIONS) {
      return {
        displayed: matched.slice(0, INITIAL_VISIBLE_OPTIONS),
        totalMatched: matched.length,
        isCapped: true,
      };
    }
    return {
      displayed: matched,
      totalMatched: matched.length,
      isCapped: false,
    };
  }, [options, search]);

  return (
    <>
      {displayed.map((opt) => (
        <CommandItem
          key={opt}
          onSelect={() => {
            onPick(opt);
          }}
          value={opt}
        >
          {opt}
        </CommandItem>
      ))}
      {!search.trim() && isCapped ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          Showing the first {INITIAL_VISIBLE_OPTIONS} of {totalMatched} values. Type in the
          box above to filter the rest.
        </p>
      ) : null}
    </>
  );
}

export type FilterableSuggestionFieldProps = {
  id: string;
  name: string;
  label: ReactNode;
  placeholder: string;
  suggestionsFromDataset: readonly string[];
  presetSuggestions?: readonly string[];
};

export function FilterableSuggestionField({
  id,
  name,
  label,
  placeholder,
  suggestionsFromDataset,
  presetSuggestions = [],
}: FilterableSuggestionFieldProps) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState('');
  const [listSearch, setListSearch] = useState('');

  const options = useMemo(
    () => mergeSuggestions(presetSuggestions, suggestionsFromDataset),
    [presetSuggestions, suggestionsFromDataset],
  );

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) {
      setListSearch('');
    }
  }, []);

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Popover modal={false} onOpenChange={handleOpenChange} open={open}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className={cn(
              'h-auto min-h-9 w-full justify-between rounded-3xl border border-transparent bg-input/50 px-3 py-2 font-normal whitespace-normal text-left hover:bg-input/60',
              !value && 'text-muted-foreground',
            )}
            id={id}
            role="combobox"
            type="button"
            variant="outline"
          >
            <span className="line-clamp-3">{value || placeholder}</span>
            <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className={cn(
            'z-100 flex max-h-[min(22rem,calc(100vh-8rem))] w-[min(100vw-2rem,var(--radix-popover-trigger-width))] flex-col gap-0 overflow-hidden p-0',
          )}
        >
          <Command
            className="flex min-h-0 flex-1 flex-col overflow-hidden size-auto! **:data-[slot=command-input-wrapper]:shrink-0"
            label="Filter options"
            shouldFilter={false}
          >
            <CommandInput
              onValueChange={setListSearch}
              placeholder="Filter or type a new value…"
              value={listSearch}
            />
            <CommandList className="max-h-[min(18rem,calc(100vh-12rem))] min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-py-1">
              <CommandEmpty>
                <p className="px-3 py-2 text-center text-xs text-muted-foreground">
                  No suggestions match. Type above, then choose &quot;Use …&quot; when it appears.
                </p>
              </CommandEmpty>
              <CommandGroup>
                <SuggestionCommandItems
                  options={options}
                  onPick={(opt) => {
                    setValue(opt);
                    setOpen(false);
                  }}
                  search={listSearch}
                />
                <UseTypedValueItem
                  onUse={(text) => {
                    setValue(text);
                    setOpen(false);
                  }}
                  options={options}
                  search={listSearch}
                />
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <input name={name} type="hidden" value={value} />
      {value ? (
        <Button
          className="h-8 w-fit text-xs"
          onClick={() => setValue('')}
          size="sm"
          type="button"
          variant="ghost"
        >
          <XIcon className="mr-1 size-3.5" />
          Clear
        </Button>
      ) : null}
    </div>
  );
}
