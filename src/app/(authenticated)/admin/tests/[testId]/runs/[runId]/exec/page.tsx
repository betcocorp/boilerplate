import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { DegradedRunBanner } from '~/components/admin/tests/DegradedRunBanner';
import {
  ExecSummaryUnavailable,
  RunExecSummaryView,
} from '~/components/admin/tests/report/RunExecSummaryView';
import { RunReportTabs } from '~/components/admin/tests/report/RunReportTabs';
import { loadReportData } from '~/lib/tests/report/assemble';
import type { ReportDataNotGenerated } from '~/lib/tests/report/data-schemas';
import { toExecSummaryData } from '~/lib/tests/report/exec-summary';
import {
  getTestById,
  getTestResultById,
  listRoutingHealthRowsByResultId,
} from '~/lib/tests/repository';
import { computeRunRoutingHealth } from '~/lib/tests/run-health';
import { isCompletedRunStatus } from '~/lib/tests/types';

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { testId } = await params;
  const test = await getTestById(testId).catch(() => null);

  return {
    title: test ? `${test.name} | Betco Bex` : 'Executive Summary | Betco Bex',
    description:
      'One-page executive summary of the LLM-graded agent-evaluation report for a test run.',
  };
}

type PageProps = {
  params: Promise<{ testId: string; runId: string }>;
};

/** The one sentence each pre-report state gets. Generation itself lives on the detailed report. */
function notGeneratedMessage(payload: ReportDataNotGenerated): string {
  switch (payload.reportStatus) {
    case 'scoring':
    case 'synthesizing':
      return `The report is still being generated (${payload.completedCases} of ${payload.totalCases} cases scored).`;
    case 'failed':
      return `Report generation failed: ${payload.error ?? 'unknown error'}`;
    default:
      return "The report for this run hasn't been generated yet.";
  }
}

export default async function AdminTestRunExecSummaryPage({ params }: PageProps) {
  await connection();
  const { testId, runId } = await params;

  const [test, result, routingHealthRows] = await Promise.all([
    getTestById(testId).catch(() => null),
    getTestResultById(runId).catch(() => null),
    // B0-911 — same narrow two-column read the detailed report does; a failure means "no verdict".
    listRoutingHealthRowsByResultId(runId).catch(() => []),
  ]);

  if (!test || !result || result.test_id !== test.id) {
    notFound();
  }

  const runHref = `/admin/tests/${test.id}/runs/${result.id}`;
  const reportLink = { href: `${runHref}/report`, label: 'Open the detailed report' };

  let body: ReactNode;
  if (!isCompletedRunStatus(result.status)) {
    body = (
      <ExecSummaryUnavailable link={{ href: runHref, label: 'Back to run details' }}>
        This run hasn&apos;t finished yet — the executive summary is available once the report is
        generated.
      </ExecSummaryUnavailable>
    );
  } else {
    const payload = await loadReportData(result.id);
    if (!payload) notFound();

    body =
      payload.status === 'not_generated' ? (
        <ExecSummaryUnavailable link={reportLink}>
          {notGeneratedMessage(payload)}
        </ExecSummaryUnavailable>
      ) : (
        <RunExecSummaryView
          data={toExecSummaryData(payload)}
          fileBase={`${test.name}-run-${result.id}-executive-summary`}
          runId={result.id}
          testId={test.id}
          testName={test.name}
        />
      );
  }

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10 sm:px-8">
        {/* B0-834 — switch between the detailed report and this executive summary. */}
        <RunReportTabs runId={result.id} testId={test.id} />
        {/* B0-911 — above the exec grade, for the same reason it sits above the detailed one. */}
        <DegradedRunBanner health={computeRunRoutingHealth(routingHealthRows)} />
        {body}
      </main>
    </div>
  );
}
