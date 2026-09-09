import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import type { Metadata } from 'next';

import { RunReportTabs } from '~/components/admin/tests/report/RunReportTabs';
import { RunReportView } from '~/components/admin/tests/RunReportView';
import { certainGenerationRuntimeForModel } from '~/lib/llm/generation-runtime';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { isPermissionsEnforced } from '~/lib/permissions/enforcement';
import {
  getCurrentUserPermissions,
  hasPermission,
} from '~/lib/permissions/permissions-server';
import { completedPassCount, parseReportState } from '~/lib/tests/report/schemas';
import {
  getTestById,
  getTestResultById,
  listRoutingHealthRowsByResultId,
} from '~/lib/tests/repository';
import {
  extractGenerationRuntimeFromSummary,
  extractResolvedModelFromSummary,
  extractResolvedProviderFromSummary,
} from '~/lib/tests/response-payload';
import { computeRunRoutingHealth } from '~/lib/tests/run-health';
import { isCompletedRunStatus } from '~/lib/tests/types';

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { testId } = await params;
  const test = await getTestById(testId).catch(() => null);

  return {
    title: test ? `${test.name} | Betco Bex` : 'Run Report | Betco Bex',
    description: 'LLM-graded agent-evaluation report for a test run.',
  };
}

type PageProps = {
  params: Promise<{ testId: string; runId: string }>;
};

export default async function AdminTestRunReportPage({ params }: PageProps) {
  await connection();
  const { testId, runId } = await params;

  const [test, result, permissions, enforced, routingHealthRows] = await Promise.all([
    getTestById(testId).catch(() => null),
    getTestResultById(runId).catch(() => null),
    getCurrentUserPermissions().catch(() => [] as string[]),
    isPermissionsEnforced().catch(() => false),
    // B0-911 — two scalars per item, not the full rows: this page otherwise loads no items at all.
    // A read failure must not take the report down, so it degrades to "no verdict" (no banner).
    listRoutingHealthRowsByResultId(runId).catch(() => []),
  ]);

  if (!test || !result || result.test_id !== test.id) {
    notFound();
  }

  const state = parseReportState(result.report_state);

  /**
   * B0-912 — the persisted run-level runtime, falling back for pre-B0-912 runs to what the model id
   * settles on its own (`claude-*` can only have been the AI SDK loop). An OpenAI run predating the
   * field stays null and the row is omitted — its loop depended on a settings value from the time.
   */
  const answeringModel = extractResolvedModelFromSummary(result.summary);
  const answeringRuntime =
    extractGenerationRuntimeFromSummary(result.summary) ??
    (answeringModel ? certainGenerationRuntimeForModel(answeringModel) : null);

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
        {/* B0-834 — switch between this detailed report and the executive summary. */}
        <RunReportTabs runId={result.id} testId={test.id} />
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
          // B0-905 — the model that ANSWERED this run, so the methodology block can name both
          // sides: answered by X, graded by Y. Null on a run predating summary.resolvedModel; the
          // block then omits the answering line rather than guessing.
          answeringModel={answeringModel}
          answeringProvider={extractResolvedProviderFromSummary(result.summary)}
          // B0-912 — which generation loop produced these answers, named beside the model that
          // produced them: the 2026-09-08 vendor comparison silently compared two different loops.
          answeringRuntime={answeringRuntime}
          // B0-911 — the degraded-pipeline banner renders ABOVE the grade inside this view.
          routingHealth={computeRunRoutingHealth(routingHealthRows)}
          runId={result.id}
          testId={test.id}
          testName={test.name}
        />
      </main>
    </div>
  );
}
