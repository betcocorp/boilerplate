import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { z } from 'zod';

import { ThursdayScorecardExports } from '~/components/admin/tests/ThursdayScorecardExports';
import { ThursdayScorecardSection } from '~/components/admin/tests/ThursdayScorecardSection';
import { Button } from '~/components/ui/button';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import { loadThursdayScorecard } from '~/lib/tests/thursday-scorecard';
import { formatEasternSweepLabel } from '~/lib/utils/time';

export const metadata: Metadata = {
  title: 'Thursday report card | Betco Bex',
  description: "One Thursday-night golden sweep's agent report card.",
};

type PageProps = {
  params: Promise<{ sweepId: string }>;
};

/** B0-1170 — one Thursday report card, standalone: no picker, no link back to itself. */
export default async function ThursdayScorecardDetailPage({ params }: PageProps) {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_TESTS,
    'GET /admin/tests/reports/scorecards/[sweepId]',
  );
  await connection();
  const { sweepId } = await params;

  // A malformed id is "unknown" too — 404 rather than a Postgres cast error.
  if (!z.uuid().safeParse(sweepId).success) {
    notFound();
  }

  const data = await loadThursdayScorecard({ sweepId, includeSupporting: true });
  // The loader degrades an unknown id to the newest sweep; a card page must never show another night.
  if (!data.snapshot || data.snapshot.sweep.id !== sweepId) {
    notFound();
  }
  const { snapshot } = data;
  const previousLabel = snapshot.previousSweep
    ? formatEasternSweepLabel(snapshot.previousSweep.sweepTriggeredAt)
    : null;

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex-1">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                Thursday report card
              </p>
              <h1 className="mt-2 text-4xl font-semibold tracking-tight text-slate-950">
                {formatEasternSweepLabel(snapshot.sweep.sweepTriggeredAt)}
              </h1>
              <p className="mt-3 text-sm text-slate-600">
                {`${snapshot.sweep.successfulTests} of ${snapshot.sweep.totalTests} agents ran · Change vs ${previousLabel ?? 'no earlier Thursday-night sweep'}`}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link href="/admin/tests/reports/scorecards">All report cards</Link>
              </Button>
              <Button asChild variant="outline">
                <Link href="/admin/tests/reports">Reports</Link>
              </Button>
            </div>
          </div>
        </section>

        <ThursdayScorecardSection
          data={data}
          exportsSlot={
            <ThursdayScorecardExports
              captureTargetId="thursday-scorecard-capture"
              hasRows={snapshot.agents.length > 0}
              sweepId={snapshot.sweep.id}
              sweepTriggeredAt={snapshot.sweep.sweepTriggeredAt}
            />
          }
          hidePicker
          historyHref={null}
          selectedSweepId={sweepId}
        />
      </main>
    </div>
  );
}
