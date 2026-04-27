import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { AdminTestsActionToast } from '~/components/admin/tests/AdminTestsActionToast';
import { RetrievedChunksPreview } from '~/components/admin/tests/RetrievedChunksPreview';
import {
  TestRunNotesDisplay,
  TestRunNotesProvider,
  TestRunNotesToolbarButton,
} from '~/components/admin/tests/TestRunNotesSection';
import { RunAtAGlanceCharts } from '~/components/admin/tests/RunAtAGlanceCharts';
import { RunExecutionProgress } from '~/components/admin/tests/RunExecutionProgress';
import { RunItemResultsCsvDownload } from '~/components/admin/tests/RunItemResultsCsvDownload';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  Table,
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
import type { RetrievedDocumentChunkRef } from '~/lib/workflows/product-support/product-support-schemas';

import { deleteTestRunAction } from '../../../actions';

export const metadata = {
  title: 'Run Details | Betco BEX',
  description: 'Inspect item-level outcomes for a specific test run.',
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

function extractItemValidatorConfidence(responsePayload: unknown) {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }
  const c = (responsePayload as Record<string, unknown>).confidence;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

function formatItemSimilarityConfidenceLabel(responsePayload: unknown) {
  const maxSimilarity = extractItemSimilarityScore(responsePayload);
  const confidence = extractItemValidatorConfidence(responsePayload);
  if (maxSimilarity == null && confidence == null) {
    return 'n/a';
  }
  const parts: string[] = [];
  if (maxSimilarity != null) {
    parts.push(`${(maxSimilarity * 100).toFixed(1)}%`);
  }
  if (confidence != null) {
    parts.push(`${confidence.toFixed(2)}`);
  }
  return parts.join(' / ');
}

function extractWorkflowRunId(responsePayload: unknown) {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const candidate = (responsePayload as Record<string, unknown>).workflowRunId;
  return typeof candidate === 'string' && candidate.trim() ? candidate : null;
}

function extractModelTag(userInput: unknown) {
  if (!userInput || typeof userInput !== 'object' || Array.isArray(userInput)) {
    return undefined;
  }

  const candidate = (userInput as Record<string, unknown>).modelTag;
  return typeof candidate === 'string' ? candidate : undefined;
}

function extractTimingBreakdown(responsePayload: unknown) {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const candidate = (responsePayload as Record<string, unknown>)
    .timingBreakdown;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return null;
  }

  const timing = candidate as Record<string, unknown>;
  const toolRounds = timing.toolRounds;
  const cacheSource = timing.cacheSource;
  const searchMs = timing.searchMs;
  if (typeof toolRounds !== 'number') {
    return null;
  }

  return {
    toolRounds,
    cacheSource: typeof cacheSource === 'string' ? cacheSource : null,
    searchMs: typeof searchMs === 'number' ? searchMs : null,
  };
}

function formatTimingBreakdownLabel(responsePayload: unknown): string {
  const timing = extractTimingBreakdown(responsePayload);
  if (!timing) {
    return 'n/a';
  }

  const searchMsLabel =
    typeof timing.searchMs === 'number'
      ? `${timing.searchMs.toFixed(1)} ms`
      : 'n/a';
  return `${timing.toolRounds} | ${timing.cacheSource || 'n/a'} | ${searchMsLabel}`;
}

function parseRetrievedDocumentChunksArray(raw: unknown): RetrievedDocumentChunkRef[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: RetrievedDocumentChunkRef[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const o = item as Record<string, unknown>;
    const document_id = typeof o.document_id === 'string' ? o.document_id : '';
    if (!document_id) {
      continue;
    }
    const chunk_id = typeof o.chunk_id === 'string' ? o.chunk_id : null;
    out.push({ document_id, chunk_id });
  }
  return out;
}

/** Prefer workflow `retrieved_document_chunks`; fall back to legacy `sources` (camelCase). */
function extractRetrievedDocumentChunks(responsePayload: unknown): RetrievedDocumentChunkRef[] {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return [];
  }
  const record = responsePayload as Record<string, unknown>;
  const fromPayload = parseRetrievedDocumentChunksArray(record.retrieved_document_chunks);
  if (fromPayload.length > 0) {
    return fromPayload;
  }

  const sources = record.sources;
  if (!Array.isArray(sources)) {
    return [];
  }

  const map = new Map<string, RetrievedDocumentChunkRef>();
  for (const item of sources) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      continue;
    }
    const s = item as Record<string, unknown>;
    const document_id = typeof s.documentId === 'string' ? s.documentId : '';
    if (!document_id) {
      continue;
    }
    const chunk_id = typeof s.chunkId === 'string' ? s.chunkId : null;
    const key = `${document_id}:${chunk_id ?? ''}`;
    if (!map.has(key)) {
      map.set(key, { document_id, chunk_id });
    }
  }
  return [...map.values()];
}

function formatRetrievedChunksForCsv(chunks: RetrievedDocumentChunkRef[]): string {
  if (chunks.length === 0) {
    return '';
  }
  return chunks.map((c) => `${c.document_id}|${c.chunk_id ?? ''}`).join('; ');
}

type PageProps = {
  params: Promise<{ testId: string; runId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function extractProgress(summary: unknown, totalItems: number) {
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    return {
      completedItems: 0,
      totalItems,
    };
  }

  const data = summary as Record<string, unknown>;
  return {
    completedItems:
      typeof data.completed_items === 'number' ? data.completed_items : 0,
    totalItems:
      typeof data.total_items === 'number' ? data.total_items : totalItems,
  };
}

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

  const itemLevelCsvRows = allResultItems.map((row) => ({
    row_index: row.row_index,
    prompt: promptByItemId.get(row.test_item_id) ?? '',
    passed: row.passed,
    elapsed_seconds: Number((row.elapsed_ms / 1000).toFixed(3)),
    status: row.status,
    model:
      modelByWorkflowRunId.get(
        extractWorkflowRunId(row.response_payload) || '',
      ) ?? 'n/a',
    timing_breakdown: formatTimingBreakdownLabel(row.response_payload),
    retrieved_chunks: formatRetrievedChunksForCsv(
      extractRetrievedDocumentChunks(row.response_payload),
    ),
    message: row.error_message || row.response_text || 'n/a',
    test_item_id: row.test_item_id,
  }));

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
                <TestRunNotesToolbarButton />
                <Button asChild size="sm" variant="outline">
                  <Link href={`/admin/tests/${test.id}`}>Back to dataset</Link>
                </Button>
                <Button asChild size="sm" variant="outline">
                  <Link href="/admin/tests">Back to tests</Link>
                </Button>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Row</TableHead>
                <TableHead>Prompt</TableHead>
                <TableHead>Passed</TableHead>
                <TableHead>Sim / conf</TableHead>
                <TableHead>Elapsed</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Rounds | Cache | Elapsed</TableHead>
                <TableHead>Retrieved chunks</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>History</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {displayResultItems.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={11}>
                    No item-level results yet.
                  </TableCell>
                </TableRow>
              ) : (
                chronologicalItems.map((row) => (
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
                          row.elapsed_ms > 10_000 ? 'destructive' : 'secondary'
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
                    <TableCell className="max-w-[min(280px,100%)] align-top">
                      <RetrievedChunksPreview
                        chunks={extractRetrievedDocumentChunks(row.response_payload)}
                      />
                    </TableCell>
                    <TableCell className="max-w-[420px] whitespace-normal text-xs text-slate-600 line-clamp-2">
                      {row.error_message || row.response_text || 'n/a'}
                    </TableCell>
                    <TableCell>
                      <Button asChild size="sm" variant="outline">
                        <Link
                          href={`/admin/tests/${test.id}/items/${row.test_item_id}`}
                        >
                          View
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
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
