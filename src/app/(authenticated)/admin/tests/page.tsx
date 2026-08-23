import Link from 'next/link';
import { connection } from 'next/server';

import { AdminTestsActionToast } from '~/components/admin/tests/AdminTestsActionToast';
import { CreateOrUploadTestDatasetDialog } from '~/components/admin/tests/CreateOrUploadTestDatasetDialog';
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
import { gradeFromScore } from '~/lib/tests/report/metrics';
import { listTests } from '~/lib/tests/repository';

import {
  deleteTestAction,
  runTestAction,
  setTestGoldenAction,
} from './actions';

export const metadata = {
  title: 'Test Runner | Betco BEX',
  description:
    'Upload prompt datasets, run tests, and review performance metrics.',
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminTestsPage({ searchParams }: PageProps) {
  await connection();
  const params = await searchParams;
  const success = typeof params.success === 'string' ? params.success : null;
  const error = typeof params.error === 'string' ? params.error : null;

  // B0-585 — the per-test latest-result and cross-run similarity roll-up that used to fan out
  // over 20 runs per test on every load is decommissioned: run-level figures live on
  // /admin/tests/[testId], golden-set health on /admin/bex/health.
  const tests = await listTests();

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
                Create an empty test set and add prompts manually, or upload a CSV
                to S3 (`retool-360/bex`) and persist rows into `public.tests` and
                `public.test_items`, then run prompt sets and save run metrics in
                `public.test_results`.
              </p>
            </div>
            <div className="shrink-0">
              <CreateOrUploadTestDatasetDialog returnPath="/admin/tests" />
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">
              Uploaded tests
            </h2>
            <span className="text-sm text-slate-600">
              {tests.length} datasets
            </span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Golden</TableHead>
                <TableHead>Intended agent</TableHead>
                <TableHead>Avg Score</TableHead>
                <TableHead>Rows</TableHead>
                <TableHead>Completed runs</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tests.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={8}>
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
                        : `${test.avg_report_score.toFixed(1)}/100 (${gradeFromScore(
                            test.avg_report_score,
                          )})`}
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
                          <Button size="sm" type="submit" variant="outline">
                            Run
                          </Button>
                        </form>
                        <form action={deleteTestAction}>
                          <input
                            name="returnPath"
                            type="hidden"
                            value="/admin/tests"
                          />
                          <input name="testId" type="hidden" value={test.id} />
                          <Button size="sm" type="submit" variant="destructive">
                            Delete
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
