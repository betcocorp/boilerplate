import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { RunReportView } from '~/components/admin/tests/RunReportView';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { isPermissionsEnforced } from '~/lib/permissions/enforcement';
import {
  getCurrentUserPermissions,
  hasPermission,
} from '~/lib/permissions/permissions-server';
import { completedPassCount, parseReportState } from '~/lib/tests/report/schemas';
import { getTestById, getTestResultById } from '~/lib/tests/repository';
import { isCompletedRunStatus } from '~/lib/tests/types';

export const metadata = {
  title: 'Run Report | Betco BEX',
  description: 'LLM-graded agent-evaluation report for a test run.',
};

type PageProps = {
  params: Promise<{ testId: string; runId: string }>;
};

export default async function AdminTestRunReportPage({ params }: PageProps) {
  await connection();
  const { testId, runId } = await params;

  const [test, result, permissions, enforced] = await Promise.all([
    getTestById(testId).catch(() => null),
    getTestResultById(runId).catch(() => null),
    getCurrentUserPermissions().catch(() => [] as string[]),
    isPermissionsEnforced().catch(() => false),
  ]);

  if (!test || !result || result.test_id !== test.id) {
    notFound();
  }

  const state = parseReportState(result.report_state);

  /**
   * B0-707 — the per-case trace download hits `/api/admin/observability/runs/[runId]/export`, which
   * gates on `navigation.sidebar.observability` through `gateRoute`. Mirroring `gateRoute`'s shadow
   * mode here (rather than hiding unconditionally like the sidebar does) keeps the button and the
   * route in agreement: while `BEX_PERMISSIONS_ENFORCED` is off the route serves everyone, so
   * hiding the button would remove a working feature. The route records the verdict on click.
   */
  const canDownloadTrace =
    !enforced ||
    hasPermission(permissions, PERMISSIONS.NAVIGATION_SIDEBAR_OBSERVABILITY);

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10 sm:px-8">
        <RunReportView
          canDownloadTrace={canDownloadTrace}
          fileBase={`${test.name}-run-${result.id}-report`}
          initialCompletedCases={state?.completedCases ?? 0}
          initialCompletedPasses={state ? completedPassCount(state) : 0}
          initialPasses={state?.passes ?? 1}
          initialError={state?.error ?? null}
          initialGeneratedAt={result.report_generated_at}
          initialStatus={state?.status ?? 'idle'}
          initialTotalCases={state?.totalCases ?? result.total_items}
          isRunCompleted={isCompletedRunStatus(result.status)}
          isGolden={test.is_golden}
          runId={result.id}
          testId={test.id}
          testName={test.name}
        />
      </main>
    </div>
  );
}
