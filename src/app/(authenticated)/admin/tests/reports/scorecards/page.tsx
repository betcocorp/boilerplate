import type { Metadata } from 'next';
import Link from 'next/link';
import { connection } from 'next/server';

import { ThursdayScorecardHistoryTable } from '~/components/admin/tests/ThursdayScorecardHistoryTable';
import { Button } from '~/components/ui/button';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import { loadThursdayScorecardHistory } from '~/lib/tests/thursday-scorecard';

export const metadata: Metadata = {
  title: 'Thursday report cards | Betco Bex',
  description: 'Every Thursday-night golden sweep as one report-card row.',
};

/** B0-1170 — the history of Thursday report cards; each row opens that night's card. */
export default async function ThursdayScorecardHistoryPage() {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_TESTS,
    'GET /admin/tests/reports/scorecards',
  );
  await connection();
  const history = await loadThursdayScorecardHistory();

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex-1">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                Quality test runner
              </p>
              <h1 className="mt-2 text-4xl font-semibold tracking-tight text-slate-950">
                Thursday report cards
              </h1>
              <p className="mt-3 text-sm text-slate-600">
                One row per Thursday-night golden sweep, newest first. Open a row to view that
                night&apos;s report card.
              </p>
            </div>
            <Button asChild variant="outline">
              <Link href="/admin/tests/reports">Back to reports</Link>
            </Button>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-900">Report cards</h2>
            <span className="text-sm text-slate-600">
              {`${history.rows.length} Thursday${history.rows.length === 1 ? '' : 's'}`}
            </span>
          </div>
          <ThursdayScorecardHistoryTable history={history} />
        </section>
      </main>
    </div>
  );
}
