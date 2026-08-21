'use client';

import { useState } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Input } from '~/components/ui/input';

type SettingRecord = {
  key: string;
  value: string;
  value_type: 'string' | 'number';
  description?: string;
  allowed_values?: string[];
};

type Props = {
  setting: SettingRecord;
  onUpdate: (key: string, value: string) => Promise<void>;
  isSaving: boolean;
};

export function StringSelectSetting({ setting, onUpdate, isSaving }: Props) {
  const [value, setValue] = useState(setting.value);

  const handleSelectChange = async (newValue: string) => {
    setValue(newValue);
    await onUpdate(setting.key, newValue);
  };

  const handleInputBlur = async () => {
    if (value !== setting.value) {
      await onUpdate(setting.key, value);
    }
  };

  const hasAllowedValues =
    setting.allowed_values && setting.allowed_values.length > 0;

  return (
    <div className="flex items-end justify-between gap-4">
      <div className="flex-1">
        <p className="font-medium text-sm">{setting.key}</p>
        {setting.description && (
          <p className="text-xs text-muted-foreground mt-1">
            {setting.description}
          </p>
        )}
      </div>
      {hasAllowedValues ? (
        <Select value={value} onValueChange={handleSelectChange} disabled={isSaving}>
          <SelectTrigger className="w-48">
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
      ) : (
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onBlur={handleInputBlur}
          disabled={isSaving}
          type={setting.value_type === 'number' ? 'number' : 'text'}
          className="w-48"
        />
      )}
    </div>
  );
}
