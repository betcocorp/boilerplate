'use client';

import { useState } from 'react';
import type { ReactNode } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';

/**
 * Radix `SelectItem` cannot itself carry an empty-string `value` (it collides with the
 * placeholder-detection Radix uses internally), so an internal sentinel stands in for `''` in the
 * visible list and is translated back at every boundary in/out of this component.
 */
const EMPTY_VALUE_SENTINEL = '__bex_empty__';
const toDisplayValue = (value: string) => (value === '' ? EMPTY_VALUE_SENTINEL : value);
const toRealValue = (value: string) => (value === EMPTY_VALUE_SENTINEL ? '' : value);

export type FormSelectFieldOption = {
  value: string;
  label: ReactNode;
  disabled?: boolean;
};

type FormSelectFieldProps = {
  /**
   * Only pass this when the field lives inside a `<form>` (native GET/POST, a server action, or
   * `RagSearchControls`'s `new FormData(formRef.current)` pattern) that reads it by name. Omit it
   * for selects driven entirely by React state or router navigation.
   */
  name?: string;
  /** Controlled usage (pair with `onValueChange`). Omit both for uncontrolled/`defaultValue` usage. */
  value?: string;
  /** Uncontrolled usage: seeds internal state once, like `<NativeSelect defaultValue>` did. */
  defaultValue?: string;
  onValueChange?: (value: string) => void;
  options: FormSelectFieldOption[];
  placeholder?: string;
  className?: string;
  id?: string;
  ariaLabel?: string;
  disabled?: boolean;
  required?: boolean;
};

/**
 * B0-676 — shadcn `Select` replacement for a `NativeSelect` that (a) offers an empty-string
 * option (e.g. "All") and (b) must still submit/report that real `''` domain value. Radix's own
 * `name`-bubbling mirrors whatever value the `Select` displays, so if the "All" item used a
 * sentinel value directly, a surrounding form would submit the sentinel string instead of `''`,
 * silently breaking "no filter" semantics downstream. This renders the `Select` purely for
 * display/interaction and, when `name` is given, a separate hidden `<input>` carrying the real
 * value, so the two can never drift.
 */
export function FormSelectField({
  name,
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder,
  className,
  id,
  ariaLabel,
  disabled,
  required,
}: FormSelectFieldProps) {
  const [internalValue, setInternalValue] = useState(defaultValue ?? value ?? '');
  const current = onValueChange ? (value ?? '') : internalValue;

  function handleValueChange(next: string) {
    const real = toRealValue(next);
    if (onValueChange) {
      onValueChange(real);
    } else {
      setInternalValue(real);
    }
  }

  return (
    <>
      <Select disabled={disabled} onValueChange={handleValueChange} value={toDisplayValue(current)}>
        <SelectTrigger aria-label={ariaLabel} className={className} id={id}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              disabled={option.disabled}
              key={option.value === '' ? EMPTY_VALUE_SENTINEL : option.value}
              value={toDisplayValue(option.value)}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {name ? <input name={name} required={required} type="hidden" value={current} /> : null}
    </>
  );
}
