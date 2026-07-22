import { OrphanSummaryCards } from '~/components/orphans/orphan-summary-cards';
import { getOrphanSummary } from '~/lib/orphans/orphan-queue-actions';

export const dynamic = 'force-dynamic';

export default async function OrphanDashboardPage() {
  const summary = await getOrphanSummary();
  const totalActive = summary.reduce((n, r) => n + r.active, 0);

  return (
    <div className="space-y-6 p-6">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Orphan Monitor</h1>
        <p className="text-sm text-muted-foreground">
          Records that are out of sync — not linked to their parent, missing derived content, or never
          materialized. {totalActive} active across all data types. Acknowledge anything that is a known,
          acceptable orphan to hide it from the active queue.
        </p>
      </header>

      <OrphanSummaryCards summary={summary} />
    </div>
  );
}
