import { BexCompareApp } from '~/components/bex/BexCompareApp';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';

// B0-839 — this page was previously a client component ('use client', not async), which cannot
// call the Server Component permission guard directly. The client UI is unchanged and now lives
// in ~/components/bex/BexCompareApp.tsx; this file is a thin async Server Component wrapper so
// requirePagePermission can run first, per this codebase's route-file convention.
export default async function BexComparePage() {
  await requirePagePermission(PERMISSIONS.NAVIGATION_SIDEBAR_COMPARE, 'GET /admin/bex/compare');

  return <BexCompareApp />;
}
