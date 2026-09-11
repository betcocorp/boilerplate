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

import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import { ScheduledTestsTable } from './scheduled-tests-table';

export const metadata = {
  title: 'Scheduled tests | Betco BEX',
  description: 'Scheduled test sweeps and their execution status and metrics.',
};

const PAGE_SIZE = 50;

type ScheduledTestRun = {
  id: string;
  sweep_name: string;
  sweep_triggered_at: string;
  status: string;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  elapsed_ms: number | null;
  total_tests: number;
  successful_tests: number;
  failed_tests: number;
  timed_out_tests: number;
  success_rate: number | null;
  avg_elapsed_ms: number | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
};

type ScheduledTestItem = {
  id: string;
  scheduled_run_id: string;
  test_id: string;
  test_name: string;
  test_run_id: string | null;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  elapsed_ms: number | null;
  items_total: number | null;
  items_passed: number | null;
  items_failed: number | null;
  pass_rate: number | null;
  grade: string | null;
  confidence: number | null;
  error_code: string | null;
  error_message: string | null;
  error_details: Record<string, unknown> | null;
  retry_count: number;
  last_retry_at: string | null;
  claimed_by: string | null;
  created_at: string;
  updated_at: string;
};

type ScheduledTestRunWithItems = ScheduledTestRun & {
  items: ScheduledTestItem[];
};

async function getRecentScheduledRuns(limit: number = PAGE_SIZE) {
  // Note: scheduled_test_runs and scheduled_test_items tables are real but not yet
  // in the generated Supabase types (B0-941), so we cast to any for now.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const client = getSupabaseServiceRoleClient() as any;
  const { data: runs, error: runsError } = await client
    .from('scheduled_test_runs')
    .select('*')
    .order('sweep_triggered_at', { ascending: false })
    .limit(limit);

  if (runsError) {
    throw new Error(
      `Failed to fetch scheduled test runs: ${runsError.message}`,
    );
  }

  if (!runs || runs.length === 0) {
    return [];
  }

  // Fetch test items for all runs
  const { data: items, error: itemsError } = await client
    .from('scheduled_test_items')
    .select('*')
    .in(
      'scheduled_run_id',
      (runs as ScheduledTestRun[]).map((r) => r.id),
    );

  if (itemsError) {
    throw new Error(
      `Failed to fetch scheduled test items: ${itemsError.message}`,
    );
  }

  // Group items by scheduled_run_id
  const itemsByRunId = new Map<string, ScheduledTestItem[]>();
  if (items) {
    for (const item of items as ScheduledTestItem[]) {
      if (!itemsByRunId.has(item.scheduled_run_id)) {
        itemsByRunId.set(item.scheduled_run_id, []);
      }
      itemsByRunId.get(item.scheduled_run_id)!.push(item);
    }
  }

  // Combine runs with their items
  return (runs as ScheduledTestRun[]).map(
    (run): ScheduledTestRunWithItems => ({
      ...run,
      items: itemsByRunId.get(run.id) || [],
    }),
  );
}

export default async function AdminScheduledTestsPage() {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_OBSERVABILITY,
    'GET /admin/scheduled',
  );
  await connection();

  let runs: ScheduledTestRunWithItems[] = [];
  let loadError: string | null = null;

  try {
    runs = await getRecentScheduledRuns(PAGE_SIZE);
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
              No scheduled test sweeps yet. Scheduled sweeps will appear here
              once they begin executing.
            </p>
          </section>
        ) : null}

        {runs.length > 0 ? <ScheduledTestsTable runs={runs} /> : null}
      </main>
    </div>
  );
}
