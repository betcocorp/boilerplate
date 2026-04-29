import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { Button } from '~/components/ui/button';
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
  getTestById,
  getTestItemById,
  listResultItemsByTestItemId,
  listTestResultsByTestId,
} from '~/lib/tests/repository';
import { formatDate, formatDurationSeconds } from '~/lib/utils/time';

export const metadata = {
  title: 'Item History | Betco BEX',
  description: 'View historical item outcomes across all runs.',
};

type PageProps = {
  params: Promise<{ testId: string; itemId: string }>;
};

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

/**
 * Pulls every per-source `similarity` value off the response payload's `sources`
 * array and reduces it to {min, max, avg}. Returns null when nothing usable was
 * recorded (e.g. early-decline runs or older payload shapes).
 */
function extractSimilarityStats(
  responsePayload: unknown,
): { min: number; max: number; avg: number } | null {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const sources = (responsePayload as Record<string, unknown>).sources;
  if (!Array.isArray(sources)) {
    return null;
  }

  const similarities = sources
    .map((source) => {
      if (!source || typeof source !== 'object' || Array.isArray(source)) {
        return null;
      }
      const value = (source as Record<string, unknown>).similarity;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    })
    .filter((value): value is number => typeof value === 'number');

  if (similarities.length === 0) {
    return null;
  }

  const min = Math.min(...similarities);
  const max = Math.max(...similarities);
  const avg =
    similarities.reduce((sum, value) => sum + value, 0) / similarities.length;
  return { min, max, avg };
}

/** Pulls `timingBreakdown.searchMs` if recorded. */
function extractRagSearchMs(responsePayload: unknown): number | null {
  if (
    !responsePayload ||
    typeof responsePayload !== 'object' ||
    Array.isArray(responsePayload)
  ) {
    return null;
  }

  const timing = (responsePayload as Record<string, unknown>).timingBreakdown;
  if (!timing || typeof timing !== 'object' || Array.isArray(timing)) {
    return null;
  }

  const searchMs = (timing as Record<string, unknown>).searchMs;
  return typeof searchMs === 'number' && Number.isFinite(searchMs)
    ? searchMs
    : null;
}

function formatSimilarityValue(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? `${(value * 100).toFixed(1)}%`
    : 'n/a';
}

function formatExpectedShouldAnswerLabel(value: boolean | null): string {
  if (value === null) {
    return 'Unset';
  }
  return value ? 'Yes' : 'No';
}

/**
 * Top block matches the former single cell: `error_message || response_text || 'n/a'`.
 * Below that, the stored assistant body (`response_text`) so failed rows show evaluation
 * text first and the LLM answer underneath.
 */
function ItemHistoryMessageCell({
  errorMessage,
  responseText,
}: {
  errorMessage: string | null;
  responseText: string | null;
}) {
  const assistant = responseText?.trim() ?? '';
  const legacyLine = errorMessage?.trim() || assistant || 'n/a';

  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Message
        </p>
        <p className="mt-1 whitespace-pre-wrap text-slate-700">{legacyLine}</p>
      </div>
      <div>
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">
          Assistant response
        </p>
        <p className="mt-1 whitespace-pre-wrap text-slate-800">{assistant || '—'}</p>
      </div>
    </div>
  );
}

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

  const [runs, itemRunResults] = await Promise.all([
    listTestResultsByTestId(test.id, 200),
    listResultItemsByTestItemId(item.id, 500),
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
            </div>
          </div>
          <div className="mt-4 space-y-4 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-700">
            <div>
              <p className="font-semibold text-slate-900">Prompt</p>
              <p className="mt-1 whitespace-pre-wrap">{item.prompt}</p>
            </div>
            <div className="border-t border-slate-200 pt-4">
              <p className="font-semibold text-slate-900">Should answer</p>
              <p className="mt-1 text-slate-800">
                {formatExpectedShouldAnswerLabel(item.expected_should_answer)}
              </p>
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">
            Historical outcomes ({historyRows.length})
          </h2>
          <div className="relative mt-4 max-h-[min(70vh,48rem)] overflow-auto overscroll-contain rounded-2xl border border-slate-200">
          <table className="w-full min-w-[1200px] caption-bottom text-sm">
            <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226_232_240)] [&_tr]:border-b-0">
              <TableRow>
                <TableHead>Run id</TableHead>
                <TableHead>Passed</TableHead>
                <TableHead
                  className="whitespace-nowrap"
                  title="Lowest per-source similarity recorded for this item run"
                >
                  Sim min
                </TableHead>
                <TableHead
                  className="whitespace-nowrap"
                  title="Highest per-source similarity recorded for this item run"
                >
                  Sim max
                </TableHead>
                <TableHead
                  className="whitespace-nowrap"
                  title="Average per-source similarity for this item run"
                >
                  Sim avg
                </TableHead>
                <TableHead
                  className="whitespace-nowrap"
                  title="Time spent in similarity search for this prompt"
                >
                  RAG search elapsed
                </TableHead>
                <TableHead
                  className="whitespace-nowrap"
                  title="Total wall-clock time the prompt took end-to-end"
                >
                  Total prompt elapsed
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
                  const ragSearchMs = extractRagSearchMs(result.response_payload);
                  return (
                    <TableRow key={result.id}>
                      <TableCell className="font-mono text-xs">
                        <Link
                          className="text-sky-700 underline-offset-2 hover:underline"
                          href={`/admin/tests/${test.id}/runs/${run.id}`}
                        >
                          {run.id}
                        </Link>
                      </TableCell>
                      <TableCell>{result.passed ? 'yes' : 'no'}</TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                        {formatSimilarityValue(similarityStats?.min)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                        {formatSimilarityValue(similarityStats?.max)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
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
                        <ItemHistoryMessageCell
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
