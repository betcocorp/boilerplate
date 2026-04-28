'use client';

import { type ReactNode, useMemo, useState } from 'react';
import { Button } from '~/components/ui/button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '~/components/ui/command';
import { Label } from '~/components/ui/label';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '~/components/ui/popover';
import { cn } from '~/lib/utils';
import { ChevronDownIcon, XIcon } from 'lucide-react';

const INITIAL_VISIBLE_COUNT = 25;

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
  filter,
  options,
  onUse,
  search,
}: {
  filter: string;
  options: readonly string[];
  onUse: (text: string) => void;
  search: string;
}) {
  const trimmed = filter.trim();
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
  const [search, setSearch] = useState('');

  const options = useMemo(
    () => mergeSuggestions(presetSuggestions, suggestionsFromDataset),
    [presetSuggestions, suggestionsFromDataset],
  );

  const visibleOptions = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) {
      return options.slice(0, INITIAL_VISIBLE_COUNT);
    }
    return options.filter((opt) => opt.toLowerCase().includes(q));
  }, [options, search]);

  const hasMoreThanInitial = options.length > INITIAL_VISIBLE_COUNT;
  const isFiltering = search.trim().length > 0;
  const showFilterEmpty = isFiltering && visibleOptions.length === 0;

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Popover
        modal={false}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) {
            setSearch('');
          }
        }}
        open={open}
      >
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className={cn(
              'h-auto min-h-9 w-full justify-between rounded-3xl border border-transparent bg-input/50 px-3 py-2 font-normal whitespace-normal text-left hover:bg-input/60',
              !value && 'text-muted-foreground',
            )}
            id={id}
            onFocus={() => {
              setOpen(true);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                setOpen(true);
              }
            }}
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
          className="z-100 flex max-h-[min(22rem,calc(100vh-8rem))] w-[min(100vw-2rem,var(--radix-popover-trigger-width))] flex-col gap-0 overflow-hidden p-0"
        >
          <Command
            className="flex min-h-0 flex-1 flex-col overflow-hidden size-auto! **:data-[slot=command-input-wrapper]:shrink-0"
            label="Filter options"
            shouldFilter={false}
          >
            <CommandInput
              onValueChange={setSearch}
              placeholder="Filter or type a new value…"
              value={search}
            />
            <CommandList className="max-h-[min(18rem,calc(100vh-12rem))] min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-py-1">
              {options.length === 0 ? (
                <p className="px-3 py-2 text-center text-xs text-muted-foreground">
                  No saved values in this test yet. Type below, then choose &quot;Use …&quot; to set a custom value.
                </p>
              ) : null}
              {options.length > 0 && showFilterEmpty ? (
                <p className="px-3 py-2 text-center text-xs text-muted-foreground">
                  No suggestions match that filter. Choose &quot;Use …&quot; below to keep your text.
                </p>
              ) : null}
              <CommandGroup>
                {visibleOptions.map((opt) => (
                  <CommandItem
                    key={opt}
                    onSelect={() => {
                      setValue(opt);
                      setOpen(false);
                    }}
                    value={opt}
                  >
                    {opt}
                  </CommandItem>
                ))}
                <UseTypedValueItem
                  filter={search}
                  onUse={(text) => {
                    setValue(text);
                    setOpen(false);
                  }}
                  options={options}
                  search={listSearch}
                />
              </CommandGroup>
              {!isFiltering && hasMoreThanInitial ? (
                <p className="border-t border-border/60 px-3 py-2 text-center text-xs text-muted-foreground">
                  Showing {INITIAL_VISIBLE_COUNT} of {options.length}. Type to search all values.
                </p>
              ) : null}
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
