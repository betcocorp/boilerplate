'use client';

import { useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';

type QueryOption = {
  query: string;
  queryCount: number;
};

type RagQueryAutocompleteProps = {
  defaultValue: string;
  options: QueryOption[];
  name?: string;
  placeholder?: string;
};

export function RagQueryAutocomplete({
  defaultValue,
  name = 'q',
  options,
  placeholder,
}: RagQueryAutocompleteProps) {
  const router = useRouter();
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  const filteredOptions = useMemo(() => {
    const query = value.trim().toLowerCase();
    if (!query) {
      return options;
    }

    return options.filter((option) =>
      option.query.toLowerCase().includes(query),
    );
  }, [options, value]);

  return (
    <div className="relative">
      <Input
        autoComplete="off"
        className="h-12 rounded-2xl border-border bg-background px-4"
        name={name}
        onBlur={() => {
          if (closeTimerRef.current !== null) {
            window.clearTimeout(closeTimerRef.current);
          }
          closeTimerRef.current = window.setTimeout(() => setOpen(false), 120);
        }}
        onChange={(event) => {
          const nextValue = event.target.value;
          setValue(nextValue);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        ref={inputRef}
        type="search"
        value={value}
      />

      {open ? (
        <div className="absolute z-20 mt-2 max-h-72 w-full overflow-auto rounded-2xl border border-slate-200 bg-white p-2 shadow-xl">
          {filteredOptions.length === 0 ? (
            <p className="px-2 py-2 text-xs text-slate-500">No matching queries.</p>
          ) : (
            filteredOptions.map((option) => (
              <Button
                className="h-auto w-full justify-between rounded-xl px-2 py-2 font-normal text-slate-700 hover:bg-slate-100"
                key={`${option.query}-${option.queryCount}`}
                onMouseDown={(event) => {
                  // Keep focus on the input so blur doesn't collapse
                  // the menu before click selection runs.
                  event.preventDefault();
                }}
                onClick={() => {
                  setValue(option.query);
                  setOpen(false);
                  const form = inputRef.current?.form;
                  if (form) {
                    if ((form.method || 'get').toLowerCase() === 'get') {
                      const formData = new FormData(form);
                      formData.set(name, option.query);
                      const params = new URLSearchParams();

                      for (const [key, fieldValue] of formData.entries()) {
                        if (typeof fieldValue === 'string') {
                          params.set(key, fieldValue);
                        }
                      }

                      const action = form.getAttribute('action')?.trim() || '';
                      const queryString = params.toString();
                      router.push(action ? `${action}?${queryString}` : `?${queryString}`);
                    } else {
                      window.setTimeout(() => {
                        form.requestSubmit();
                      }, 0);
                    }
                  }
                }}
                type="button"
                variant="ghost"
              >
                <span className="truncate pr-3">{option.query}</span>
                <span className="shrink-0 text-xs text-slate-500">
                  {option.queryCount}
                </span>
              </Button>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}
