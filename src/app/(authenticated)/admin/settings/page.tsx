import { GoldenSetAndTierTargets } from '~/components/admin/settings/GoldenSetAndTierTargets';
import { SettingsPanel } from '~/components/admin/settings/SettingsPanel';
import {
  SETTINGS_TOC_CONTAINER_ID,
  SettingsToc,
} from '~/components/admin/settings/SettingsToc';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';

export const metadata = {
  title: 'Settings | Betco BEX',
  description: 'Configure environment variables and feature toggles.',
};

export default async function SettingsPage() {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_USER_SETTINGS,
    'GET /admin/settings',
  );

  return (
    <div className="flex flex-col gap-6 p-6 lg:flex-row lg:items-start">
      <div className="flex min-w-0 flex-1 flex-col gap-6" id={SETTINGS_TOC_CONTAINER_ID}>
        <div>
          <h1 className="text-2xl font-semibold">Settings</h1>
          <p className="text-sm text-muted-foreground">
            Configure environment variables and feature toggles for Bex.
          </p>
        </div>
        <GoldenSetAndTierTargets />
        <SettingsPanel />
      </div>
      <SettingsToc className="hidden lg:sticky lg:top-6 lg:block lg:w-64 lg:shrink-0" />
    </div>
  );
}
