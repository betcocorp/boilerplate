'use client';

import { Switch } from '~/components/ui/switch';

type SettingRecord = {
  key: string;
  value: string;
  description?: string;
};

type Props = {
  setting: SettingRecord;
  onUpdate: (key: string, value: string) => Promise<void>;
  isSaving: boolean;
};

export function BooleanToggleSetting({ setting, onUpdate, isSaving }: Props) {
  const isEnabled = setting.value.toLowerCase() === 'true';

  const handleToggle = async (checked: boolean) => {
    await onUpdate(setting.key, checked ? 'true' : 'false');
  };

  return (
    <div className="flex items-center justify-between">
      <div className="flex-1">
        <p className="font-medium text-sm">{setting.key}</p>
        {setting.description && (
          <p className="text-xs text-muted-foreground mt-1">
            {setting.description}
          </p>
        )}
      </div>
      <Switch
        checked={isEnabled}
        onCheckedChange={handleToggle}
        disabled={isSaving}
      />
    </div>
  );
}
