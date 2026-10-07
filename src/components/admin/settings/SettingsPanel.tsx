'use client';

import { useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';

import { SettingRow, type SettingRecord } from './SettingRow';

/**
 * B0-992 — the page is a view over `public.settings`, not a registry. Every row renders except
 * those another admin page owns (`ui_group = 'hidden'`, e.g. the RAG chunking/boost knobs edited
 * with bounds validation on the RAG page); the control comes from `value_type`, the card from
 * `ui_group`. Adding a setting is a migration, never a code change here.
 */
export const HIDDEN_UI_GROUP = 'hidden';
const UNGROUPED_LABEL = 'Other';

// Stable per-group anchor id, read by SettingsToc via `data-settings-toc-label`.
export function settingsGroupId(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `settings-group-${slug}`;
}

export function groupSettings(settings: SettingRecord[]): Array<[string, SettingRecord[]]> {
  const groups = new Map<string, SettingRecord[]>();
  for (const setting of settings) {
    if (setting.ui_group === HIDDEN_UI_GROUP) continue;
    const label = setting.ui_group?.trim() || UNGROUPED_LABEL;
    const bucket = groups.get(label) ?? [];
    bucket.push(setting);
    groups.set(label, bucket);
  }
  for (const bucket of groups.values()) {
    bucket.sort((a, b) => a.key.localeCompare(b.key));
  }
  // Named groups alphabetically, "Other" last.
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === UNGROUPED_LABEL) return 1;
    if (b === UNGROUPED_LABEL) return -1;
    return a.localeCompare(b);
  });
}

export function SettingsPanel() {
  const [settings, setSettings] = useState<SettingRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);

  const fetchSettings = async () => {
    try {
      const response = await fetch('/api/admin/settings');
      if (!response.ok) throw new Error('Failed to fetch settings');
      const data = await response.json();
      setSettings(data.settings);
    } catch (error) {
      console.error('Error fetching settings:', error);
      toast.error('Failed to load settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    fetchSettings();
  }, []);

  const post = async (body: Record<string, unknown>, key: string, next: string | null) => {
    setSaving(key);
    try {
      const response = await fetch('/api/admin/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Failed to update setting');
      }
      setSettings((prev) => prev.map((s) => (s.key === key ? { ...s, value: next } : s)));
      toast.success(next === null ? `${key} reset to default` : `${key} updated`);
    } catch (error) {
      console.error('Error updating setting:', error);
      toast.error(error instanceof Error ? error.message : 'Failed to update setting');
    } finally {
      setSaving(null);
    }
  };

  const handleUpdateSetting = (key: string, value: string) => post({ key, value }, key, value);
  const handleResetSetting = (key: string) => post({ key, reset: true }, key, null);

  if (loading) {
    return (
      <div className="grid gap-6">
        <Skeleton className="h-64" />
        <Skeleton className="h-64" />
      </div>
    );
  }

  const groups = groupSettings(settings);

  return (
    <div className="grid gap-6">
      {groups.map(([label, rows]) => (
        <Card
          className="scroll-mt-6"
          data-settings-toc-label={label}
          id={settingsGroupId(label)}
          key={label}
        >
          <CardHeader>
            <CardTitle>{label}</CardTitle>
            <CardDescription>
              {rows.length} setting{rows.length === 1 ? '' : 's'} · read from the settings table;
              changes take effect within 30 seconds, no deploy.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6">
              {rows.map((setting) => (
                <SettingRow
                  key={setting.key}
                  setting={setting}
                  onUpdate={handleUpdateSetting}
                  onReset={handleResetSetting}
                  isSaving={saving === setting.key}
                />
              ))}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
