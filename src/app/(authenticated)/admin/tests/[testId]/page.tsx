import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { Button } from '~/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { AdminTestsActionToast } from '~/components/admin/tests/AdminTestsActionToast';
import { TestHistoricalTrendsCharts } from '~/components/admin/tests/TestHistoricalTrendsCharts';
import {
  getTestById,
  getTestItemsByTestId,
  listTestResultsByTestId,
} from '~/lib/tests/repository';

import { deleteTestRunAction, runTestAction } from '../actions';

export const metadata = {
  title: 'Test Details | Betco BEX',
  description: 'Review test rows and historical run performance.',
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatShortDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
  }).format(new Date(value));
}

function formatDurationSeconds(value: number | null | undefined) {
  if (typeof value !== 'number') {
    return 'n/a';
  }
  return `${(value / 1000).toFixed(2)} s`;
}

type PageProps = {
  params: Promise<{ testId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminTestDetailsPage({ params, searchParams }: PageProps) {
  await connection();
  const { testId } = await params;
  const query = await searchParams;
  const success = typeof query.success === 'string' ? query.success : null;
  const error = typeof query.error === 'string' ? query.error : null;

  let test;
  try {
    test = await getTestById(testId);
  } catch {
    notFound();
  }

  const [items, results] = await Promise.all([
    getTestItemsByTestId(testId),
    listTestResultsByTestId(testId, 20),
  ]);
  const trendRuns = [...results].reverse();
  const trendData = trendRuns.map((run) => ({
    elapsedSeconds:
      typeof run.elapsed_ms === 'number'
        ? Number((run.elapsed_ms / 1000).toFixed(2))
        : 0,
    passRate: run.total_items > 0 ? (run.passed_items / run.total_items) * 100 : 0,
    startedAtLabel: formatShortDate(run.started_at),
    status: run.status || 'unknown',
  }));

  return (
    <div className="flex flex-1 bg-slate-50">
      <AdminTestsActionToast error={error} success={success} />
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                Test dataset details
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                {test.name}
              </h1>
              <p className="mt-3 text-sm text-slate-600">
                File: {test.source_file_name} ({test.row_count} prompts)
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/tests">Back to tests</Link>
              </Button>
              <form action={runTestAction}>
                <input name="returnPath" type="hidden" value={`/admin/tests/${test.id}`} />
                <input name="testId" type="hidden" value={test.id} />
                <Button size="sm" type="submit">
                  Run dataset
                </Button>
              </form>
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Recent runs</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run id</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Pass/fail</TableHead>
                <TableHead>Elapsed</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {results.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={6}>
                    No runs yet for this dataset.
                  </TableCell>
                </TableRow>
              ) : (
                results.map((result) => (
                  <TableRow key={result.id}>
                    <TableCell className="font-mono text-xs">
                      <Link
                        className="text-sky-700 underline-offset-2 hover:underline"
                        href={`/admin/tests/${test.id}/runs/${result.id}`}
                      >
                        {result.id}
                      </Link>
                    </TableCell>
                    <TableCell>{result.status}</TableCell>
                    <TableCell>
                      {result.passed_items}/{result.total_items} passed
                    </TableCell>
                    <TableCell>
                      {formatDurationSeconds(result.elapsed_ms)}
                    </TableCell>
                    <TableCell>{formatDate(result.started_at)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/admin/tests/${test.id}/runs/${result.id}`}>
                            View run
                          </Link>
                        </Button>
                        <form action={deleteTestRunAction}>
                          <input
                            name="returnPath"
                            type="hidden"
                            value={`/admin/tests/${test.id}`}
                          />
                          <input name="testId" type="hidden" value={test.id} />
                          <input name="runId" type="hidden" value={result.id} />
                          <Button size="sm" type="submit" variant="destructive">
                            Delete run
                          </Button>
                        </form>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </section>

        <TestHistoricalTrendsCharts runs={trendData} />

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">
            Test prompts ({items.length})
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Row</TableHead>
                <TableHead>Prompt</TableHead>
                <TableHead>Expected</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.slice(0, 100).map((item) => (
                <TableRow key={item.id}>
                  <TableCell>{item.row_index}</TableCell>
                  <TableCell className="max-w-[480px] whitespace-normal">
                    {item.prompt}
                  </TableCell>
                  <TableCell>
                    {item.expected_should_answer === null
                      ? 'n/a'
                      : item.expected_should_answer
                        ? 'should answer'
                        : 'should decline'}
                    {item.expected_result_type
                      ? ` (${item.expected_result_type})`
                      : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {items.length > 100 ? (
            <p className="mt-3 text-xs text-slate-500">
              Showing first 100 prompts for performance.
            </p>
          ) : null}
        </section>

      </main>
    </div>
  );
}
