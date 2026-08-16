'use client';

import { ChevronDownIcon, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Button } from '~/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '~/components/ui/command';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { searchProductLineOptions } from '~/lib/rag/product-alias-review-actions';
import { cn } from '~/lib/utils';

/**
 * B0-487 — searchable product-line picker for the alias review queue's edit form. Mirrors
 * `~/components/admin/BetcoProductPicker.tsx` (same picker/manual-entry split, same debounced
 * server-backed search), but resolves `rag.entity` where `entity_type = 'product_line'` instead of
 * `entity_type = 'product'` — `product_line_key` is the column the review queue edits, and it's a
 * GUID FK with no cross-schema constraint, so typing it by hand is exactly the kind of silent
 * mistake this picker exists to prevent.
 */

export type ProductLinePickerValue = {
  productLineKey: string;
  title: string;
};

type ProductLinePickerProps = {
  idPrefix: string;
  value: ProductLinePickerValue;
  onChange: (value: ProductLinePickerValue) => void;
  disabled?: boolean;
};

const DEBOUNCE_MS = 250;

export function ProductLinePicker({ idPrefix, value, onChange, disabled }: ProductLinePickerProps) {
  const [mode, setMode] = useState<'picker' | 'manual'>('picker');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<ProductLinePickerValue[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  useEffect(
    () => () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    },
    [],
  );

  function handleQueryChange(next: string) {
    setQuery(next);
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);

    const trimmed = next.trim();
    if (!trimmed) {
      requestIdRef.current += 1;
      setOptions([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const requestId = ++requestIdRef.current;
    debounceRef.current = setTimeout(() => {
      searchProductLineOptions(trimmed)
        .then((results) => {
          if (requestIdRef.current === requestId) setOptions(results);
        })
        .finally(() => {
          if (requestIdRef.current === requestId) setLoading(false);
        });
    }, DEBOUNCE_MS);
  }

  if (mode === 'manual') {
    return (
      <div className="space-y-2">
        <div className="space-y-1">
          <Label htmlFor={`${idPrefix}-manual-key`}>Product line key</Label>
          <Input
            disabled={disabled}
            id={`${idPrefix}-manual-key`}
            onChange={(e) => onChange({ productLineKey: e.target.value, title: value.title })}
            value={value.productLineKey}
          />
        </div>
        <Button
          className="h-auto p-0 text-xs"
          disabled={disabled}
          onClick={() => setMode('picker')}
          size="sm"
          type="button"
          variant="link"
        >
          Use the product line search instead
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={`${idPrefix}-picker`}>Product line</Label>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className={cn(
              'h-auto min-h-9 w-full justify-between rounded-2xl border border-input bg-background px-3 py-2 font-normal whitespace-normal text-left hover:bg-accent/40',
              !value.productLineKey && 'text-muted-foreground',
            )}
            disabled={disabled}
            id={`${idPrefix}-picker`}
            role="combobox"
            type="button"
            variant="outline"
          >
            <span className="line-clamp-2 text-left">
              {value.productLineKey ? (
                <>
                  <span className="font-medium text-foreground">{value.title || 'Selected product line'}</span>
                  <span className="mt-0.5 block font-mono text-xs font-normal text-muted-foreground">
                    {value.productLineKey}
                  </span>
                </>
              ) : (
                'Search product lines by title…'
              )}
            </span>
            <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))] p-0">
          <Command shouldFilter={false}>
            <CommandInput
              onValueChange={handleQueryChange}
              placeholder="Type a product line title…"
              value={query}
            />
            <CommandList className="max-h-72 overflow-y-auto">
              {loading ? (
                <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Searching…
                </p>
              ) : query.trim().length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">
                  Start typing to search product lines.
                </p>
              ) : (
                <CommandEmpty>
                  <p className="px-3 py-2 text-center text-xs text-muted-foreground">
                    No product line matches that search.
                  </p>
                </CommandEmpty>
              )}
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.productLineKey}
                    onSelect={() => {
                      onChange(option);
                      setOpen(false);
                    }}
                    value={option.productLineKey}
                  >
                    <div className="flex flex-col gap-0.5 py-0.5">
                      <span className="font-medium">{option.title}</span>
                      <span className="text-xs text-muted-foreground">{option.productLineKey}</span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <Button
        className="h-auto p-0 text-xs"
        disabled={disabled}
        onClick={() => setMode('manual')}
        size="sm"
        type="button"
        variant="link"
      >
        Enter a key manually instead
      </Button>
    </div>
  );
}
