'use client';

import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '~/components/ui/button';
import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from '~/components/ui/command';
import { Label } from '~/components/ui/label';
import {
  Popover,
  PopoverContent,
  popoverScrollInDialogProps,
  PopoverTrigger,
} from '~/components/ui/popover';
import { cn } from '~/lib/utils';
import { ChevronDownIcon, ChevronLeftIcon, ChevronRightIcon, XIcon } from 'lucide-react';

/**
 * B0-360 — options per page.
 *
 * These lists are far larger than they look: ~1,700 legacy product lines behind "Expected
 * canonical product", ~100 each for reason code and question category. The list previously
 * showed only the first 25 with no way to reach the rest by browsing, so any value you
 * couldn't already name was undiscoverable. Paging (rather than an unbounded list) keeps
 * cmdk rendering ~50 items instead of ~1,700, and (rather than a "show more" button) keeps
 * the click count to reach the tail bounded.
 */
const PAGE_SIZE = 50;

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
}: {
  filter: string;
  options: readonly string[];
  onUse: (text: string) => void;
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

export type FilterableSuggestionFieldProps = {
  id: string;
  name: string;
  label: ReactNode;
  placeholder: string;
  suggestionsFromDataset: readonly string[];
  presetSuggestions?: readonly string[];
  /** When set, dropdown and trigger show these strings instead of raw option values (submitted value stays the option key). */
  optionLabels?: Record<string, string>;
  /** Pre-selected value (e.g. when editing an existing row). Ignored when `multiple` is set. */
  initialValue?: string;
  /**
   * B0-993 — multi-select mode: every chosen option is kept as a chip and submitted as one repeated
   * hidden `<input name={name}>` per value (read with `formData.getAll(name)`). The popover stays
   * open after a pick so several values can be added in one visit.
   */
  multiple?: boolean;
  /** Pre-selected values for `multiple` mode (e.g. when editing an existing row). */
  initialValues?: readonly string[];
};

export function FilterableSuggestionField({
  id,
  name,
  label,
  placeholder,
  suggestionsFromDataset,
  presetSuggestions = [],
  optionLabels,
  initialValue = '',
  multiple = false,
  initialValues,
}: FilterableSuggestionFieldProps) {
  const [open, setOpen] = useState(false);
  // One state shape for both modes: single mode is simply a list of at most one value. The hidden
  // inputs are rendered from this state rather than as controlled visible fields because React 19
  // resets uncontrolled form fields when a `<form action>` succeeds.
  const [values, setValues] = useState<string[]>(() =>
    multiple
      ? [...new Set((initialValues ?? []).map((v) => v.trim()).filter((v) => v !== ''))]
      : initialValue.trim()
        ? [initialValue]
        : [],
  );
  const value = multiple ? '' : values[0] ?? '';
  const selectedSet = useMemo(() => new Set(values), [values]);

  const pick = (option: string) => {
    if (multiple) {
      setValues((current) => (current.includes(option) ? current : [...current, option]));
      return;
    }
    setValues([option]);
    setOpen(false);
  };

  const removeValue = (option: string) => {
    setValues((current) => current.filter((v) => v !== option));
  };
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const options = useMemo(() => {
    const merged = mergeSuggestions(presetSuggestions, suggestionsFromDataset);
    const lookup = optionLabels ?? {};
    const hasLabels = Object.keys(lookup).length > 0;
    if (!hasLabels) {
      return merged;
    }
    const displayFor = (v: string) => lookup[v] ?? v;
    return [...merged].sort((a, b) =>
      displayFor(a).localeCompare(displayFor(b), undefined, { sensitivity: 'base' }),
    );
  }, [presetSuggestions, suggestionsFromDataset, optionLabels]);

  /** Everything matching the current filter — the set the pager walks. */
  const matchingOptions = useMemo(() => {
    const displayFor = (v: string) => optionLabels?.[v] ?? v;
    const q = search.trim().toLowerCase();
    if (!q) {
      return options;
    }
    return options.filter((opt) => {
      const label = displayFor(opt);
      return opt.toLowerCase().includes(q) || label.toLowerCase().includes(q);
    });
  }, [options, search, optionLabels]);

  const pageCount = Math.max(1, Math.ceil(matchingOptions.length / PAGE_SIZE));
  // Filtering shrinks the match set, so a page index from a previous filter can fall out of range.
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = currentPage * PAGE_SIZE;
  const visibleOptions = matchingOptions.slice(pageStart, pageStart + PAGE_SIZE);

  const isFiltering = search.trim().length > 0;
  const showFilterEmpty = isFiltering && matchingOptions.length === 0;

  // A new page starts at its first option, not wherever the previous page was scrolled to.
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [currentPage, search]);

  const resetPaging = () => {
    setPage(0);
    setSearch('');
  };

  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Popover
        modal={false}
        onOpenChange={(nextOpen) => {
          setOpen(nextOpen);
          if (nextOpen) {
            resetPaging();
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
            <span className="line-clamp-3">
              {value ? optionLabels?.[value] ?? value : placeholder}
            </span>
            <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          className="z-100 flex max-h-[min(22rem,calc(100vh-8rem))] w-[min(100vw-2rem,var(--radix-popover-trigger-width))] flex-col gap-0 overflow-hidden p-0"
          // B0-359: these fields live in the Add/Edit prompt dialogs, whose scroll lock
          // would otherwise cancel every wheel event over the option list.
          {...popoverScrollInDialogProps}
        >
          <Command
            className="flex min-h-0 flex-1 flex-col overflow-hidden size-auto! **:data-[slot=command-input-wrapper]:shrink-0"
            label="Filter options"
            shouldFilter={false}
          >
            <CommandInput
              onValueChange={(next) => {
                setSearch(next);
                setPage(0);
              }}
              placeholder="Filter or type a new value…"
              value={search}
            />
            <CommandList
              className="max-h-[min(18rem,calc(100vh-12rem))] min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-py-1"
              ref={listRef}
            >
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
                {visibleOptions.map((opt) => {
                  const shown = optionLabels?.[opt] ?? opt;
                  const alreadySelected = multiple && selectedSet.has(opt);
                  return (
                    <CommandItem
                      key={opt}
                      keywords={[opt, shown]}
                      onSelect={() => pick(opt)}
                      value={opt}
                    >
                      <span className="min-w-0 flex-1">{shown}</span>
                      {alreadySelected ? (
                        <span className="shrink-0 text-xs text-muted-foreground">added</span>
                      ) : null}
                    </CommandItem>
                  );
                })}
                <UseTypedValueItem
                  filter={search}
                  onUse={(text) => pick(text)}
                  options={options}
                />
              </CommandGroup>
            </CommandList>
            {/*
              B0-360 — pager lives OUTSIDE CommandList so its buttons are not cmdk items and
              never steal arrow-key navigation or the Enter key from the option list.
            */}
            {matchingOptions.length > 0 ? (
              <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border/60 px-3 py-2">
                <p aria-live="polite" className="text-xs text-muted-foreground">
                  {pageCount > 1 ? (
                    <>
                      {pageStart + 1}–{pageStart + visibleOptions.length} of{' '}
                      {matchingOptions.length}
                      {isFiltering ? ' matching' : ''} · page {currentPage + 1}/{pageCount}
                    </>
                  ) : (
                    <>
                      {matchingOptions.length}{' '}
                      {matchingOptions.length === 1 ? 'option' : 'options'}
                      {isFiltering ? ' matching' : ''}
                    </>
                  )}
                </p>
                {pageCount > 1 ? (
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      aria-label="Previous page of options"
                      disabled={currentPage === 0}
                      onClick={() => setPage((p) => Math.max(0, p - 1))}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <ChevronLeftIcon className="size-4" />
                    </Button>
                    <Button
                      aria-label="Next page of options"
                      disabled={currentPage >= pageCount - 1}
                      onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
                      size="icon-sm"
                      type="button"
                      variant="ghost"
                    >
                      <ChevronRightIcon className="size-4" />
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </Command>
        </PopoverContent>
      </Popover>
      {multiple ? (
        <>
          {values.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {values.map((selected) => {
                const shown = optionLabels?.[selected] ?? selected;
                return (
                  <li key={selected}>
                    <span className="inline-flex max-w-full items-center gap-1 rounded-2xl border border-border bg-muted/60 py-1 pl-2.5 pr-1 text-xs">
                      <span className="flex min-w-0 flex-col text-left">
                        <span className="break-words font-medium text-foreground">{shown}</span>
                        {shown !== selected ? (
                          <span className="truncate text-[0.6875rem] text-muted-foreground">
                            {selected}
                          </span>
                        ) : null}
                      </span>
                      <Button
                        aria-label={`Remove ${shown}`}
                        className="size-5 shrink-0 rounded-full"
                        onClick={() => removeValue(selected)}
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <XIcon className="size-3" />
                      </Button>
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {values.map((selected) => (
            <input key={`${name}-${selected}`} name={name} type="hidden" value={selected} />
          ))}
        </>
      ) : (
        <>
          <input name={name} type="hidden" value={value} />
          {value ? (
            <Button
              className="h-8 w-fit text-xs"
              onClick={() => setValues([])}
              size="sm"
              type="button"
              variant="ghost"
            >
              <XIcon className="mr-1 size-3.5" />
              Clear
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
