import { OrphanSummaryCards } from '~/components/orphans/orphan-summary-cards';
import { getOrphanSummary } from '~/lib/orphans/orphan-queue-actions';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';

export const dynamic = 'force-dynamic';

export default async function OrphanDashboardPage() {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_PRODUCTS,
    'GET /admin/products/orphans',
  );

  const summary = await getOrphanSummary();
  // Match what the queue tables show by default: active, minus translated (B0-804).
  const totalTranslated = summary.reduce((n, r) => n + r.active_translated, 0);
  const totalActive = Math.max(0, summary.reduce((n, r) => n + r.active, 0) - totalTranslated);

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Orphan Monitor</h1>
        <p className="text-sm text-muted-foreground">
          Records that are out of sync — not linked to their parent, missing derived content, or never
          materialized.{' '}
          {totalTranslated > 0
            ? `${totalActive} active across all data types, plus ${totalTranslated} translated (non-English) documents hidden by default — those are never chunked or retrieved, so they are expected.`
            : `${totalActive} active across all data types.`}{' '}
          Acknowledge anything that is a known, acceptable orphan to hide it from the active queue.
        </p>
      </header>

      <OrphanSummaryCards summary={summary} />
    </div>
  );
}
