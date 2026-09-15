import { TrendingDown, TrendingUp } from 'lucide-react';
import Link from 'next/link';
import { connection } from 'next/server';

import { AdminTestsActionToast } from '~/components/admin/tests/AdminTestsActionToast';
import { CreateOrUploadTestDatasetDialog } from '~/components/admin/tests/CreateOrUploadTestDatasetDialog';
import { GoldenSetMetricsCards } from '~/components/admin/tests/GoldenSetMetricsCards';
import { OnlyGoldenToggle } from '~/components/admin/tests/OnlyGoldenToggle';
import { ReportFailTrendChart } from '~/components/admin/tests/ReportFailTrendChart';
import { RunGoldenTestsDialog } from '~/components/admin/tests/RunGoldenTestsDialog';
import { Button } from '~/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import { formatScoreDelta } from '~/lib/tests/format';
import { calculateGoldenSetMetrics } from '~/lib/tests/golden-set-metrics';
import { buildReportFailTrend } from '~/lib/tests/report-fail-trend';
import { gradeFromScore } from '~/lib/tests/report/metrics';
import { listArchivedTests, listTests } from '~/lib/tests/repository';
import { listTestSetFailTrendRuns } from '~/lib/tests/test-set-fail-trend';

import { Separator } from '~/components/ui/separator';
import {
  archiveTestAction,
  runTestAction,
  setTestGoldenAction,
} from './actions';

// B0-883 — `runGoldenTestsAction` is invoked from this segment and executes the fan-out in
// `after()`, which runs within the segment's max duration; match `api/admin/tests/runs/[runId]`.
export const maxDuration = 300;

export const metadata = {
  title: 'Test Runner | Betco BEX',
  description:
    'Upload prompt datasets, run tests, and review performance metrics.',
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminTestsPage({ searchParams }: PageProps) {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_TESTS,
    'GET /admin/tests',
  );
  await connection();
  const params = await searchParams;
  const success = typeof params.success === 'string' ? params.success : null;
  const error = typeof params.error === 'string' ? params.error : null;
  // Absent, or anything other than the literal "false", reads as ON — the toggle defaults true.
  const onlyGolden = params.onlyGolden !== 'false';

  // B0-585 — the per-test latest-result and cross-run similarity roll-up that used to fan out
  // over 20 runs per test on every load is decommissioned: run-level figures live on
  // /admin/tests/[testId], golden-set health on /admin/bex/health.
  const [allTests, archivedTests, goldenSetMetrics, failTrendRuns] = await Promise.all([
    listTests(),
    listArchivedTests(),
    calculateGoldenSetMetrics(),
    // B0-1015 — takes the same `onlyGolden` reading as the table, so the chart's series and the
    // rows beneath it are always the same set of datasets.
    listTestSetFailTrendRuns({ onlyGolden }),
  ]);
  const tests = onlyGolden
    ? allTests.filter((test) => test.is_golden)
    : allTests;
  const failTrend = buildReportFailTrend(failTrendRuns);

  return (
    <div className="flex flex-1 bg-slate-50">
      <AdminTestsActionToast error={error} success={success} />
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
            <div className="flex-1">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                Quality test runner
              </p>
              <h1 className="mt-2 text-4xl font-semibold tracking-tight text-slate-950">
                Upload prompt datasets and run evaluation sets
              </h1>
              <p className="mt-4 max-w-4xl text-base leading-7 text-slate-600">
                Create an empty test set and add prompts manually, or upload a
                CSV to S3 (`retool-360/bex`) and persist rows into
                `public.tests` and `public.test_items`, then run prompt sets and
                save run metrics in `public.test_results`.
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button asChild variant="outline">
                <Link href="/admin/tests/reports">View reports</Link>
              </Button>
              <RunGoldenTestsDialog returnPath="/admin/tests" />
              <CreateOrUploadTestDatasetDialog returnPath="/admin/tests" />
            </div>
          </div>
        </section>

        <GoldenSetMetricsCards metrics={goldenSetMetrics} />

        {/* B0-1015 — the "Fails" column shows only each dataset's latest run, which cannot
            distinguish a real regression from one bad sweep (an OpenAI billing outage spiked every
            golden set on 2026-09-14). This plots the same number over every completed-report run. */}
        <ReportFailTrendChart
          emptyMessage="No completed run has recorded a fail count yet, so there is nothing to plot."
          title="Fails over time by test set"
          trend={failTrend}
        />

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <div className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-slate-900">
                Test sets
              </h2>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-slate-600">
                {tests.length} test sets
              </span>
              {archivedTests.length > 0 && (
                <Link
                  href="/admin/tests/archived"
                  className="text-sm text-sky-700 underline-offset-2 hover:underline"
                >
                  Archived ({archivedTests.length})
                </Link>
              )}
              <Separator orientation="vertical" />
              <OnlyGoldenToggle onlyGolden={onlyGolden} />
            </div>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Golden</TableHead>
                <TableHead>Intended agent</TableHead>
                <TableHead title="Generation model used for the latest completed report run">
                  Model
                </TableHead>
                <TableHead>Last Run</TableHead>
                <TableHead>Avg</TableHead>
                <TableHead>Fails</TableHead>
                <TableHead>Rows</TableHead>
                <TableHead>Runs</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tests.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={11}>
                    No datasets uploaded yet.
                  </TableCell>
                </TableRow>
              ) : (
                tests.map((test) => (
                  <TableRow key={test.id}>
                    <TableCell className="max-w-[240px] truncate font-medium">
                      <Link
                        className="text-sky-700 underline-offset-2 hover:underline"
                        href={`/admin/tests/${test.id}`}
                        title={test.name}
                      >
                        {test.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <form action={setTestGoldenAction}>
                        <input
                          name="returnPath"
                          type="hidden"
                          value="/admin/tests"
                        />
                        <input name="testId" type="hidden" value={test.id} />
                        <input
                          name="isGolden"
                          type="hidden"
                          value={test.is_golden ? 'false' : 'true'}
                        />
                        <button
                          className={
                            test.is_golden
                              ? 'rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800 ring-1 ring-amber-300 hover:bg-amber-200'
                              : 'rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-500 ring-1 ring-slate-200 hover:bg-slate-200'
                          }
                          title={
                            test.is_golden
                              ? 'In the gating golden set — click to remove (audited)'
                              : 'Not in the golden set — click to add (audited)'
                          }
                          type="submit"
                        >
                          {test.is_golden ? 'Golden' : 'Mark golden'}
                        </button>
                      </form>
                    </TableCell>
                    <TableCell className="max-w-[200px] text-sm text-slate-600">
                      {test.intended_agent
                        ? (V1_AGENT_REGISTRY.find(
                            (a) => a.id === test.intended_agent,
                          )?.label ?? test.intended_agent)
                        : '—'}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap text-sm text-slate-600"
                      title={
                        test.latest_run_model_tag ?? 'Not recorded for the latest run'
                      }
                    >
                      {test.latest_run_model_tag ?? '—'}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap tabular-nums text-slate-700"
                      title={
                        test.latest_run_score === null
                          ? 'No run has a completed report score yet'
                          : test.latest_run_score_delta === null
                            ? 'Latest run score'
                            : 'Latest run score vs. the previous scored run'
                      }
                    >
                      {test.latest_run_score === null ? (
                        '—'
                      ) : (
                        <span className="inline-flex items-center gap-1.5">
                          {`${test.latest_run_score.toFixed(1)} (${gradeFromScore(
                            test.latest_run_score,
                          )})`}
                          {test.latest_run_score_delta !== null &&
                            (() => {
                              const delta = test.latest_run_score_delta;
                              const isUp = delta > 0;
                              const isFlat = delta === 0;
                              const Icon = isUp ? TrendingUp : TrendingDown;
                              const colorClass = isFlat
                                ? 'text-slate-500'
                                : isUp
                                  ? 'text-emerald-600'
                                  : 'text-red-600';
                              const sign =
                                delta > 0 ? '+' : delta < 0 ? '−' : '';
                              return (
                                <span
                                  className={`inline-flex items-center gap-0.5 text-xs font-medium ${colorClass}`}
                                >
                                  {sign}
                                  {formatScoreDelta(Math.abs(delta))}
                                  {!isFlat && (
                                    <Icon aria-hidden className="h-3.5 w-3.5" />
                                  )}
                                </span>
                              );
                            })()}
                        </span>
                      )}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap tabular-nums text-slate-700"
                      title={
                        test.avg_report_score === null
                          ? 'No run has a completed report score yet'
                          : `Average of ${test.scored_runs_count} scored run${
                              test.scored_runs_count === 1 ? '' : 's'
                            }`
                      }
                    >
                      {test.avg_report_score === null
                        ? '—'
                        : `${test.avg_report_score.toFixed(1)}`}
                    </TableCell>
                    <TableCell
                      className="whitespace-nowrap tabular-nums text-slate-700"
                      title={
                        test.latest_run_failed_items === null
                          ? 'No completed run to count failing prompts from'
                          : 'Failing prompts in the latest run'
                      }
                    >
                      {test.latest_run_failed_items === null
                        ? '—'
                        : test.latest_run_failed_items}
                    </TableCell>
                    <TableCell>{test.row_count}</TableCell>
                    <TableCell>{test.completed_runs_count}</TableCell>
                    <TableCell>{test.status}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/admin/tests/${test.id}`}>View</Link>
                        </Button>
                        <form action={runTestAction}>
                          <input
                            name="returnPath"
                            type="hidden"
                            value="/admin/tests"
                          />
                          <input name="testId" type="hidden" value={test.id} />
                        </form>
                        <form action={archiveTestAction}>
                          <input
                            name="returnPath"
                            type="hidden"
                            value="/admin/tests"
                          />
                          <input name="testId" type="hidden" value={test.id} />
                          <input
                            name="isArchiving"
                            type="hidden"
                            value="true"
                          />
                          <Button size="sm" type="submit" variant="outline">
                            Archive
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
      </main>
    </div>
  );
}
