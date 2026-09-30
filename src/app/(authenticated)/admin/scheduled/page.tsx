/**
 * B0-941 — Scheduled test observability page.
 *
 * Server component. Displays recent scheduled test runs (sweeps) with:
 *  - Sweep triggered date/time
 *  - Status badge (queued/in_progress/completed/failed)
 *  - Total tests, successful, failed, timed out
 *  - Success rate (%)
 *  - Elapsed time
 *  - Expandable rows showing test items
 *
 * Each test item row shows:
 *  - Test name
 *  - Status
 *  - Items passed/failed/total
 *  - Pass rate
 *  - Error code (if any)
 *  - Elapsed time
 */

import { connection } from 'next/server';

import {
  DEFAULT_SWEEP_NAME,
  listRecentScheduledTestRuns,
} from '~/lib/observability/scheduled-test-repository';
import type { ScheduledTestRunWithItems } from '~/lib/observability/scheduled-test-types';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';

import { ScheduledTestsTable } from './scheduled-tests-table';

export const metadata = {
  title: 'Scheduled tests | Betco BEX',
  description: 'Scheduled test sweeps and their execution status and metrics.',
};

const PAGE_SIZE = 50;

export default async function AdminScheduledTestsPage() {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_OBSERVABILITY,
    'GET /admin/scheduled',
  );
  await connection();

  let runs: ScheduledTestRunWithItems[] = [];
  let loadError: string | null = null;

  try {
    // B0-1106 — cron-only by decision: manual and partial Run Golden sweeps are listed under the
    // Sweeps / Partial sweeps sections on /admin/tests, so this page's title stays true.
    runs = await listRecentScheduledTestRuns({
      sweepName: DEFAULT_SWEEP_NAME,
      limit: PAGE_SIZE,
    });
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : 'Unable to load scheduled test runs. If this persists, check the Supabase service-role configuration.';
  }

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        {/* Header */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Observability
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            Scheduled test sweeps
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
            Recent scheduled test runs and their constituent test items. Each
            sweep shows aggregate metrics including total tests, success/failure
            counts, success rate, and execution time. Expand a sweep to see
            detailed per-test results.
          </p>
        </section>

        {loadError ? (
          <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
            {loadError}
          </section>
        ) : null}

        {runs.length === 0 && !loadError ? (
          <section className="rounded-3xl border border-slate-200 bg-white p-8 text-center">
            <p className="text-slate-600">
              No scheduled test sweeps yet. A sweep appears here as soon as the
              nightly cron dispatches one at 00:00 UTC, or immediately after you
              trigger one by hand with{' '}
              <code className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-sm text-slate-800">
                pnpm run:golden-sweep
              </code>
              .
            </p>
          </section>
        ) : null}

        {runs.length > 0 ? <ScheduledTestsTable runs={runs} /> : null}
      </main>
    </div>
  );
}
