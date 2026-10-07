'use client';

import { CalendarIcon } from 'lucide-react';
import type { Control, FieldPath, FieldValues } from 'react-hook-form';

import {
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '~/components/ui/form';
import { Input } from '~/components/ui/input';

/**
 * `react-hook-form`-bound date field. The stored value is an ISO `yyyy-MM-dd` string, which is what
 * `POST /api/admin/permissions/groups` expects for `startAt` / `endAt`.
 *
 * Deliberate difference from c360's `components/custom/FormDateField`: c360 rendered a read-only
 * text input over a Radix Popover containing a `react-day-picker` `Calendar`. this app has neither
 * `react-day-picker` nor a `Calendar` primitive, and this ticket may not add dependencies, so the
 * control is a native `<input type="date">`. It emits exactly the same `yyyy-MM-dd` value, is
 * keyboard- and screen-reader-accessible for free, and drops the popover's hydration caveats.
 */
export function FormDateField<TFieldValues extends FieldValues = FieldValues>({
  control,
  label,
  name,
  placeholder,
  required = false,
}: {
  control: Control<TFieldValues>;
  label: string;
  name: FieldPath<TFieldValues>;
  /** Shown as the field's accessible hint; a native date input has no text placeholder. */
  placeholder: string;
  required?: boolean;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem className="w-full">
          <FormLabel>
            {label}
            {required ? <span className="text-destructive">*</span> : null}
          </FormLabel>
          <FormControl>
            <div className="relative w-full">
              <CalendarIcon className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label={placeholder}
                className="w-full pl-10"
                name={field.name}
                onBlur={field.onBlur}
                onChange={(event) =>
                  field.onChange(event.target.value || undefined)
                }
                ref={field.ref}
                required={required}
                type="date"
                value={(field.value as string | undefined) ?? ''}
              />
            </div>
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}
