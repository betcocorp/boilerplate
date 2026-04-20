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
import { AdminTestsActionToast } from '~/components/admin/tests/AdminTestsActionToast';
import { listTestResultsByTestId, listTests } from '~/lib/tests/repository';
import { getSignedTestFileUrl } from '~/lib/tests/storage';

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
      const latestResults = await listTestResultsByTestId(test.id, 1);
      const fileUrl =
        test.source_bucket && test.source_key
          ? await getSignedTestFileUrl({
              bucket: test.source_bucket,
              key: test.source_key,
            }).catch(() => null)
          : null;
      return {
        ...test,
        fileUrl,
        latestResult: latestResults[0] || null,
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
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              Test name
              <input
                className="rounded-xl border border-slate-200 px-3 py-2"
                name="name"
                placeholder="Product catalog specialist set"
                type="text"
              />
            </label>
            <label className="flex flex-col gap-2 text-sm text-slate-700">
              CSV file
              <input
                accept=".csv,text/csv"
                className="rounded-xl border border-slate-200 px-3 py-2"
                name="dataset"
                required
                type="file"
              />
            </label>
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
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {testRows.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={6}>
                    No datasets uploaded yet.
                  </TableCell>
                </TableRow>
              ) : (
                testRows.map((test) => (
                  <TableRow key={test.id}>
                    <TableCell className="max-w-[240px] truncate font-medium">
                      {test.fileUrl ? (
                        <a
                          className="text-sky-700 underline-offset-2 hover:underline"
                          href={test.fileUrl}
                          rel="noreferrer"
                          target="_blank"
                          title={test.source_file_name}
                        >
                          {test.name}
                        </a>
                      ) : (
                        <span
                          className="text-slate-500"
                          title="Unable to generate file link"
                        >
                          {test.name}
                        </span>
                      )}
                    </TableCell>
                    <TableCell>{test.row_count}</TableCell>
                    <TableCell>{formatDate(test.uploaded_at)}</TableCell>
                    <TableCell>
                      {test.latestResult
                        ? `${test.latestResult.passed_items}/${test.latestResult.total_items} passed`
                        : 'Never run'}
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
