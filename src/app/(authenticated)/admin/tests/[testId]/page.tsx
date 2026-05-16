import { TrashIcon, TrendingDown, TrendingUp } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
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
  buildPromptAggregations,
  extractItemMaxSimilarity,
} from '~/lib/tests/prompt-aggregations';
import {
  extractSearchRunEmbeddingSource,
  extractSearchRunMaxSimilarity,
} from '~/lib/tests/response-payload';
import {
  getGlobalTestItemSuggestionRows,
  getLegacyProductLineSuggestionMeta,
  getTestById,
  getTestItemsByTestId,
  listAllResultItemsByResultIds,
  listSearchResultsByTestId,
  listTestResultsByTestId,
} from '~/lib/tests/repository';
import {
  buildSuggestionListsFromTestItems,
  distinctNonEmptyStrings,
} from '~/lib/tests/suggestion-lists';

import { TestHistoricalTrendsCharts } from '~/components/admin/tests/TestHistoricalTrendsCharts';
import {
  formatDate,
  formatDurationSeconds,
  formatRunChartAxisLabel,
} from '~/lib/utils/time';
import {
  formatPercentDelta,
  formatSimilarityDelta,
} from '~/lib/tests/format';

import {
  deleteSearchRunAction,
  deleteTestRunAction,
  runSearchEvalAction,
  runTestAction,
} from '../actions';

export const metadata = {
  title: 'Test Details | Betco BEX',
  description: 'Review test rows and historical run performance.',
};

/**
 * Compares a metric to the previous (older) run and renders a green up arrow +
 * positive delta when the value rose, a red down arrow + negative delta when it
 * fell, or nothing when there is no prior value to compare against (or when it's
 * unchanged). `formatDelta` receives the absolute delta and returns the unit'd
 * label (e.g. "1.2%", "30 s").
 */
function RunTrendIndicator({
  current,
  previous,
  label,
  formatDelta,
}: {
  current: number | null | undefined;
  previous: number | null | undefined;
  label: string;
  formatDelta: (absoluteDelta: number) => string;
}) {
  if (
    typeof current !== 'number' ||
    !Number.isFinite(current) ||
    typeof previous !== 'number' ||
    !Number.isFinite(previous) ||
    current === previous
  ) {
    return null;
  }

  const delta = current - previous;
  const isUp = delta > 0;
  const Icon = isUp ? TrendingUp : TrendingDown;
  const colorClass = isUp ? 'text-emerald-600' : 'text-red-600';
  const direction = isUp ? 'higher' : 'lower';
  const sign = isUp ? '+' : '−';
  const deltaLabel = `${sign}${formatDelta(Math.abs(delta))}`;

  return (
    <span
      aria-label={`${label} ${direction} than previous run by ${deltaLabel}`}
      className={`inline-flex items-center gap-0.5 align-middle text-xs font-medium ${colorClass}`}
    >
      {deltaLabel}
      <Icon aria-hidden className="h-3.5 w-3.5" />
    </span>
  );
}

function formatElapsedDelta(absoluteDelta: number) {
  return formatDurationSeconds(absoluteDelta);
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

  const [items, results, searchResults, globalSuggestionRows, legacyProductLines] = await Promise.all([
    getTestItemsByTestId(testId),
    listTestResultsByTestId(testId, 20),
    listSearchResultsByTestId(testId, 10),
    getGlobalTestItemSuggestionRows(),
    getLegacyProductLineSuggestionMeta(),
  ]);
  const trendRuns = [...results].reverse();
  /** One IN-query for every result item across every recent run feeds both the trend chart and the per-prompt aggregation. */
  const [allRecentResultItems, searchRunItems] = await Promise.all([
    listAllResultItemsByResultIds(trendRuns.map((run) => run.id)),
    listAllResultItemsByResultIds(searchResults.map((run) => run.id)),
  ]);
  const resultItemsByRunId = new Map<string, typeof allRecentResultItems>();
  for (const item of allRecentResultItems) {
    const list = resultItemsByRunId.get(item.test_result_id);
    if (list) {
      list.push(item);
    } else {
      resultItemsByRunId.set(item.test_result_id, [item]);
    }
  }

  const trendData = trendRuns.map((run) => {
    const runItems = resultItemsByRunId.get(run.id) ?? [];
    const itemScores = runItems
      .map((item) => extractItemMaxSimilarity(item.response_payload))
      .filter((value): value is number => typeof value === 'number');
    const avgSimilarity =
      itemScores.length > 0
        ? itemScores.reduce((sum, value) => sum + value, 0) / itemScores.length
        : null;
    return {
      avgSimilarity,
      elapsedSeconds:
        typeof run.elapsed_ms === 'number'
          ? Number((run.elapsed_ms / 1000).toFixed(2))
          : 0,
      passRate:
        run.total_items > 0 ? (run.passed_items / run.total_items) * 100 : 0,
      startedAtLabel: formatRunChartAxisLabel(run.started_at),
      status: run.status || 'unknown',
    };
  });

  const metricsByRunId = new Map<
    string,
    { passRatePercent: number; avgSimilarity: number | null }
  >();
  for (let i = 0; i < trendRuns.length; i += 1) {
    const run = trendRuns[i]!;
    const row = trendData[i]!;
    metricsByRunId.set(run.id, {
      passRatePercent: row.passRate,
      avgSimilarity: row.avgSimilarity,
    });
  }

  const runsById = new Map(trendRuns.map((run) => [run.id, run]));
  const promptAggregations = buildPromptAggregations(
    allRecentResultItems,
    runsById,
  );
  const aggregationsForClient: Record<
    string,
    {
      runCount: number;
      passCount: number;
      failCount: number;
      passRatePercent: number | null;
      avgSimilarity: number | null;
      avgElapsedMs: number | null;
      latestRun: {
        runId: string;
        passed: boolean;
      } | null;
    }
  > = {};
  for (const [itemId, stats] of promptAggregations) {
    aggregationsForClient[itemId] = {
      runCount: stats.runCount,
      passCount: stats.passCount,
      failCount: stats.failCount,
      passRatePercent: stats.passRatePercent,
      avgSimilarity: stats.avgSimilarity,
      avgElapsedMs: stats.avgElapsedMs,
      latestRun: stats.latestRun
        ? { runId: stats.latestRun.runId, passed: stats.latestRun.passed }
        : null,
    };
  }
  const aggregatedRunCount = trendRuns.length;

  const searchItemsByRunId = new Map<string, typeof searchRunItems>();
  for (const item of searchRunItems) {
    const list = searchItemsByRunId.get(item.test_result_id);
    if (list) {
      list.push(item);
    } else {
      searchItemsByRunId.set(item.test_result_id, [item]);
    }
  }
  const searchRunStatsByRunId = new Map<
    string,
    {
      avgMaxSim: number | null;
      minMaxSim: number | null;
      maxMaxSim: number | null;
      embeddingSources: string[];
    }
  >();
  for (const run of searchResults) {
    const runItems = searchItemsByRunId.get(run.id) ?? [];
    const maxSims = runItems
      .map((item) => extractSearchRunMaxSimilarity(item.response_payload))
      .filter((v): v is number => v !== null);
    const sources = Array.from(
      new Set(
        runItems
          .map((item) => extractSearchRunEmbeddingSource(item.response_payload))
          .filter((v): v is string => v !== null),
      ),
    );
    searchRunStatsByRunId.set(run.id, {
      avgMaxSim:
        maxSims.length > 0
          ? maxSims.reduce((s, v) => s + v, 0) / maxSims.length
          : null,
      minMaxSim: maxSims.length > 0 ? Math.min(...maxSims) : null,
      maxMaxSim: maxSims.length > 0 ? Math.max(...maxSims) : null,
      embeddingSources: sources,
    });
  }

  /**
   * "Add prompt" comboboxes use values seen across **all** tests so the same options appear on every dataset page.
   * Expected canonical product values are **`prod_line.ProdLineKey`**; labels in the UI come from **`ProdLineDescr`** (union with historical test strings).
   */
  const datasetSuggestions = buildSuggestionListsFromTestItems(globalSuggestionRows);
  const suggestionLists = {
    ...datasetSuggestions,
    canonicalProducts: distinctNonEmptyStrings([
      ...legacyProductLines.keys,
      ...datasetSuggestions.canonicalProducts,
    ]),
  };

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
                    {V1_AGENT_REGISTRY.find((a) => a.id === test.intended_agent)
                      ?.label ?? test.intended_agent}
                  </>
                ) : null}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <AddTestItemDialog
                canonicalProductLabels={legacyProductLines.labelByKey}
                returnPath={`/admin/tests/${test.id}`}
                suggestionLists={suggestionLists}
                testId={test.id}
              />
              <Button asChild size="sm" variant="outline">
                <Link href="/admin/tests">Back to tests</Link>
              </Button>
              <form action={runSearchEvalAction}>
                <input name="testId" type="hidden" value={test.id} />
                <Button size="sm" type="submit" variant="outline">
                  Run search eval
                </Button>
              </form>
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
            <table className="w-full min-w-[880px] caption-bottom text-sm">
              <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226_232_240)] [&_tr]:border-b-0">
                <TableRow>
                  <TableHead>Run id</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Pass/fail</TableHead>
                  <TableHead title="Share of items marked passed for this run (same basis as the pass rate trend chart)">
                    Pass %
                  </TableHead>
                  <TableHead title="Mean max retrieval similarity across items with scores (same basis as the historical chart)">
                    Similarity
                  </TableHead>
                  <TableHead title="Total answer time: sum of each prompt's elapsed time for this run">
                    Elapsed
                  </TableHead>
                  <TableHead>Started / completed</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {results.length === 0 ? (
                  <TableRow>
                    <TableCell className="text-slate-500" colSpan={8}>
                      No runs yet for this dataset.
                    </TableCell>
                  </TableRow>
                ) : (
                  results.map((result, index) => {
                    const metrics = metricsByRunId.get(result.id);
                    const previousResult = results[index + 1] ?? null;
                    const previousMetrics = previousResult
                      ? metricsByRunId.get(previousResult.id)
                      : undefined;
                    const failedItems = Math.max(
                      0,
                      typeof result.failed_items === 'number'
                        ? result.failed_items
                        : result.total_items - result.passed_items,
                    );
                    return (
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
                          {result.passed_items}/{failedItems}
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                          <span className="inline-flex items-center gap-2">
                            <span>
                              {typeof metrics?.passRatePercent === 'number'
                                ? `${metrics.passRatePercent.toFixed(1)}%`
                                : '—'}
                            </span>
                            <RunTrendIndicator
                              current={metrics?.passRatePercent}
                              formatDelta={formatPercentDelta}
                              label="Pass %"
                              previous={previousMetrics?.passRatePercent}
                            />
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                          <span className="inline-flex items-center gap-2">
                            <span>
                              {typeof metrics?.avgSimilarity === 'number'
                                ? `${(metrics.avgSimilarity * 100).toFixed(1)}%`
                                : 'n/a'}
                            </span>
                            <RunTrendIndicator
                              current={metrics?.avgSimilarity}
                              formatDelta={formatSimilarityDelta}
                              label="Similarity"
                              previous={previousMetrics?.avgSimilarity}
                            />
                          </span>
                        </TableCell>
                        <TableCell className="whitespace-nowrap">
                          <span className="inline-flex items-center gap-2">
                            <span>
                              {formatDurationSeconds(result.elapsed_ms)}
                            </span>
                            <RunTrendIndicator
                              current={result.elapsed_ms}
                              formatDelta={formatElapsedDelta}
                              label="Elapsed"
                              previous={previousResult?.elapsed_ms}
                            />
                          </span>
                        </TableCell>
                        <TableCell className="text-slate-600">
                          <div className="flex flex-col gap-1 text-xs leading-tight">
                            <span>Start: {formatDate(result.started_at)}</span>
                            <span>
                              End:{' '}
                              {result.completed_at
                                ? formatDate(result.completed_at)
                                : '—'}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Button asChild size="sm" variant="outline">
                              <Link
                                href={`/admin/tests/${test.id}/runs/${result.id}`}
                              >
                                View
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
                                <TrashIcon />
                              </Button>
                            </form>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </table>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Search eval runs</h2>
          <div className="relative mt-4 max-h-[min(40vh,26rem)] overflow-auto overscroll-contain rounded-2xl border border-slate-200">
            <table className="w-full min-w-[860px] caption-bottom text-sm">
              <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226_232_240)] [&_tr]:border-b-0">
                <TableRow>
                  <TableHead>Run id</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead title="Prompts with ≥1 match / total. Zero-result prompts are the primary failure signal.">
                    Match rate
                  </TableHead>
                  <TableHead title="Average of each prompt's highest similarity score — the primary quality signal when tuning retrieval.">
                    Avg max sim
                  </TableHead>
                  <TableHead title="Lowest and highest per-prompt max-similarity. A wide gap means some prompts retrieve well and others don't.">
                    Sim range (min – max)
                  </TableHead>
                  <TableHead title="Embedding source used. Comparing runs is most meaningful when this is the same.">
                    Embedding
                  </TableHead>
                  <TableHead>Elapsed</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {searchResults.length === 0 ? (
                  <TableRow>
                    <TableCell className="text-slate-500" colSpan={9}>
                      No search eval runs yet. Click &ldquo;Run search eval&rdquo; above.
                    </TableCell>
                  </TableRow>
                ) : (
                  searchResults.map((run) => {
                    const stats = searchRunStatsByRunId.get(run.id);
                    const zeroResults = Math.max(0, run.total_items - run.passed_items);
                    const matchRatePct =
                      run.total_items > 0
                        ? (run.passed_items / run.total_items) * 100
                        : null;
                    return (
                      <TableRow key={run.id}>
                        <TableCell className="font-mono text-xs">
                          <Link
                            className="text-sky-700 underline-offset-2 hover:underline"
                            href={`/admin/tests/${test.id}/search-runs/${run.id}`}
                          >
                            {run.id.slice(0, 8)}…
                          </Link>
                        </TableCell>
                        <TableCell>{run.status}</TableCell>
                        <TableCell className="tabular-nums">
                          <div className="flex flex-col gap-0.5">
                            <span className="font-medium text-slate-800">
                              {matchRatePct !== null
                                ? `${matchRatePct.toFixed(0)}%`
                                : '—'}
                              <span className="ml-1.5 text-xs font-normal text-slate-500">
                                ({run.passed_items}/{run.total_items})
                              </span>
                            </span>
                            {zeroResults > 0 ? (
                              <Badge className="w-fit" variant="destructive">
                                {zeroResults} zero-result{zeroResults !== 1 ? 's' : ''}
                              </Badge>
                            ) : run.total_items > 0 ? (
                              <span className="text-xs text-emerald-700">all matched</span>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="tabular-nums text-slate-800">
                          {stats?.avgMaxSim != null
                            ? `${(stats.avgMaxSim * 100).toFixed(1)}%`
                            : '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap tabular-nums text-slate-700">
                          {stats?.minMaxSim != null && stats?.maxMaxSim != null ? (
                            <>
                              <span className="text-slate-500">
                                {(stats.minMaxSim * 100).toFixed(1)}%
                              </span>
                              <span className="mx-1 text-slate-400">–</span>
                              <span className="font-medium">
                                {(stats.maxMaxSim * 100).toFixed(1)}%
                              </span>
                            </>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-slate-600">
                          {stats?.embeddingSources.length
                            ? stats.embeddingSources.join(', ')
                            : '—'}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs text-slate-600">
                          {formatDurationSeconds(run.elapsed_ms)}
                        </TableCell>
                        <TableCell className="text-xs text-slate-600">
                          {formatDate(run.started_at)}
                        </TableCell>
                        <TableCell>
                          <div className="flex flex-wrap gap-2">
                            <Button asChild size="sm" variant="outline">
                              <Link href={`/admin/tests/${test.id}/search-runs/${run.id}`}>
                                View
                              </Link>
                            </Button>
                            <form action={deleteSearchRunAction}>
                              <input
                                name="returnPath"
                                type="hidden"
                                value={`/admin/tests/${test.id}`}
                              />
                              <input name="testId" type="hidden" value={test.id} />
                              <input name="runId" type="hidden" value={run.id} />
                              <Button size="sm" type="submit" variant="destructive">
                                <TrashIcon />
                              </Button>
                            </form>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </table>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <TestPromptsSection
            aggregatedRunCount={aggregatedRunCount}
            aggregationsByItemId={aggregationsForClient}
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
