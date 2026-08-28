import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import Link from 'next/link';
import { connection } from 'next/server';

import {
  ReportDatasetFilter,
  type ReportDatasetOption,
} from '~/components/admin/tests/ReportDatasetFilter';
import { ReportScoreTrendChart } from '~/components/admin/tests/ReportScoreTrendChart';
import { Button } from '~/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import type { ReportScoreChange } from '~/lib/tests/report-trend';
import {
  buildReportScoreTrend,
  formatChangePercent,
  formatChangePoints,
} from '~/lib/tests/report-trend';
import type { ReportRunRow } from '~/lib/tests/repository';
import { listAllReportRuns } from '~/lib/tests/repository';
import { readSearchParam } from '~/lib/utils/params';
import { formatDate } from '~/lib/utils/time';

export const metadata = {
  title: 'Eval Reports | Betco BEX',
  description:
    'Every LLM-graded eval report generated across all test datasets.',
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * B0-690 — one option per dataset that actually HAS report rows, so the picker can never offer a
 * selection that produces an empty page. Rows arrive newest-first, so the first row seen for a
 * dataset is its newest: a dataset renamed between runs reads under its current name.
 */
function buildDatasetOptions(
  rows: readonly ReportRunRow[],
): ReportDatasetOption[] {
  const byTestId = new Map<string, ReportDatasetOption>();
  for (const row of rows) {
    const existing = byTestId.get(row.testId);
    if (existing) {
      existing.reportCount += 1;
    } else {
      byTestId.set(row.testId, {
        testId: row.testId,
        testName: row.testName,
        reportCount: 1,
      });
    }
  }
  return [...byTestId.values()].sort((a, b) =>
    a.testName.localeCompare(b.testName),
  );
}

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

/**
 * Run-over-run change (B0-689). An absent change is an em-dash, never `0%`: a dataset's first
 * scored run has nothing to compare against, which is not the same as "no change".
 */
function ReportChangeCell({
  change,
  row,
}: {
  change: ReportScoreChange | undefined;
  row: ReportRunRow;
}) {
  if (!change) {
    return (
      <span
        className="text-slate-400"
        title={
          row.score === null
            ? 'This run has no score yet, so there is nothing to compare'
            : 'First scored run for this dataset — no earlier score to compare against'
        }
      >
        —
      </span>
    );
  }

  const rising = change.deltaPoints > 0;
  const falling = change.deltaPoints < 0;
  const Icon = rising ? ArrowUp : falling ? ArrowDown : Minus;
  const tone = rising
    ? 'text-emerald-600'
    : falling
      ? 'text-rose-600'
      : 'text-slate-500';

  return (
    <span
      className="flex flex-col items-start"
      title={`Previous scored run: ${change.previousScore}/100`}
    >
      <span
        className={`inline-flex items-center gap-1 font-medium tabular-nums ${tone}`}
      >
        <Icon aria-hidden className="size-3.5" />
        {formatChangePercent(change)}
      </span>
      <span className="text-xs tabular-nums text-slate-500">
        {formatChangePoints(change)}
      </span>
    </span>
  );
}

export default async function AdminTestReportsPage({ searchParams }: PageProps) {
  await connection();
  const params = await searchParams;

  const allReports = await listAllReportRuns();
  const datasetOptions = buildDatasetOptions(allReports);

  // An unknown, malformed, or array-valued `testId` degrades to "all datasets" rather than
  // erroring or rendering an empty page.
  const testIdParam = readSearchParam(params.testId).trim();
  const selectedTestId = datasetOptions.some(
    (option) => option.testId === testIdParam,
  )
    ? testIdParam
    : '';
  const selectedDataset = datasetOptions.find(
    (option) => option.testId === selectedTestId,
  );

  const reports = selectedTestId
    ? allReports.filter((row) => row.testId === selectedTestId)
    : allReports;
  // Chart and table are always fed the same filtered rows. Narrowing to one dataset cannot change
  // any run-over-run number: `buildReportScoreTrend` only ever compares runs within a dataset.
  const trend = buildReportScoreTrend(reports);

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
                Each LLM-graded report from every run of an active test set,
                newest first, so scores can be compared across datasets without
                opening one test set at a time, charted over time with each
                run&rsquo;s change from that dataset&rsquo;s previous scored
                run. Archiving a dataset removes its reports from this list.
              </p>
            </div>
            <Button asChild variant="outline">
              <Link href="/admin/tests">Back to test runner</Link>
            </Button>
          </div>
        </section>

        <ReportScoreTrendChart trend={trend} />

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900">Reports</h2>
            <div className="flex flex-wrap items-center gap-4">
              <ReportDatasetFilter
                options={datasetOptions}
                selectedTestId={selectedTestId}
              />
              <span className="text-sm text-slate-600">
                {/* Filtered shows both numbers, so the narrowing is never mistaken for a shrinking history. */}
                {selectedTestId
                  ? `${reports.length} of ${allReports.length} reports`
                  : `${reports.length} report${reports.length === 1 ? '' : 's'}`}
              </span>
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead></TableHead>
                <TableHead>Test name</TableHead>
                <TableHead>Date run</TableHead>
                <TableHead title="Overall score/grade from the auto-generated eval report (B0-609)">
                  Score
                </TableHead>
                <TableHead title="Change from this dataset's previous scored run (B0-689)">
                  Change
                </TableHead>
                <TableHead title="LLM model used in this run (B0-733)">
                  Model
                </TableHead>
                <TableHead title="Routing method used in this run (B0-733)">
                  Router
                </TableHead>
                <TableHead title="App version at run time (B0-733)">
                  Version
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
                  <TableCell className="text-slate-500" colSpan={10}>
                    {selectedTestId
                      ? `No reports for ${selectedDataset?.testName ?? 'this dataset'}. Choose "All datasets" to see every report.`
                      : 'No reports generated yet. Open a completed run and choose “Generate report”.'}
                  </TableCell>
                </TableRow>
              ) : (
                reports.map((row, index) => (
                  <TableRow key={row.runId}>
                    <TableCell className="whitespace-nowrap text-slate-600">
                      {index + 1}
                    </TableCell>
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
                    <TableCell className="whitespace-nowrap">
                      <ReportChangeCell
                        change={trend.changeByRunId.get(row.runId)}
                        row={row}
                      />
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap text-slate-600"
                      title={row.modelTag ?? 'Not recorded for this run'}
                    >
                      {row.modelTag ?? '—'}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap text-slate-600"
                      title={row.routerType ?? 'Settings-driven'}
                    >
                      {row.routerType ? (
                        <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-700">
                          {row.routerType}
                        </span>
                      ) : (
                        <span className="text-slate-500">Settings-driven</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap text-slate-600"
                      title={row.appVersion ?? 'Not recorded for this run'}
                    >
                      {row.appVersion ?? '—'}
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
