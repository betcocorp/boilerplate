import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { z } from 'zod';

import { SweepTestSetCard } from '~/components/admin/tests/SweepTestSetCard';
import { getStatusBadgeColor } from '~/components/admin/tests/sweep-status';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { getScheduledTestRunWithItems } from '~/lib/observability/scheduled-test-repository';
import {
  formatRate,
  getRunDisplayCounts,
  getRunDisplayStatus,
  getSweepSourceLabel,
} from '~/lib/observability/scheduled-test-types';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import { getTestById, listTestResultsByIds } from '~/lib/tests/repository';
import type { TestResultRecord } from '~/lib/tests/types';
import { formatDurationMs, formatEasternTimestamp } from '~/lib/utils/time';

export const metadata: Metadata = {
  title: 'Sweep | Betco BEX',
  description: 'One golden test sweep and the run it started for each test set.',
};

type PageProps = {
  params: Promise<{ sweepId: string }>;
};

/**
 * B0-1108 — one sweep from the ledger (`scheduled_test_runs` + `scheduled_test_items`) with a card
 * per child linking to its run. Reads the ledger and the specific `test_results` rows the children
 * point at, by id only — never a golden-metric aggregate reader.
 */
export default async function SweepDetailPage({ params }: PageProps) {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_TESTS,
    'GET /admin/tests/sweeps/[sweepId]',
  );
  await connection();
  const { sweepId } = await params;

  // A malformed id is "unknown" too — 404 rather than a Postgres cast error.
  if (!z.uuid().safeParse(sweepId).success) {
    notFound();
  }

  const sweep = await getScheduledTestRunWithItems(sweepId);
  if (!sweep) {
    notFound();
  }

  const runIds = sweep.items
    .map((item) => item.test_run_id)
    .filter((id): id is string => typeof id === 'string');
  const [results, rowCounts] = await Promise.all([
    listTestResultsByIds(runIds),
    // Row counts size the "N of M items" line, which only a partial sweep shows.
    sweep.run_mode === 'partial'
      ? Promise.all(
          Array.from(new Set(sweep.items.map((item) => item.test_id))).map(
            async (testId) => {
              const test = await getTestById(testId).catch(() => null);
              return [testId, test?.row_count ?? null] as const;
            },
          ),
        )
      : Promise.resolve([] as (readonly [string, number | null])[]),
  ]);
  const resultById = new Map<string, TestResultRecord>(
    results.map((result) => [result.id, result]),
  );
  const rowCountByTestId = new Map<string, number | null>(rowCounts);

  const displayStatus = getRunDisplayStatus(sweep);
  const counts = getRunDisplayCounts(sweep);
  const isPartial = sweep.run_mode === 'partial';

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-start">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                {isPartial ? 'Partial sweep' : 'Sweep'}
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                {formatEasternTimestamp(sweep.sweep_triggered_at)}
              </h1>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Badge
                  className={`border ${getStatusBadgeColor(displayStatus)}`}
                  title="Derived from the sweep's children; the stored parent status lags until the hourly reconciler runs"
                >
                  {displayStatus}
                </Badge>
                <Badge variant="outline" title={`sweep_name: ${sweep.sweep_name}`}>
                  {getSweepSourceLabel(sweep.sweep_name)}
                </Badge>
                <Badge variant="outline" title={`run_mode: ${sweep.run_mode}`}>
                  {isPartial
                    ? `Partial · below ${sweep.partial_score_threshold ?? '?'}`
                    : 'Full'}
                </Badge>
              </div>
              {sweep.error_message ? (
                <p className="mt-3 text-sm text-red-700">{sweep.error_message}</p>
              ) : null}
            </div>
            <Button asChild variant="outline">
              <Link href="/admin/tests">Back to tests</Link>
            </Button>
          </div>

          <dl className="mt-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                Total sets
              </dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                {sweep.total_tests}
              </dd>
            </div>
            <div title="Completed / Error / Timeout — derived from the children">
              <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                C / E / TO
              </dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                <span className="text-green-700">{counts.successful}</span>
                <span className="text-slate-400">/</span>
                <span className="text-red-700">{counts.failed}</span>
                <span className="text-slate-400">/</span>
                <span className="text-orange-700">{counts.timedOut}</span>
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                Success rate
              </dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                {formatRate(counts.successRate)}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-[0.1em] text-slate-500">
                Elapsed
              </dt>
              <dd className="mt-1 text-2xl font-semibold tabular-nums text-slate-900">
                {sweep.elapsed_ms ? formatDurationMs(sweep.elapsed_ms) : '—'}
              </dd>
            </div>
          </dl>
        </section>

        <section>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Test sets</h2>
            <span className="text-sm text-slate-600">
              {sweep.items.length}{' '}
              {sweep.items.length === 1 ? 'test set' : 'test sets'}
            </span>
          </div>
          {sweep.items.length === 0 ? (
            <div className="rounded-3xl border border-slate-200 bg-white p-8 text-center text-sm text-slate-600">
              No test sets were recorded for this sweep.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {sweep.items.map((item) => (
                <SweepTestSetCard
                  item={item}
                  key={item.id}
                  partialScoreThreshold={sweep.partial_score_threshold}
                  result={
                    item.test_run_id
                      ? (resultById.get(item.test_run_id) ?? null)
                      : null
                  }
                  runMode={sweep.run_mode}
                  testRowCount={rowCountByTestId.get(item.test_id) ?? null}
                />
              ))}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
