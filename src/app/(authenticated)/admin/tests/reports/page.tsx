import Link from 'next/link';
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
import type { ReportRunRow } from '~/lib/tests/repository';
import { listAllReportRuns } from '~/lib/tests/repository';
import { formatDate } from '~/lib/utils/time';

export const metadata = {
  title: 'Eval Reports | Betco BEX',
  description: 'Every LLM-graded eval report generated across all test datasets.',
};

/**
 * Score cell text. A report that hasn't finished scoring has no score to show, so it shows its
 * state instead of an em-dash that would read as "scored zero" or "never reported". `avg` is
 * rendered exactly as persisted (never re-rounded) so it can't disagree with the stored grade,
 * which was derived from the unrounded value — same as the per-dataset "Recent runs" table.
 */
function describeScore(row: ReportRunRow): string {
  if (row.score !== null) {
    return `${row.score}/100 (${row.grade})`;
  }
  switch (row.reportStatus) {
    case 'scoring':
      return 'Scoring…';
    case 'synthesizing':
      return 'Synthesizing…';
    case 'failed':
      return 'Failed';
    case 'idle':
      return 'Not started';
    default:
      return '—';
  }
}

export default async function AdminTestReportsPage() {
  await connection();

  const reports = await listAllReportRuns();

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
                Every generated eval report
              </h1>
              <p className="mt-4 max-w-4xl text-base leading-7 text-slate-600">
                Each LLM-graded report from every test run, newest first, so
                scores can be compared across datasets without opening one test
                set at a time.
              </p>
            </div>
            <Button asChild variant="outline">
              <Link href="/admin/tests">Back to test runner</Link>
            </Button>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Reports</h2>
            <span className="text-sm text-slate-600">
              {reports.length} report{reports.length === 1 ? '' : 's'}
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Test name</TableHead>
                <TableHead>Date run</TableHead>
                <TableHead title="Overall score/grade from the auto-generated eval report (B0-609)">
                  Score
                </TableHead>
                <TableHead title="Who started the run — recorded from B0-687 onward; earlier runs were never attributed">
                  Run by
                </TableHead>
                <TableHead>Report</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {reports.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={5}>
                    No reports generated yet. Open a completed run and choose
                    &ldquo;Generate report&rdquo;.
                  </TableCell>
                </TableRow>
              ) : (
                reports.map((row) => (
                  <TableRow key={row.runId}>
                    <TableCell className="max-w-[280px] truncate font-medium">
                      <Link
                        className="text-sky-700 underline-offset-2 hover:underline"
                        href={`/admin/tests/${row.testId}`}
                        title={row.testName}
                      >
                        {row.testName}
                      </Link>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-slate-600">
                      {formatDate(row.startedAt)}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap tabular-nums text-slate-700"
                      title={
                        row.reportGeneratedAt
                          ? `Report generated ${formatDate(row.reportGeneratedAt)}`
                          : 'This report has not finished generating'
                      }
                    >
                      {describeScore(row)}
                    </TableCell>
                    <TableCell
                      className="max-w-[220px] truncate text-slate-600"
                      title={row.triggeredBy ?? 'Not recorded for this run'}
                    >
                      {row.triggeredBy ?? '—'}
                    </TableCell>
                    <TableCell>
                      <Button asChild size="sm" variant="outline">
                        <Link
                          href={`/admin/tests/${row.testId}/runs/${row.runId}/report`}
                        >
                          View report
                        </Link>
                      </Button>
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
