import Link from 'next/link';
import { connection } from 'next/server';

import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { AdminTestsActionToast } from '~/components/admin/tests/AdminTestsActionToast';
import {
  listResultItemsByResultId,
  listTestResultsByTestId,
  listTests,
} from '~/lib/tests/repository';

import { deleteTestAction, runTestAction, uploadTestCsvAction } from './actions';

export const metadata = {
  title: 'Test Runner | Betco BEX',
  description: 'Upload prompt datasets, run tests, and review performance metrics.',
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function extractItemSimilarityScore(responsePayload: unknown) {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const payload = responsePayload as Record<string, unknown>;
  const sources = payload.sources;
  if (!Array.isArray(sources)) {
    return null;
  }

  const similarities = sources
    .map((source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return null;
      }
      const value = (source as Record<string, unknown>).similarity;
      return typeof value === 'number' ? value : null;
    })
    .filter((value): value is number => typeof value === 'number');

  if (similarities.length === 0) {
    return null;
  }

  return Math.max(...similarities);
}

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminTestsPage({ searchParams }: PageProps) {
  await connection();
  const params = await searchParams;
  const success = typeof params.success === 'string' ? params.success : null;
  const error = typeof params.error === 'string' ? params.error : null;

  const tests = await listTests();
  const testRows = await Promise.all(
    tests.map(async (test) => {
      const [latestResults, runsForSimilarity] = await Promise.all([
        listTestResultsByTestId(test.id, 1),
        listTestResultsByTestId(test.id, 20),
      ]);

      const runItems = await Promise.all(
        runsForSimilarity.map((run) => listResultItemsByResultId(run.id, 200)),
      );
      const similarityScores = runItems
        .flat()
        .map((item) => extractItemSimilarityScore(item.response_payload))
        .filter((value): value is number => typeof value === 'number');
      const similarityStats =
        similarityScores.length > 0
          ? {
              min: Math.min(...similarityScores),
              max: Math.max(...similarityScores),
              avg:
                similarityScores.reduce((sum, score) => sum + score, 0) /
                similarityScores.length,
            }
          : null;

      return {
        ...test,
        latestResult: latestResults[0] || null,
        similarityStats,
      };
    }),
  );

  return (
    <div className="flex flex-1 bg-slate-50">
      <AdminTestsActionToast error={error} success={success} />
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Quality test runner
          </p>
          <h1 className="mt-2 text-4xl font-semibold tracking-tight text-slate-950">
            Upload prompt datasets and run evaluation sets
          </h1>
          <p className="mt-4 max-w-4xl text-base leading-7 text-slate-600">
            Upload CSV test sets to S3 (`retool-360/bex`), persist rows into
            `public.tests` and `public.test_items`, then run prompt sets and save
            run metrics in `public.test_results`.
          </p>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Upload CSV dataset</h2>
          <form action={uploadTestCsvAction} className="mt-4 grid gap-4 sm:grid-cols-2">
            <input name="returnPath" type="hidden" value="/admin/tests" />
            <div className="flex flex-col gap-2">
              <Label className="text-sm text-slate-700" htmlFor="test-name-input">
                Test name
              </Label>
              <Input
                id="test-name-input"
                name="name"
                placeholder="Product catalog specialist set"
                type="text"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label className="text-sm text-slate-700" htmlFor="test-dataset-input">
                CSV file
              </Label>
              <Input
                accept=".csv,text/csv"
                id="test-dataset-input"
                name="dataset"
                required
                type="file"
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit">Upload dataset</Button>
            </div>
          </form>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Uploaded tests</h2>
            <span className="text-sm text-slate-600">{testRows.length} datasets</span>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Rows</TableHead>
                <TableHead>Uploaded</TableHead>
                <TableHead>Latest run</TableHead>
                <TableHead>Low/High/Avg</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {testRows.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={7}>
                    No datasets uploaded yet.
                  </TableCell>
                </TableRow>
              ) : (
                testRows.map((test) => (
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
                    <TableCell>{test.row_count}</TableCell>
                    <TableCell>{formatDate(test.uploaded_at)}</TableCell>
                    <TableCell>
                      {test.latestResult
                        ? `${test.latestResult.passed_items}/${test.latestResult.total_items} passed`
                        : 'Never run'}
                    </TableCell>
                    <TableCell>
                      {test.similarityStats
                        ? `${(test.similarityStats.min * 100).toFixed(1)}%/${(test.similarityStats.max * 100).toFixed(1)}%/${(test.similarityStats.avg * 100).toFixed(1)}%`
                        : 'n/a'}
                    </TableCell>
                    <TableCell>{test.status}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        <Button asChild size="sm" variant="outline">
                          <Link href={`/admin/tests/${test.id}`}>View</Link>
                        </Button>
                        <form action={runTestAction}>
                          <input name="returnPath" type="hidden" value="/admin/tests" />
                          <input name="testId" type="hidden" value={test.id} />
                          <Button size="sm" type="submit" variant="outline">
                            Run
                          </Button>
                        </form>
                        <form action={deleteTestAction}>
                          <input name="returnPath" type="hidden" value="/admin/tests" />
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
