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
import {
  getTestById,
  getTestItemById,
  listResultItemsByTestItemId,
  listTestResultsByTestId,
} from '~/lib/tests/repository';

export const metadata = {
  title: 'Item History | Betco BEX',
  description: 'View historical item outcomes across all runs.',
};

type PageProps = {
  params: Promise<{ testId: string; itemId: string }>;
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatDurationSeconds(value: number | null | undefined) {
  if (typeof value !== 'number') {
    return 'n/a';
  }
  return `${(value / 1000).toFixed(2)} s`;
}

export default async function AdminTestItemHistoryPage({ params }: PageProps) {
  await connection();
  const { testId, itemId } = await params;

  const [test, item] = await Promise.all([
    getTestById(testId).catch(() => null),
    getTestItemById(itemId).catch(() => null),
  ]);

  if (!test || !item || item.test_id !== test.id) {
    notFound();
  }

  const [runs, itemRunResults] = await Promise.all([
    listTestResultsByTestId(test.id, 200),
    listResultItemsByTestItemId(item.id, 500),
  ]);

  const runById = new Map(runs.map((run) => [run.id, run]));
  const historyRows = itemRunResults
    .map((result) => ({
      result,
      run: runById.get(result.test_result_id) || null,
    }))
    .filter((row): row is { result: (typeof itemRunResults)[number]; run: (typeof runs)[number] } => !!row.run)
    .sort(
      (a, b) =>
        new Date(b.run.started_at).getTime() - new Date(a.run.started_at).getTime(),
    );

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                Item history
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                {test.name}
              </h1>
              <p className="mt-3 text-sm text-slate-600">Row {item.row_index}</p>
            </div>
            <div className="flex items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href={`/admin/tests/${test.id}`}>Back to dataset</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/tests">Back to tests</Link>
              </Button>
            </div>
          </div>
          <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <p className="font-semibold text-slate-900">Prompt</p>
            <p className="mt-1 whitespace-pre-wrap">{item.prompt}</p>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">
            Historical outcomes ({historyRows.length})
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Run id</TableHead>
                <TableHead>Run status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead>Item status</TableHead>
                <TableHead>Passed</TableHead>
                <TableHead>Elapsed</TableHead>
                <TableHead>Message</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {historyRows.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={7}>
                    This item has no completed results yet.
                  </TableCell>
                </TableRow>
              ) : (
                historyRows.map(({ result, run }) => (
                  <TableRow key={result.id}>
                    <TableCell className="font-mono text-xs">
                      <Link
                        className="text-sky-700 underline-offset-2 hover:underline"
                        href={`/admin/tests/${test.id}/runs/${run.id}`}
                      >
                        {run.id}
                      </Link>
                    </TableCell>
                    <TableCell>{run.status}</TableCell>
                    <TableCell>{formatDate(run.started_at)}</TableCell>
                    <TableCell>{result.status}</TableCell>
                    <TableCell>{result.passed ? 'yes' : 'no'}</TableCell>
                    <TableCell>{formatDurationSeconds(result.elapsed_ms)}</TableCell>
                    <TableCell className="max-w-[520px] whitespace-normal text-xs text-slate-600">
                      {result.error_message || result.response_text || 'n/a'}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </section>
      </main>
    </div>
  );
}
