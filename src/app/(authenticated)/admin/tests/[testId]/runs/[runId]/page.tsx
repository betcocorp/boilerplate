import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { AdminTestsActionToast } from '~/components/admin/tests/AdminTestsActionToast';
import { ResultItemMessageCell } from '~/components/admin/tests/ResultItemMessageCell';
import { RetrievedChunksPreview } from '~/components/admin/tests/RetrievedChunksPreview';
import { RunAtAGlanceCharts } from '~/components/admin/tests/RunAtAGlanceCharts';
import { RunExecutionProgress } from '~/components/admin/tests/RunExecutionProgress';
import { RunItemResultsCsvDownload } from '~/components/admin/tests/RunItemResultsCsvDownload';
import {
  TestRunNotesDisplay,
  TestRunNotesProvider,
  TestRunNotesToolbarButton,
} from '~/components/admin/tests/TestRunNotesSection';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '~/components/ui/dialog';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { listWorkflowRunsByIds } from '~/lib/conversations/workflow-repository';
import { resolveResponsesModel } from '~/lib/openai/client';
import {
  countResultItemsByResultId,
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listAllResultItemsByResultId,
} from '~/lib/tests/repository';
import { formatDate, formatDurationSeconds } from '~/lib/utils/time';
import {
  formatExpectedShouldAnswerLabel as formatExpectedShouldAnswerCell,
  formatItemSimilarityConfidenceLabel,
  formatRetrievedChunksForCsv,
  formatTimingBreakdownLabel,
} from '~/lib/tests/format';
import {
  extractItemSimilarityScore,
  extractModelTag,
  extractProgress,
  extractRetrievedDocumentChunks,
  extractWorkflowRunId,
} from '~/lib/tests/response-payload';

import { deleteTestRunAction } from '../../../actions';

export const metadata = {
  title: 'Run Details | Betco BEX',
  description: 'Inspect item-level outcomes for a specific test run.',
};

type PageProps = {
  params: Promise<{ testId: string; runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function AdminTestRunDetailsPage({
  params,
  searchParams,
}: PageProps) {
  await connection();
  const { testId, runId } = await params;
  const query = await searchParams;
  const success = typeof query.success === 'string' ? query.success : null;
  const error = typeof query.error === 'string' ? query.error : null;

  const [test, result] = await Promise.all([
    getTestById(testId).catch(() => null),
    getTestResultById(runId).catch(() => null),
  ]);

  if (!test || !result || result.test_id !== test.id) {
    notFound();
  }

  const [allResultItems, testItems, completedFromRows] = await Promise.all([
    listAllResultItemsByResultId(result.id),
    getTestItemsByTestId(test.id),
    countResultItemsByResultId(result.id),
  ]);
  const resultItems = allResultItems;
  const displayResultItems = allResultItems.slice(0, 200);
  const progress = extractProgress(result.summary, result.total_items);
  const initialTotalItems = Math.max(progress.totalItems, result.total_items);
  const initialCompletedItemsRaw = Math.max(
    progress.completedItems,
    completedFromRows,
    result.passed_items + result.failed_items,
  );
  const initialCompletedItems =
    initialTotalItems > 0
      ? Math.min(initialTotalItems, initialCompletedItemsRaw)
      : initialCompletedItemsRaw;
  const promptByItemId = new Map(
    testItems.map((item) => [item.id, item.prompt]),
  );
  const expectedShouldAnswerByItemId = new Map(
    testItems.map((item) => [item.id, item.expected_should_answer]),
  );
  const passCount = result.passed_items ?? 0;
  const failCount =
    result.failed_items ?? resultItems.filter((item) => !item.passed).length;
  const incompleteCount = Math.max(
    0,
    result.total_items - passCount - failCount,
  );

  const chronologicalItems = [...resultItems].sort((a, b) => {
    if (a.created_at === b.created_at) {
      return a.row_index - b.row_index;
    }
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
  const elapsedTrendData = chronologicalItems.map((item, index) => ({
    label: `${index + 1}`,
    elapsedSeconds: Number((item.elapsed_ms / 1000).toFixed(2)),
    resultItemId: item.id,
    passed: item.passed,
  }));

  const similarityScores = resultItems
    .map((item) => extractItemSimilarityScore(item.response_payload))
    .filter((value): value is number => typeof value === 'number');
  const similarityMin =
    similarityScores.length > 0 ? Math.min(...similarityScores) : 0;
  const similarityMax =
    similarityScores.length > 0 ? Math.max(...similarityScores) : 0;
  const similarityAvg =
    similarityScores.length > 0
      ? similarityScores.reduce((sum, score) => sum + score, 0) /
        similarityScores.length
      : 0;
  const similarityStatsData = [
    { label: 'Min', value: similarityMin },
    { label: 'Max', value: similarityMax },
    { label: 'Avg', value: similarityAvg },
  ];
  const slowOverTenSecondsCount = resultItems.filter(
    (item) => item.elapsed_ms > 10_000,
  ).length;
  const notPassedItemCount = resultItems.filter((item) => !item.passed).length;
  const workflowRunIds = Array.from(
    new Set(
      resultItems
        .map((item) => extractWorkflowRunId(item.response_payload))
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const workflowRuns = await listWorkflowRunsByIds(workflowRunIds);
  const modelByWorkflowRunId = new Map(
    workflowRuns.map((workflowRun) => {
      const modelTag = extractModelTag(workflowRun.user_input);
      return [workflowRun.id, resolveResponsesModel(modelTag)] as const;
    }),
  );

  const itemLevelCsvRows = chronologicalItems.map((row) => {
    const expectedRaw = expectedShouldAnswerByItemId.get(row.test_item_id);
    const expectedForCell: boolean | null =
      expectedRaw === undefined ? null : expectedRaw;

    return {
      row_index: row.row_index,
      prompt: promptByItemId.get(row.test_item_id) ?? '',
      expected_answer: formatExpectedShouldAnswerCell(expectedForCell),
      passed: row.passed ? 'Yes' : 'No',
      sim_conf: formatItemSimilarityConfidenceLabel(row.response_payload),
      elapsed: formatDurationSeconds(row.elapsed_ms),
      model:
        modelByWorkflowRunId.get(
          extractWorkflowRunId(row.response_payload) || '',
        ) ?? 'n/a',
      rounds_cache_search: formatTimingBreakdownLabel(row.response_payload),
      message: row.error_message || row.response_text || 'n/a',
      item_detail_path: `/admin/tests/${test.id}/items/${row.test_item_id}`,
      retrieved_chunks: formatRetrievedChunksForCsv(
        extractRetrievedDocumentChunks(row.response_payload),
      ),
      test_item_id: row.test_item_id,
    };
  });

  return (
    <div className="flex flex-1 bg-slate-50">
      <AdminTestsActionToast error={error} success={success} />
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <TestRunNotesProvider
          initialNotes={result.notes}
          runId={result.id}
          testId={test.id}
        >
          <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                  Run details
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                  {test.name}
                </h1>
                <TestRunNotesDisplay />
                <p className="mt-3 font-mono text-xs text-slate-600">
                  Run id: {result.id}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href={`/admin/tests/${test.id}`}>Back to test</Link>
                </Button>
                <TestRunNotesToolbarButton />
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
            </div>
          </section>
        </TestRunNotesProvider>

        <RunExecutionProgress
          initialCompletedItems={initialCompletedItems}
          initialElapsedMs={result.elapsed_ms ?? 0}
          initialStatus={result.status}
          initialTotalItems={initialTotalItems}
          runId={result.id}
          stats={{
            passCount,
            failCount,
            incompleteCount,
            started_at: result?.started_at ?? '',
          }}
        />

        <RunAtAGlanceCharts
          elapsedTrendData={elapsedTrendData}
          failCount={failCount}
          initialStatus={result.status}
          notPassedItemCount={notPassedItemCount}
          passCount={passCount}
          runId={result.id}
          similarityStatsData={similarityStatsData}
          slowOverTenSecondsCount={slowOverTenSecondsCount}
          totalItems={result.total_items}
        />

        <section
          className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"
          id="item-level-results"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-slate-900">
              Item-level results
            </h2>
            <RunItemResultsCsvDownload
              fileBase={`${test.name}-run-${result.id}`}
              rows={itemLevelCsvRows}
            />
          </div>
          <div className="relative max-h-[min(70vh,48rem)] overflow-auto overscroll-contain rounded-2xl border border-slate-200">
          <table className="w-full min-w-[1280px] caption-bottom text-sm">
            <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226_232_240)] [&_tr]:border-b-0">
              <TableRow>
                <TableHead>Row</TableHead>
                <TableHead>Prompt</TableHead>
                <TableHead className="whitespace-nowrap">Answer?</TableHead>
                <TableHead>Passed</TableHead>
                <TableHead>Sim / conf</TableHead>
                <TableHead>Elapsed</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Rounds | Cache | Elapsed</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>History</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayResultItems.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={10}>
                    No item-level results yet.
                  </TableCell>
                </TableRow>
              ) : (
                chronologicalItems.map((row) => {
                  const expectedShouldAnswer =
                    expectedShouldAnswerByItemId.get(row.test_item_id) ?? null;
                  return (
                    <TableRow id={`run-item-result-${row.id}`} key={row.id}>
                      <TableCell>
                        <Link
                          className="text-sky-700 underline-offset-2 hover:underline"
                          href={`/admin/tests/${test.id}/items/${row.test_item_id}`}
                        >
                          {row.row_index}
                        </Link>
                      </TableCell>
                      <TableCell className="max-w-[420px] whitespace-normal text-xs text-slate-700">
                        <Link
                          className="text-sky-700 underline-offset-2 hover:underline"
                          href={`/admin/tests/${test.id}/items/${row.test_item_id}`}
                        >
                          {promptByItemId.get(row.test_item_id) || 'n/a'}
                        </Link>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <Badge
                          className={
                            expectedShouldAnswer === true
                              ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-50'
                              : undefined
                          }
                          variant={
                            expectedShouldAnswer === null
                              ? 'secondary'
                              : expectedShouldAnswer === true
                                ? 'outline'
                                : 'destructive'
                          }
                        >
                          {formatExpectedShouldAnswerCell(expectedShouldAnswer)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          className={
                            row.passed
                              ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-50'
                              : undefined
                          }
                          variant={row.passed ? 'outline' : 'destructive'}
                        >
                          {row.passed ? 'Yes' : 'No'}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap font-mono text-xs text-slate-700">
                        <Badge variant="outline">
                          {formatItemSimilarityConfidenceLabel(
                            row.response_payload,
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            row.elapsed_ms > 10_000
                              ? 'destructive'
                              : 'secondary'
                          }
                        >
                          {formatDurationSeconds(row.elapsed_ms)}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">
                          {modelByWorkflowRunId.get(
                            extractWorkflowRunId(row.response_payload) || '',
                          ) || 'n/a'}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[220px] whitespace-normal text-xs text-slate-600">
                        {formatTimingBreakdownLabel(row.response_payload)}
                      </TableCell>
                      <TableCell className="max-w-[420px] whitespace-normal text-xs text-slate-600">
                        <ResultItemMessageCell
                          errorMessage={row.error_message}
                          responseText={row.response_text}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Dialog>
                            <DialogTrigger asChild>
                              <Button variant="outline">Docs</Button>
                            </DialogTrigger>
                            <DialogContent>
                              <DialogHeader>
                                <DialogTitle>Document chunks</DialogTitle>
                                <DialogDescription>
                                  Chunks retrieved from rag search.
                                </DialogDescription>
                              </DialogHeader>
                              <div className="-mx-4 no-scrollbar max-h-[50vh] overflow-y-auto px-4">
                                <RetrievedChunksPreview
                                  chunks={extractRetrievedDocumentChunks(
                                    row.response_payload,
                                  )}
                                />
                              </div>
                            </DialogContent>
                          </Dialog>
                          <Button asChild size="sm" variant="outline">
                            <Link
                              href={`/admin/tests/${test.id}/items/${row.test_item_id}`}
                            >
                              View
                            </Link>
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </table>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            Showing {Math.min(200, allResultItems.length)} of{' '}
            {allResultItems.length} item-level results from{' '}
            {formatDate(result.created_at)}.
          </p>
        </section>
      </main>
    </div>
  );
}
