import Link from 'next/link';
import { connection } from 'next/server';

import { AdminTestsActionToast } from '~/components/admin/tests/AdminTestsActionToast';
import { TestIntendedAgentCombobox } from '~/components/admin/tests/TestIntendedAgentCombobox';
import { TestTemplateDownload } from '~/components/admin/tests/TestTemplateDownload';
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
import { V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import { getGoldenSetMembership } from '~/lib/tests/golden-set';
import { listTests } from '~/lib/tests/repository';
import { TEST_TEMPLATE_COLUMNS } from '~/lib/tests/template';
import { getTierTargets } from '~/lib/tests/tier-targets';

import {
  deleteTestAction,
  runTestAction,
  setTestGoldenAction,
  updateTierTargetAction,
  uploadTestCsvAction,
} from './actions';

export const metadata = {
  title: 'Test Runner | Betco BEX',
  description:
    'Upload prompt datasets, run tests, and review performance metrics.',
};

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const intendedAgentFormOptions = V1_AGENT_REGISTRY.map((agent) => ({
  id: agent.id,
  label: agent.label,
  description: agent.description,
}));

export default async function AdminTestsPage({ searchParams }: PageProps) {
  await connection();
  const params = await searchParams;
  const success = typeof params.success === 'string' ? params.success : null;
  const error = typeof params.error === 'string' ? params.error : null;

  // B0-585 — the per-test latest-result and cross-run similarity roll-up that used to fan out
  // over 20 runs per test on every load is decommissioned: run-level figures live on
  // /admin/tests/[testId], golden-set health on /admin/bex/health.
  const [tests, tierTargets, goldenMembership] = await Promise.all([
    listTests(),
    getTierTargets(),
    getGoldenSetMembership(),
  ]);

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
            Create an empty test set and add prompts manually, or upload a CSV
            to S3 (`retool-360/bex`) and persist rows into `public.tests` and
            `public.test_items`, then run prompt sets and save run metrics in
            `public.test_results`.
          </p>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">
            Create or upload test dataset
          </h2>
          <p className="mt-2 text-sm text-slate-600">
            CSV is optional. Without a file, a ready test set is created with no
            rows (source{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
              ad-hoc
            </code>
            ); add prompts from the detail page. With a CSV, rows are imported
            as before.
          </p>
          <form
            action={uploadTestCsvAction}
            className="mt-4 grid gap-4 sm:grid-cols-2"
          >
            <input name="returnPath" type="hidden" value="/admin/tests" />
            <div className="flex flex-col gap-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="test-name-input"
              >
                Test name
              </Label>
              <Input
                id="test-name-input"
                name="name"
                placeholder="Product catalog specialist set"
                type="text"
              />
              <p className="text-xs text-slate-500">
                Required when creating without a CSV; optional when uploading
                (defaults to the file name).
              </p>
            </div>
            <TestIntendedAgentCombobox
              agents={intendedAgentFormOptions}
              id="test-intended-agent"
              label="Intended agent"
            />
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label
                className="text-sm text-slate-700"
                htmlFor="test-dataset-input"
              >
                CSV file{' '}
                <span className="font-normal text-slate-500">(optional)</span>
              </Label>
              <Input
                accept=".csv,text/csv"
                id="test-dataset-input"
                name="dataset"
                type="file"
              />
            </div>
            <div className="sm:col-span-2">
              <Button type="submit">Create / upload dataset</Button>
            </div>
          </form>

          <div className="mt-6 border-t border-slate-200 pt-6">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-sm font-semibold text-slate-900">
                  Not sure about the format? Start from the template
                </h3>
                <p className="mt-1 max-w-3xl text-sm text-slate-600">
                  Download the CSV template, replace the single example row with your own
                  prompts (one per row), and upload it above. Only{' '}
                  <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">question</code>{' '}
                  is required — every other column is optional and can be left blank. Keep the
                  header row; the example row is just guidance and should be replaced.
                </p>
              </div>
              <TestTemplateDownload />
            </div>

            <details className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <summary className="cursor-pointer text-sm font-medium text-slate-800">
                Column reference
              </summary>
              <div className="mt-3 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Column</TableHead>
                      <TableHead>Required</TableHead>
                      <TableHead>What it&rsquo;s for</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {TEST_TEMPLATE_COLUMNS.map((column) => (
                      <TableRow key={column.name}>
                        <TableCell className="whitespace-nowrap font-mono text-xs text-slate-700">
                          {column.name}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-slate-600">
                          {column.required ? 'Required' : 'Optional'}
                        </TableCell>
                        <TableCell className="text-sm text-slate-600">
                          {column.help}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </details>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">
            Golden set &amp; tier targets
          </h2>
          <p className="mt-2 text-sm text-slate-600">
            Golden sets ({goldenMembership.goldenTests.length}) gate releases; every prompt
            in a golden set must carry a priority (tier 1&ndash;3). Targets are stored in{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">tier_targets</code>{' '}
            and take effect without a deploy; changes are audited.
          </p>

          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            {tierTargets.map((target) => (
              <form
                action={updateTierTargetAction}
                className="flex flex-col gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-4"
                key={target.tier}
              >
                <input name="returnPath" type="hidden" value="/admin/tests" />
                <input name="tier" type="hidden" value={target.tier} />
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-slate-900">
                    Tier {target.tier}
                  </span>
                  {target.isGate ? (
                    <span className="rounded-full bg-rose-100 px-2 py-0.5 text-xs font-medium text-rose-700">
                      Hard gate
                    </span>
                  ) : (
                    <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-600">
                      Target only
                    </span>
                  )}
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-slate-600" htmlFor={`tier-label-${target.tier}`}>
                    Label
                  </Label>
                  <Input
                    defaultValue={target.label}
                    id={`tier-label-${target.tier}`}
                    name="label"
                    type="text"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label
                    className="text-xs text-slate-600"
                    htmlFor={`tier-target-${target.tier}`}
                  >
                    Target pass rate (0&ndash;1)
                  </Label>
                  <Input
                    defaultValue={target.targetPassRate}
                    id={`tier-target-${target.tier}`}
                    max="1"
                    min="0"
                    name="targetPassRate"
                    step="0.01"
                    type="number"
                  />
                </div>
                <label className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    className="h-4 w-4 rounded border-slate-300"
                    defaultChecked={target.isGate}
                    name="isGate"
                    type="checkbox"
                  />
                  Hard gate (can block)
                </label>
                <Button size="sm" type="submit" variant="outline">
                  Save tier {target.tier}
                </Button>
              </form>
            ))}
          </div>

          {goldenMembership.missingPriority.length > 0 ? (
            <div className="mt-4 rounded-2xl border border-amber-300 bg-amber-50 p-4">
              <h3 className="text-sm font-semibold text-amber-900">
                Data errors: {goldenMembership.missingPriority.length} golden-set prompt
                {goldenMembership.missingPriority.length === 1 ? '' : 's'} missing a priority
              </h3>
              <p className="mt-1 text-xs text-amber-800">
                These prompts are in a golden set but carry no tier, so they are excluded
                from tier figures until fixed &mdash; they are never silently dropped.
              </p>
              <ul className="mt-2 space-y-1">
                {goldenMembership.missingPriority.slice(0, 20).map((item) => (
                  <li className="truncate text-xs text-amber-900" key={item.testItemId}>
                    <Link
                      className="font-medium underline-offset-2 hover:underline"
                      href={`/admin/tests/${item.testId}`}
                    >
                      {item.testName}
                    </Link>{' '}
                    &mdash; row {item.rowIndex}: {item.prompt}
                  </li>
                ))}
                {goldenMembership.missingPriority.length > 20 ? (
                  <li className="text-xs text-amber-800">
                    &hellip;and {goldenMembership.missingPriority.length - 20} more.
                  </li>
                ) : null}
              </ul>
            </div>
          ) : null}
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
                <TableHead>Rows</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tests.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={6}>
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
                    <TableCell>{test.row_count}</TableCell>
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
