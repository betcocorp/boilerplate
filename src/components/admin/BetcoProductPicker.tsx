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
import type { BetcoProductOption } from '~/lib/recommendations/product-picker';
import { searchBetcoProductOptions } from '~/lib/recommendations/review-actions';
import { cn } from '~/lib/utils';

/**
 * B0-441 — searchable Betco product picker for the recommendation queue ("Add a candidate" /
 * "Edit chosen candidate"). Replaces free-typed `betco_product_key` entry: that key is a GUID FK
 * into `legacy.products."ProductsKey"` with no cross-schema constraint, so a mistyped value used
 * to resolve to nothing silently. Search is server-backed (`searchBetcoProductOptions`, debounced)
 * against `rag.entity` (entity_type='product') rather than shipping all 9,237 rows to the client.
 *
 * Picker-first: manual key/title entry is still available (~4,500 legacy products have no
 * `rag.entity` row and are exactly the long-tail case that fallback exists for), but collapsed
 * behind an explicit "enter a key manually" toggle rather than the default.
 */

export type BetcoProductPickerValue = {
  betcoProductKey: string;
  betcoTitle: string;
};

type BetcoProductPickerProps = {
  idPrefix: string;
  value: BetcoProductPickerValue;
  onChange: (value: BetcoProductPickerValue) => void;
  disabled?: boolean;
};

const DEBOUNCE_MS = 250;

export function BetcoProductPicker({ idPrefix, value, onChange, disabled }: BetcoProductPickerProps) {
  const [mode, setMode] = useState<'picker' | 'manual'>('picker');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<BetcoProductOption[]>([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  // Cleanup only (no setState) — safe to clear any pending debounced search on unmount.
  useEffect(
    () => () => {
      if (debounceRef.current !== null) clearTimeout(debounceRef.current);
    },
    [],
  );

  /** Debounced, request-ordering-safe search — driven by the input's change handler, not an effect. */
  function handleQueryChange(next: string) {
    setQuery(next);
    if (debounceRef.current !== null) clearTimeout(debounceRef.current);

    const trimmed = next.trim();
    if (!trimmed) {
      requestIdRef.current += 1; // invalidate any in-flight request
      setOptions([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const requestId = ++requestIdRef.current;
    debounceRef.current = setTimeout(() => {
      searchBetcoProductOptions(trimmed)
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
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-manual-title`}>Betco title</Label>
            <Input
              disabled={disabled}
              id={`${idPrefix}-manual-title`}
              onChange={(e) => onChange({ ...value, betcoTitle: e.target.value })}
              value={value.betcoTitle}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`${idPrefix}-manual-key`}>Betco product key</Label>
            <Input
              disabled={disabled}
              id={`${idPrefix}-manual-key`}
              onChange={(e) => onChange({ ...value, betcoProductKey: e.target.value })}
              value={value.betcoProductKey}
            />
          </div>
        </div>
        <Button
          className="h-auto p-0 text-xs"
          disabled={disabled}
          onClick={() => setMode('picker')}
          size="sm"
          type="button"
          variant="link"
        >
          Use the product search instead
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <Label htmlFor={`${idPrefix}-picker`}>Betco product</Label>
      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <Button
            aria-expanded={open}
            className={cn(
              'h-auto min-h-9 w-full justify-between rounded-2xl border border-input bg-background px-3 py-2 font-normal whitespace-normal text-left hover:bg-accent/40',
              !value.betcoProductKey && 'text-muted-foreground',
            )}
            disabled={disabled}
            id={`${idPrefix}-picker`}
            role="combobox"
            type="button"
            variant="outline"
          >
            <span className="line-clamp-2 text-left">
              {value.betcoProductKey ? (
                <>
                  <span className="font-medium text-foreground">{value.betcoTitle || 'Selected product'}</span>
                  <span className="mt-0.5 block font-mono text-xs font-normal text-muted-foreground">
                    {value.betcoProductKey}
                  </span>
                </>
              ) : (
                'Search Betco products by title or SKU…'
              )}
            </span>
            <ChevronDownIcon className="size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))] p-0">
          <Command shouldFilter={false}>
            <CommandInput
              onValueChange={handleQueryChange}
              placeholder="Type a product name or SKU…"
              value={query}
            />
            <CommandList className="max-h-72 overflow-y-auto">
              {loading ? (
                <p className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" /> Searching…
                </p>
              ) : query.trim().length === 0 ? (
                <p className="px-3 py-3 text-xs text-muted-foreground">
                  Start typing to search Betco products.
                </p>
              ) : (
                <CommandEmpty>
                  <p className="px-3 py-2 text-center text-xs text-muted-foreground">
                    No Betco product matches that search.
                  </p>
                </CommandEmpty>
              )}
              <CommandGroup>
                {options.map((option) => (
                  <CommandItem
                    key={option.productKey}
                    onSelect={() => {
                      onChange({ betcoProductKey: option.productKey, betcoTitle: option.title });
                      setOpen(false);
                    }}
                    value={option.productKey}
                  >
                    <div className="flex flex-col gap-0.5 py-0.5">
                      <span className="font-medium">{option.title}</span>
                      <span className="text-xs text-muted-foreground">
                        {option.sku ? `SKU ${option.sku} · ` : ''}
                        {option.productKey}
                      </span>
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
