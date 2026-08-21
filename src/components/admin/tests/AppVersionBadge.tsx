import { Badge } from '~/components/ui/badge';

/**
 * B0-472 — run-level chip for the `app_version` (package.json version) stamped at run-creation
 * time. Renders nothing for a run recorded before the column existed (AC: never a misleading
 * placeholder), same convention as `PromptBundleVersionBadge` / `RuntimeConfigBadge`.
 */
export function AppVersionBadge({ appVersion }: { appVersion: string | null }) {
  if (!appVersion) {
    return null;
  }

  return (
    <Badge title={`app_version: ${appVersion}`} variant="outline">
      v{appVersion}
    </Badge>
  );
}
