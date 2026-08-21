import { SettingsPanel } from '~/components/admin/settings/SettingsPanel';

export const metadata = {
  title: 'Settings | Betco BEX',
  description: 'Configure environment variables and feature toggles.',
};

export default async function SettingsPage() {
  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Configure environment variables and feature toggles for Bex.
        </p>
      </div>
      <SettingsPanel />
    </div>
  );
}
