import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { RunReportView } from '~/components/admin/tests/RunReportView';
import { parseReportState } from '~/lib/tests/report/schemas';
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

  const [test, result] = await Promise.all([
    getTestById(testId).catch(() => null),
    getTestResultById(runId).catch(() => null),
  ]);

  if (!test || !result || result.test_id !== test.id) {
    notFound();
  }

  const state = parseReportState(result.report_state);

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-6 py-10 sm:px-8">
        <RunReportView
          fileBase={`${test.name}-run-${result.id}-report`}
          initialCompletedCases={state?.completedCases ?? 0}
          initialError={state?.error ?? null}
          initialGeneratedAt={result.report_generated_at}
          initialStatus={state?.status ?? 'idle'}
          initialTotalCases={state?.totalCases ?? result.total_items}
          isRunCompleted={isCompletedRunStatus(result.status)}
          runId={result.id}
          testId={test.id}
          testName={test.name}
        />
      </main>
    </div>
  );
}
