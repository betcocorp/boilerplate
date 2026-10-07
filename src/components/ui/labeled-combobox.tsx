'use client';

import { ChevronDownIcon } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '~/components/ui/button';
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
  popoverScrollInDialogProps,
  PopoverTrigger,
} from '~/components/ui/popover';
import { cn } from '~/lib/utils';

export type LabeledComboboxOption = {
  id: string;
  label: string;
  description?: string;
  /** Extra terms cmdk should fuzzy-match on, beyond id/label/description (which are always included). */
  keywords?: string[];
};

type LabeledComboboxProps = {
  id?: string;
  value: string | null;
  onValueChange: (value: string) => void;
  options: readonly LabeledComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  /**
   * B0-359 — set when this combobox's popover renders inside a Radix `Dialog` (spreads
   * `popoverScrollInDialogProps` so the `CommandList` can scroll under the dialog's scroll lock).
   */
  renderInDialog?: boolean;
  className?: string;
  disabled?: boolean;
};

/**
 * Searchable combobox: a Popover-trigger Button (bold label + muted description line) opening a
 * cmdk Command list, fuzzy-searchable by id/label/description. Generic reusable primitive —
 * form-field concerns (hidden input, clear button, `<Label>` wrapper) are layered on by callers,
 * see `~/components/admin/tests/TestIntendedAgentCombobox.tsx` for that pattern.
 */
export function LabeledCombobox({
  id,
  value,
  onValueChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No match found.',
  renderInDialog,
  className,
  disabled,
}: LabeledComboboxProps) {
  const [open, setOpen] = useState(false);

  const selected = useMemo(
    () => options.find((o) => o.id === value) ?? null,
    [options, value],
  );

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <Button
          aria-expanded={open}
          className={cn(
            'h-auto min-h-9 w-full justify-between rounded-3xl border border-transparent bg-input/50 px-3 py-2 font-normal whitespace-normal text-left hover:bg-input/60',
            !value && 'text-muted-foreground',
            className,
          )}
          disabled={disabled}
          id={id}
          role="combobox"
          type="button"
          variant="outline"
        >
          <span className="line-clamp-2 text-left">
            {selected ? (
              <>
                <span className="font-medium text-foreground">{selected.label}</span>
                {selected.description ? (
                  <span className="mt-0.5 block text-xs font-normal text-muted-foreground">
                    {selected.description}
                  </span>
                ) : null}
              </>
            ) : (
              placeholder
            )}
          </span>
          <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex max-h-[min(22rem,calc(100vh-8rem))] w-[min(100vw-2rem,var(--radix-popover-trigger-width))] flex-col gap-0 overflow-hidden p-0"
        {...(renderInDialog ? popoverScrollInDialogProps : {})}
      >
        <Command
          className="flex min-h-0 flex-1 flex-col overflow-hidden size-auto! **:data-[slot=command-input-wrapper]:shrink-0"
          label={searchPlaceholder}
        >
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList className="max-h-[min(18rem,calc(100vh-12rem))] min-h-0 flex-1 overflow-y-auto overscroll-contain scroll-py-1">
            <CommandEmpty>
              <p className="px-3 py-2 text-center text-xs text-muted-foreground">{emptyText}</p>
            </CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  keywords={[option.id, option.label, option.description ?? '', ...(option.keywords ?? [])]}
                  onSelect={() => {
                    onValueChange(option.id);
                    setOpen(false);
                  }}
                  value={option.id}
                >
                  <div className="flex flex-col gap-0.5 py-0.5">
                    <span className="font-medium">{option.label}</span>
                    {option.description ? (
                      <span className="text-xs text-muted-foreground">{option.description}</span>
                    ) : null}
                  </div>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
