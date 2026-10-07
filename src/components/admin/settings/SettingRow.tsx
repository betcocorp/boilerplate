'use client';

import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Switch } from '~/components/ui/switch';

export type SettingRecord = {
  key: string;
  /** Null when the row is unset and the reader is on `default_value` (B0-992). */
  value: string | null;
  value_type: 'boolean' | 'string' | 'number';
  description?: string | null;
  allowed_values?: string[] | null;
  default_value?: string | null;
  ui_group?: string | null;
};

type Props = {
  setting: SettingRecord;
  onUpdate: (key: string, value: string) => Promise<void>;
  onReset: (key: string) => Promise<void>;
  isSaving: boolean;
};

/** Type-aware equality so "0.60" vs "0.6" or "TRUE" vs "true" does not offer a pointless reset. */
export function valuesEqual(
  valueType: SettingRecord['value_type'],
  a: string,
  b: string,
): boolean {
  if (valueType === 'number') {
    const na = Number(a);
    const nb = Number(b);
    return Number.isFinite(na) && Number.isFinite(nb) ? na === nb : a === b;
  }
  if (valueType === 'boolean') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

/**
 * B0-992 — one control per row, chosen from `value_type` (+ `allowed_values` for a select), so a
 * row inserted into `public.settings` renders with no code change. Shows the effective value
 * (`value ?? default_value`), the default when one exists, and a reset when the stored value
 * differs from it.
 */
export function SettingRow({ setting, onUpdate, onReset, isSaving }: Props) {
  const effective = setting.value ?? setting.default_value ?? '';

  const hasDefault = setting.default_value !== null && setting.default_value !== undefined;
  const isAtDefault =
    hasDefault &&
    (setting.value === null ||
      valuesEqual(setting.value_type, setting.value, setting.default_value as string));
  const hasAllowedValues = Boolean(setting.allowed_values && setting.allowed_values.length > 0);

  const control = (() => {
    if (setting.value_type === 'boolean') {
      return (
        <Switch
          checked={effective.toLowerCase() === 'true'}
          onCheckedChange={(checked) => onUpdate(setting.key, checked ? 'true' : 'false')}
          disabled={isSaving}
          aria-label={setting.key}
        />
      );
    }
    if (hasAllowedValues) {
      return (
        <Select
          value={effective}
          onValueChange={(next) => onUpdate(setting.key, next)}
          disabled={isSaving}
        >
          <SelectTrigger className="w-56" aria-label={setting.key}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {setting.allowed_values!.map((option) => (
              <SelectItem key={option} value={option}>
                {option}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    return (
      // Uncontrolled and keyed on the effective value: a save or reset re-mounts it with the new
      // value, and a blur with an unchanged value is a no-op.
      <Input
        key={effective}
        defaultValue={effective}
        onBlur={(e) => {
          const next = e.currentTarget.value;
          if (next !== effective) void onUpdate(setting.key, next);
        }}
        disabled={isSaving}
        type={setting.value_type === 'number' ? 'number' : 'text'}
        step={setting.value_type === 'number' ? 'any' : undefined}
        className="w-56"
        aria-label={setting.key}
      />
    );
  })();

  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-sm font-medium break-all">{setting.key}</p>
        {setting.description && (
          <p className="mt-1 text-xs text-muted-foreground">{setting.description}</p>
        )}
        {hasDefault && (
          <p className="mt-1 text-xs text-muted-foreground">
            Default: <span className="font-mono">{setting.default_value}</span>
            {setting.value === null && ' (in effect — no value set)'}
          </p>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {control}
        {hasDefault && !isAtDefault && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onReset(setting.key)}
            disabled={isSaving}
            title={`Reset to ${setting.default_value}`}
          >
            Reset
          </Button>
        )}
      </div>
    </div>
  );
}
