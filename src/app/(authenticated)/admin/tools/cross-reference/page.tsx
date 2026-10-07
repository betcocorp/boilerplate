import { redirect } from 'next/navigation';

import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';

// The consolidated area has no landing view of its own — default to the Lookup tab so
// the active-tab highlight (derived from the pathname) always resolves.
export default async function CrossReferenceIndexPage() {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_TOOLS,
    'GET /admin/tools/cross-reference',
  );

  redirect('/admin/tools/cross-reference/lookup');
}
