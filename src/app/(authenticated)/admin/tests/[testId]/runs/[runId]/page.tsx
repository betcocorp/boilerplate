import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

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
import { AdminTestsActionToast } from '~/components/admin/tests/AdminTestsActionToast';
import { RunAtAGlanceCharts } from '~/components/admin/tests/RunAtAGlanceCharts';
import { RunExecutionProgress } from '~/components/admin/tests/RunExecutionProgress';
import { listWorkflowRunsByIds } from '~/lib/conversations/workflow-repository';
import { resolveResponsesModel } from '~/lib/openai/client';
import {
  countResultItemsByResultId,
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listResultItemsByResultId,
} from '~/lib/tests/repository';
import { deleteTestRunAction } from '../../../actions';

export const metadata = {
  title: 'Run Details | Betco BEX',
  description: 'Inspect item-level outcomes for a specific test run.',
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function formatDurationSeconds(value: number | null | undefined) {
  if (typeof value !== 'number') {
    return 'n/a';
  }
  return `${(value / 1000).toFixed(2)} s`;
}

function extractItemSimilarityScore(responsePayload: unknown) {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
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
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
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
    parts.push(`${(maxSimilarity * 100).toFixed(1)}% sim`);
  }
  if (confidence != null) {
    parts.push(`${confidence.toFixed(2)} conf`);
  }
  return parts.join(' · ');
}

function extractWorkflowRunId(responsePayload: unknown) {
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
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
  if (!responsePayload || typeof responsePayload !== 'object' || Array.isArray(responsePayload)) {
    return null;
  }

  const candidate = (responsePayload as Record<string, unknown>).timingBreakdown;
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

export default async function AdminTestRunDetailsPage({ params, searchParams }: PageProps) {
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

  const [resultItems, testItems, completedFromRows] = await Promise.all([
    listResultItemsByResultId(result.id, 200),
    getTestItemsByTestId(test.id),
    countResultItemsByResultId(result.id),
  ]);
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
  const promptByItemId = new Map(testItems.map((item) => [item.id, item.prompt]));
  const passCount = result.passed_items ?? 0;
  const failCount = result.failed_items ?? resultItems.filter((item) => !item.passed).length;
  const incompleteCount = Math.max(0, result.total_items - passCount - failCount);

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
      ? similarityScores.reduce((sum, score) => sum + score, 0) / similarityScores.length
      : 0;
  const similarityStatsData = [
    { label: 'Min', value: similarityMin },
    { label: 'Max', value: similarityMax },
    { label: 'Avg', value: similarityAvg },
  ];
  const slowOverTenSecondsCount = resultItems.filter((item) => item.elapsed_ms > 10_000).length;
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

  return (
    <div className="flex flex-1 bg-slate-50">
      <AdminTestsActionToast error={error} success={success} />
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                Run details
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                {test.name}
              </h1>
              <p className="mt-3 font-mono text-xs text-slate-600">Run id: {result.id}</p>
            </div>
            <div className="flex items-center gap-2">
              <form action={deleteTestRunAction}>
                <input name="returnPath" type="hidden" value={`/admin/tests/${test.id}`} />
                <input name="testId" type="hidden" value={test.id} />
                <input name="runId" type="hidden" value={result.id} />
                <Button size="sm" type="submit" variant="destructive">
                  Delete run
                </Button>
              </form>
              <Button asChild size="sm" variant="outline">
                <Link href={`/admin/tests/${test.id}`}>Back to dataset</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/tests">Back to tests</Link>
              </Button>
            </div>
          </div>
        </section>

        <RunExecutionProgress
          initialCompletedItems={initialCompletedItems}
          initialElapsedMs={result.elapsed_ms ?? 0}
          initialStatus={result.status}
          initialTotalItems={initialTotalItems}
          runId={result.id}
        />

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Run summary</h2>
          <div className="mt-4 grid gap-3 text-sm text-slate-700 sm:grid-cols-2 lg:grid-cols-4">
            <p>
              <span className="font-semibold text-slate-900">Status:</span> {result.status}
            </p>
            <p>
              <span className="font-semibold text-slate-900">Pass/fail/incomplete:</span>{' '}
              {passCount}/{failCount}/{incompleteCount}
            </p>
            <p>
              <span className="font-semibold text-slate-900">Started:</span>{' '}
              {formatDate(result.started_at)}
            </p>
            <p>
              <span className="font-semibold text-slate-900">Elapsed:</span>{' '}
              {formatDurationSeconds(result.elapsed_ms)}
            </p>
          </div>
        </section>

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
          <h2 className="text-lg font-semibold text-slate-900">Item-level results</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Row</TableHead>
                <TableHead>Prompt</TableHead>
                <TableHead>Passed</TableHead>
                <TableHead>Similarity / confidence</TableHead>
                <TableHead>Elapsed</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Model</TableHead>
                <TableHead>Timing breakdown</TableHead>
                <TableHead>Message</TableHead>
                <TableHead>History</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resultItems.length === 0 ? (
                <TableRow>
                  <TableCell className="text-slate-500" colSpan={10}>
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
                    <TableCell>{row.passed ? 'yes' : 'no'}</TableCell>
                    <TableCell className="whitespace-nowrap font-mono text-xs text-slate-700">
                      {formatItemSimilarityConfidenceLabel(row.response_payload)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={row.elapsed_ms > 10_000 ? 'destructive' : 'secondary'}>
                        {formatDurationSeconds(row.elapsed_ms)}
                      </Badge>
                    </TableCell>
                    <TableCell>{row.status}</TableCell>
                    <TableCell>
                      {modelByWorkflowRunId.get(extractWorkflowRunId(row.response_payload) || '') ||
                        'n/a'}
                    </TableCell>
                    <TableCell className="max-w-[220px] whitespace-normal text-xs text-slate-600">
                      {(() => {
                        const timing = extractTimingBreakdown(row.response_payload);
                        if (!timing) {
                          return 'n/a';
                        }

                        const searchMsLabel =
                          typeof timing.searchMs === 'number'
                            ? `${timing.searchMs.toFixed(1)} ms`
                            : 'n/a';
                        return `rounds: ${timing.toolRounds} | cache: ${timing.cacheSource || 'n/a'} | search: ${searchMsLabel}`;
                      })()}
                    </TableCell>
                    <TableCell className="max-w-[420px] whitespace-normal text-xs text-slate-600">
                      {row.error_message || row.response_text || 'n/a'}
                    </TableCell>
                    <TableCell>
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/admin/tests/${test.id}/items/${row.test_item_id}`}>
                          View history
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
          <p className="mt-3 text-xs text-slate-500">
            Showing up to 200 item results from {formatDate(result.created_at)}.
          </p>
        </section>
      </main>
    </div>
  );
}
