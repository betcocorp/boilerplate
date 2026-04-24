import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { AddTestItemDialog } from '~/components/admin/tests/AddTestItemDialog';
import { AdminTestsActionToast } from '~/components/admin/tests/AdminTestsActionToast';
import { TestPromptsSection } from '~/components/admin/tests/TestPromptsSection';
import { Button } from '~/components/ui/button';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { V1_AGENT_REGISTRY } from '~/lib/agents/agent-registry';
import {
  getTestById,
  listResultItemsByResultId,
  getTestItemSuggestionRows,
  getTestItemsByTestId,
  listTestResultsByTestId,
} from '~/lib/tests/repository';
import { buildSuggestionListsFromTestItems } from '~/lib/tests/suggestion-lists';

import { TestHistoricalTrendsCharts } from '~/components/admin/tests/TestHistoricalTrendsCharts';
import {
  formatDate,
  formatDurationSeconds,
  formatShortDate,
} from '~/lib/utils/time';

import { deleteTestRunAction, runTestAction } from '../actions';

export const metadata = {
  title: 'Test Details | Betco BEX',
  description: 'Review test rows and historical run performance.',
};

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
  params: Promise<{ testId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminTestDetailsPage({
  params,
  searchParams,
}: PageProps) {
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

  const [items, results, suggestionRows] = await Promise.all([
    getTestItemsByTestId(testId),
    listTestResultsByTestId(testId, 20),
    getTestItemSuggestionRows(testId),
  ]);
  const trendRuns = [...results].reverse();
  const trendRunItems = await Promise.all(
    trendRuns.map((run) => listResultItemsByResultId(run.id, 200)),
  );
  const trendData = trendRuns.map((run) => ({
    avgSimilarity: null as number | null,
    elapsedSeconds:
      typeof run.elapsed_ms === 'number'
        ? Number((run.elapsed_ms / 1000).toFixed(2))
        : 0,
    passRate:
      run.total_items > 0 ? (run.passed_items / run.total_items) * 100 : 0,
    startedAtLabel: formatShortDate(run.started_at),
    status: run.status || 'unknown',
  }));
  for (const [index, runItems] of trendRunItems.entries()) {
    const itemScores = runItems
      .map((item) => extractItemSimilarityScore(item.response_payload))
      .filter((value): value is number => typeof value === 'number');

    trendData[index]!.avgSimilarity =
      itemScores.length > 0
        ? itemScores.reduce((sum, value) => sum + value, 0) / itemScores.length
        : null;
  }

  const suggestionLists = buildSuggestionListsFromTestItems(suggestionRows);

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
                {test.intended_agent ? (
                  <>
                    <span className="mx-1 text-slate-400">·</span>
                    Intended agent:{' '}
                    {V1_AGENT_REGISTRY.find((a) => a.id === test.intended_agent)?.label ??
                      test.intended_agent}
                  </>
                ) : null}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <AddTestItemDialog
                returnPath={`/admin/tests/${test.id}`}
                suggestionLists={suggestionLists}
                testId={test.id}
              />
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/tests">Back to tests</Link>
              </Button>
              <form action={runTestAction}>
                <input
                  name="returnPath"
                  type="hidden"
                  value={`/admin/tests/${test.id}`}
                />
                <input name="testId" type="hidden" value={test.id} />
                <Button size="sm" type="submit">
                  Run dataset
                </Button>
              </form>
            </div>
          </div>
        </section>

        <TestHistoricalTrendsCharts runs={trendData} />

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Recent runs</h2>
          <div className="relative mt-4 max-h-[min(48vh,32rem)] overflow-auto overscroll-contain rounded-2xl border border-slate-200">
            <table className="w-full min-w-[640px] caption-bottom text-sm">
              <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226_232_240)] [&_tr]:border-b-0">
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
                            <Link
                              href={`/admin/tests/${test.id}/runs/${result.id}`}
                            >
                              View run
                            </Link>
                          </Button>
                          <form action={deleteTestRunAction}>
                            <input
                              name="returnPath"
                              type="hidden"
                              value={`/admin/tests/${test.id}`}
                            />
                            <input
                              name="testId"
                              type="hidden"
                              value={test.id}
                            />
                            <input
                              name="runId"
                              type="hidden"
                              value={result.id}
                            />
                            <Button
                              size="sm"
                              type="submit"
                              variant="destructive"
                            >
                              Delete run
                            </Button>
                          </form>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </table>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <TestPromptsSection
            datasetName={test.name}
            items={items.map((item) => ({
              id: item.id,
              row_index: item.row_index,
              prompt: item.prompt,
              expected_should_answer: item.expected_should_answer,
              expected_result_type: item.expected_result_type,
              expected_canonical_product: item.expected_canonical_product,
              expected_reason_code: item.expected_reason_code,
              input_payload: item.input_payload,
            }))}
            returnPath={`/admin/tests/${test.id}`}
            testId={test.id}
          />
        </section>
      </main>
    </div>
  );
}
