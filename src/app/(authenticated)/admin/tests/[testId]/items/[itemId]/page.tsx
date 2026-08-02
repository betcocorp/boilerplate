import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { AiSuggestionCards } from '~/components/admin/tests/AiSuggestionCards';
import { ItemAIReviewButton } from '~/components/admin/tests/ItemAIReviewButton';
import { ItemAtAGlanceCharts } from '~/components/admin/tests/ItemAtAGlanceCharts';
import { ResultItemMessageCell } from '~/components/admin/tests/ResultItemMessageCell';
import { Button } from '~/components/ui/button';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { listAiSuggestions } from '~/lib/ai-suggestions/repository';
import { listWorkflowRunsByIds } from '~/lib/conversations/workflow-repository';
import { resolveResponsesModel } from '~/lib/openai/client';
import {
  formatExpectedShouldAnswerLabel,
  formatSimilarityValue,
} from '~/lib/tests/format';
import {
  getTestById,
  getTestItemById,
  listResultItemsByTestItemId,
  listTestResultsByTestId,
} from '~/lib/tests/repository';
import {
  extractModelTag,
  extractRagSearchMs,
  extractSimilarityStats,
  extractWorkflowRunId,
} from '~/lib/tests/response-payload';
import {
  formatDurationSeconds,
  formatRunChartAxisLabel,
} from '~/lib/utils/time';

export const metadata = {
  title: 'Item History | Betco BEX',
  description: 'View historical item outcomes across all runs.',
};

type PageProps = {
  params: Promise<{ testId: string; itemId: string }>;
};

export default async function AdminTestItemHistoryPage({ params }: PageProps) {
  await connection();
  const { testId, itemId } = await params;

  const [test, item] = await Promise.all([
    getTestById(testId).catch(() => null),
    getTestItemById(itemId).catch(() => null),
  ]);

  if (!test || !item || item.test_id !== test.id) {
    notFound();
  }

  const [runs, itemRunResults, existingSuggestions] = await Promise.all([
    listTestResultsByTestId(test.id, 200),
    listResultItemsByTestItemId(item.id, 500),
    listAiSuggestions('item', item.id).catch(() => []),
  ]);

  const runById = new Map(runs.map((run) => [run.id, run]));
  const historyRows = itemRunResults
    .map((result) => ({
      result,
      run: runById.get(result.test_result_id) || null,
    }))
    .filter(
      (
        row,
      ): row is {
        result: (typeof itemRunResults)[number];
        run: (typeof runs)[number];
      } => !!row.run,
    )
    .sort(
      (a, b) =>
        new Date(b.run.started_at).getTime() -
        new Date(a.run.started_at).getTime(),
    );
  const workflowRunIds = Array.from(
    new Set(
      historyRows
        .map(({ result }) => extractWorkflowRunId(result.response_payload))
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

  /* Aggregates + trend data for the at-a-glance charts. Only `completed` /
     `failed` statuses count as a real attempt at the prompt — queued/cancelled
     rows would otherwise distort pass-rate denominators and pull trend lines
     to zero. Trend arrays are built newest-first (matching `historyRows`) and
     reversed below so the charts render oldest → newest left to right. */
  let aggregatedRunCount = 0;
  let aggregatedPassCount = 0;
  let aggregatedFailCount = 0;
  let similarityMinSum = 0;
  let similarityMaxSum = 0;
  let similarityAvgSum = 0;
  let similaritySampleSize = 0;
  let ragSearchSumMs = 0;
  let ragSearchSampleSize = 0;
  let promptElapsedSumMs = 0;
  let promptElapsedSampleSize = 0;
  const similarityTrendNewestFirst: Array<{
    label: string;
    runId: string;
    min: number | null;
    max: number | null;
    avg: number | null;
  }> = [];
  const elapsedTrendNewestFirst: Array<{
    label: string;
    runId: string;
    ragSeconds: number | null;
    promptSeconds: number | null;
    ttftSeconds: number | null;
  }> = [];

  for (const { result, run } of historyRows) {
    if (result.status !== 'completed' && result.status !== 'failed') {
      continue;
    }
    aggregatedRunCount += 1;
    if (result.passed) {
      aggregatedPassCount += 1;
    } else {
      aggregatedFailCount += 1;
    }

    const similarityStats = extractSimilarityStats(result.response_payload);
    if (similarityStats) {
      similarityMinSum += similarityStats.min;
      similarityMaxSum += similarityStats.max;
      similarityAvgSum += similarityStats.avg;
      similaritySampleSize += 1;
    }

    const ragSearchMs = extractRagSearchMs(result.response_payload);
    if (typeof ragSearchMs === 'number') {
      ragSearchSumMs += ragSearchMs;
      ragSearchSampleSize += 1;
    }

    const promptElapsedMs =
      typeof result.elapsed_ms === 'number' &&
      Number.isFinite(result.elapsed_ms)
        ? result.elapsed_ms
        : null;
    if (promptElapsedMs !== null) {
      promptElapsedSumMs += promptElapsedMs;
      promptElapsedSampleSize += 1;
    }

    const ttftMs =
      typeof result.ttft_ms === 'number' && Number.isFinite(result.ttft_ms)
        ? result.ttft_ms
        : null;

    const axisLabel = run.started_at
      ? formatRunChartAxisLabel(run.started_at)
      : run.id.slice(0, 8);

    similarityTrendNewestFirst.push({
      label: axisLabel,
      runId: run.id,
      min: similarityStats?.min ?? null,
      max: similarityStats?.max ?? null,
      avg: similarityStats?.avg ?? null,
    });
    elapsedTrendNewestFirst.push({
      label: axisLabel,
      runId: run.id,
      ragSeconds:
        typeof ragSearchMs === 'number'
          ? Number((ragSearchMs / 1000).toFixed(3))
          : null,
      promptSeconds:
        promptElapsedMs !== null
          ? Number((promptElapsedMs / 1000).toFixed(3))
          : null,
      ttftSeconds:
        ttftMs !== null ? Number((ttftMs / 1000).toFixed(3)) : null,
    });
  }

  const similarityTrend = [...similarityTrendNewestFirst].reverse();
  const elapsedTrend = [...elapsedTrendNewestFirst].reverse();

  const similarityAverages =
    similaritySampleSize > 0
      ? {
          avgMin: similarityMinSum / similaritySampleSize,
          avgMax: similarityMaxSum / similaritySampleSize,
          avgAvg: similarityAvgSum / similaritySampleSize,
          sampleSize: similaritySampleSize,
        }
      : null;
  const avgRagSearchMs =
    ragSearchSampleSize > 0 ? ragSearchSumMs / ragSearchSampleSize : null;
  const avgPromptElapsedMs =
    promptElapsedSampleSize > 0
      ? promptElapsedSumMs / promptElapsedSampleSize
      : null;

  const aiPayload = {
    itemId: item.id,
    testName: test.name,
    prompt: item.prompt,
    expectedShouldAnswer: item.expected_should_answer,
    historyRows: historyRows.map(({ result }) => {
      const similarityStats = extractSimilarityStats(result.response_payload);
      const ragSearchMs = extractRagSearchMs(result.response_payload);
      return {
        passed: result.passed ?? false,
        status: result.status ?? '',
        errorMessage: result.error_message ?? null,
        responseText: result.response_text ?? null,
        elapsedMs: result.elapsed_ms ?? null,
        similarityMin: similarityStats?.min ?? null,
        similarityMax: similarityStats?.max ?? null,
        similarityAvg: similarityStats?.avg ?? null,
        ragSearchMs: ragSearchMs ?? null,
      };
    }),
  };

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                Item history
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                {test.name}
              </h1>
              <p className="mt-3 text-sm text-slate-600">
                Row {item.row_index}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <Button asChild size="sm" variant="outline">
                <Link href={`/admin/tests/${test.id}`}>Back to dataset</Link>
              </Button>
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/tests">Back to tests</Link>
              </Button>
              <ItemAIReviewButton payload={aiPayload} />
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <div>
              <p className="font-semibold text-slate-900">Prompt</p>
              <p className="mt-1 whitespace-pre-wrap">{item.prompt}</p>
            </div>
            <div className="shrink-0 border-l border-slate-200 pl-4 text-right">
              <p className="font-semibold text-slate-900">Should answer</p>
              <p className="mt-1 text-slate-800">
                {formatExpectedShouldAnswerLabel(item.expected_should_answer)}
              </p>
            </div>
          </div>

          <AiSuggestionCards
            generatedAt={existingSuggestions[0]?.created_at ?? null}
            suggestions={existingSuggestions}
          />
        </section>

        <ItemAtAGlanceCharts
          avgPromptElapsedMs={avgPromptElapsedMs}
          avgRagSearchMs={avgRagSearchMs}
          elapsedTrend={elapsedTrend}
          failCount={aggregatedFailCount}
          passCount={aggregatedPassCount}
          promptSampleSize={promptElapsedSampleSize}
          ragSampleSize={ragSearchSampleSize}
          runCount={aggregatedRunCount}
          similarityAverages={similarityAverages}
          similarityTrend={similarityTrend}
        />

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">
            Historical outcomes ({historyRows.length})
          </h2>
          <div className="relative mt-4 max-h-[min(70vh,48rem)] overflow-auto overscroll-contain rounded-2xl border border-slate-200">
            <table className="w-full min-w-[1200px] caption-bottom text-sm">
              <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226_232_240)] [&_tr]:border-b-0">
                <TableRow>
                  <TableHead>Run</TableHead>
                  <TableHead>Passed</TableHead>
                  <TableHead
                    className="whitespace-nowrap"
                    title="Per-source similarity min / max / avg for this item run"
                  >
                    Sim min/max/avg
                  </TableHead>
                  <TableHead
                    className="whitespace-nowrap"
                    title="Total rag search time"
                  >
                    RAG
                  </TableHead>
                  <TableHead
                    className="whitespace-nowrap"
                    title="Total time prompt took end-to-end"
                  >
                    Prompt
                  </TableHead>
                  <TableHead>Model</TableHead>
                  <TableHead>Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {historyRows.length === 0 ? (
                  <TableRow>
                    <TableCell className="text-slate-500" colSpan={9}>
                      This item has no completed results yet.
                    </TableCell>
                  </TableRow>
                ) : (
                  historyRows.map(({ result, run }) => {
                    const similarityStats = extractSimilarityStats(
                      result.response_payload,
                    );
                    const ragSearchMs = extractRagSearchMs(
                      result.response_payload,
                    );
                    return (
                      <TableRow key={result.id}>
                        <TableCell className="font-mono text-xs">
                          <Link
                            className="text-sky-700 underline-offset-2 hover:underline"
                            href={`/admin/tests/${test.id}/runs/${run.id}`}
                          >
                            View run
                          </Link>
                        </TableCell>
                        <TableCell>{result.passed ? 'yes' : 'no'}</TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                          {formatSimilarityValue(similarityStats?.min)}/
                          {formatSimilarityValue(similarityStats?.max)}/
                          {formatSimilarityValue(similarityStats?.avg)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                          {ragSearchMs === null
                            ? 'n/a'
                            : formatDurationSeconds(ragSearchMs)}
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                          {formatDurationSeconds(result.elapsed_ms)}
                        </TableCell>
                        <TableCell>
                          {modelByWorkflowRunId.get(
                            extractWorkflowRunId(result.response_payload) || '',
                          ) || 'n/a'}
                        </TableCell>
                        <TableCell className="max-w-[520px] whitespace-normal text-xs text-slate-600">
                          <ResultItemMessageCell
                            errorMessage={result.error_message}
                            responseText={result.response_text}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
