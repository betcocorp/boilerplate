import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

import { AdminTestsActionToast } from '~/components/admin/tests/AdminTestsActionToast';
import { ResultItemMessageCell } from '~/components/admin/tests/ResultItemMessageCell';
import { RunAtAGlanceCharts } from '~/components/admin/tests/RunAtAGlanceCharts';
import { RunExecutionProgress } from '~/components/admin/tests/RunExecutionProgress';
import {
  RunFullExportDownload,
  type RunExportItem,
} from '~/components/admin/tests/RunFullExportDownload';
import {
  RunInsightsPanel,
  type Insight,
} from '~/components/admin/tests/RunInsightsPanel';
import { RunItemResultsCsvDownload } from '~/components/admin/tests/RunItemResultsCsvDownload';
import { RunReportButton } from '~/components/admin/tests/RunReportButton';
import { RoutingAccuracyBoard } from '~/components/admin/tests/RoutingAccuracyBoard';
import { RunToolRoutingPanel } from '~/components/admin/tests/RunToolRoutingPanel';
import { PromptBundleVersionBadge } from '~/components/admin/tests/PromptBundleVersionBadge';
import {
  TestRunNotesDisplay,
  TestRunNotesProvider,
  TestRunNotesToolbarButton,
} from '~/components/admin/tests/TestRunNotesSection';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { getAgentBadgeClassName } from '~/lib/bex/agent-badge';
import { listWorkflowRunsByIds } from '~/lib/conversations/workflow-repository';
import { resolveResponsesModel } from '~/lib/openai/client';
import {
  formatExpectedShouldAnswerLabel as formatExpectedShouldAnswerCell,
  formatItemSimilarityConfidenceLabel,
  formatRetrievedChunksForCsv,
  formatShouldAnswerExport,
  formatTimingBreakdownLabel,
} from '~/lib/tests/format';
import {
  countResultItemsByResultId,
  getTestById,
  getTestItemsByTestId,
  getTestResultById,
  listAgentStepOutputsByWorkflowRunIds,
  listAllResultItemsByResultId,
} from '~/lib/tests/repository';
import {
  extractItemSimilarityScore,
  extractItemValidatorConfidence,
  extractModelTag,
  extractProgress,
  extractPromptVersion,
  extractRetrievedDocumentChunks,
  extractRoutingDecision,
  extractTimingBreakdown,
  extractWorkflowRunId,
  summarizePromptBundleVersions,
} from '~/lib/tests/response-payload';
import {
  buildConfusionMatrix,
  computeAmbiguousRouteRate,
  computeConfidenceDistribution,
  computeRoutingComparisonReport,
  type RoutingComparisonReportInput,
} from '~/lib/tests/routing-comparison';
import {
  computeToolRoutingReport,
  extractExpectedTool,
  parseAgentStepToolTrace,
} from '~/lib/tests/tool-routing';
import { isCompletedRunStatus } from '~/lib/tests/types';
import { formatDate, formatDurationSeconds } from '~/lib/utils/time';
import { shortHash } from '~/lib/workflows/product-support/prompt-version';

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
  const filterParam = typeof query.filter === 'string' ? query.filter : 'all';
  const activeFilter: 'all' | 'passed' | 'failed' =
    filterParam === 'passed'
      ? 'passed'
      : filterParam === 'failed'
        ? 'failed'
        : 'all';

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
  const priorityByItemId = new Map(
    testItems.map((item) => [item.id, item.priority]),
  );
  const idealResponseByItemId = new Map(
    testItems.map((item) => [item.id, item.ideal_response]),
  );
  /** Golden-set concept/source/citation expectations, keyed by test item id. */
  const conceptExpectationsByItemId = new Map(
    testItems.map((item) => [
      item.id,
      {
        expected_concepts: item.expected_concepts,
        minimum_concepts: item.minimum_concepts,
        expected_sources: item.expected_sources,
        should_cite: item.should_cite,
      },
    ]),
  );
  const passCount = result.passed_items ?? 0;
  const failCount =
    result.failed_items ?? resultItems.filter((item) => !item.passed).length;
  const incompleteCount = Math.max(
    0,
    result.total_items - passCount - failCount,
  );
  const erroredCount = resultItems.filter((item) => {
    if (item.status === 'failed') return true;
    const p = item.response_payload;
    return (
      p !== null && typeof p === 'object' && !Array.isArray(p) && 'error' in p
    );
  }).length;

  const chronologicalItems = [...resultItems].sort((a, b) => {
    if (a.created_at === b.created_at) {
      return a.row_index - b.row_index;
    }
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
  const elapsedTrendData = chronologicalItems.map((item, index) => ({
    label: `${index + 1}`,
    elapsedSeconds: Number((item.elapsed_ms / 1000).toFixed(2)),
    ttftSeconds:
      typeof item.ttft_ms === 'number' && Number.isFinite(item.ttft_ms)
        ? Number((item.ttft_ms / 1000).toFixed(2))
        : null,
    resultItemId: item.id,
    passed: item.passed,
  }));
  const similarityTrendData = chronologicalItems.map((item, index) => ({
    label: `${index + 1}`,
    similarity: extractItemSimilarityScore(item.response_payload) ?? null,
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
  const similarityBuckets = {
    high: similarityScores.filter((s) => s >= similarityAvg).length,
    mid: similarityScores.filter((s) => s >= similarityMin && s < similarityAvg)
      .length,
    low: similarityScores.filter((s) => s < similarityMin).length,
    avgThreshold: similarityAvg,
    minThreshold: similarityMin,
    maxThreshold: similarityMax,
  };
  const slowOverTenSecondsCount = resultItems.filter(
    (item) => item.elapsed_ms > 10_000,
  ).length;
  const notPassedItemCount = resultItems.filter((item) => !item.passed).length;
  /**
   * B0-398 — run-level `promptBundleVersion` chip. The field is a build-time constant, identical
   * across every item in a run, so reading it off `resultItems` (already fetched) needs no new
   * query; `summarizePromptBundleVersions` also guards the (should-be-rare) case of a run whose
   * items disagree, e.g. a deploy landing mid-run.
   */
  const promptBundleVersionSummary = summarizePromptBundleVersions(
    resultItems.map((item) => item.response_payload),
  );
  /**
   * B0-419 — the run each execution produced. Prefer the real `workflow_run_id` column (B0-416,
   * backfilled) over re-extracting it from `response_payload`; the payload read stays only as a
   * fallback for any row the backfill could not reach. Null is expected and common: search-eval
   * rows have their own page, error rows never produced a run, and deleting a workflow run nulls
   * this via `ON DELETE SET NULL`.
   */
  const workflowRunIdByResultItemId = new Map(
    resultItems.map(
      (item) =>
        [
          item.id,
          item.workflow_run_id ?? extractWorkflowRunId(item.response_payload),
        ] as const,
    ),
  );
  const workflowRunIds = Array.from(
    new Set(
      Array.from(workflowRunIdByResultItemId.values()).filter(
        (value): value is string => Boolean(value),
      ),
    ),
  );
  const [workflowRuns, agentStepOutputs] = await Promise.all([
    listWorkflowRunsByIds(workflowRunIds),
    listAgentStepOutputsByWorkflowRunIds(workflowRunIds),
  ]);
  const modelByWorkflowRunId = new Map(
    workflowRuns.map((workflowRun) => {
      const modelTag = extractModelTag(workflowRun.user_input);
      return [workflowRun.id, resolveResponsesModel(modelTag)] as const;
    }),
  );

  /**
   * B0-383 — per-run tool-call frequency + routing-accuracy. The agent step's `toolTrace` lives on
   * `workflow_steps`, keyed by `workflow_run_id` (never on `test_result_items.response_payload`
   * itself — see `~/lib/tests/tool-routing.ts`), so it is fetched separately and joined back onto
   * each result item by its `workflow_run_id`.
   */
  const toolTraceByWorkflowRunId = new Map(
    agentStepOutputs.map((row) => [row.workflow_run_id, parseAgentStepToolTrace(row.output)] as const),
  );
  const expectedToolByTestItemId = new Map(
    testItems.map((item) => [item.id, extractExpectedTool(item.metadata)] as const),
  );
  const toolRoutingReport = computeToolRoutingReport(
    resultItems.map((row) => {
      const workflowRunId = workflowRunIdByResultItemId.get(row.id) ?? null;
      return {
        resultItemId: row.id,
        testItemId: row.test_item_id,
        rowIndex: row.row_index,
        prompt: promptByItemId.get(row.test_item_id) ?? '',
        expectedTool: expectedToolByTestItemId.get(row.test_item_id) ?? null,
        toolTrace: workflowRunId ? (toolTraceByWorkflowRunId.get(workflowRunId) ?? null) : null,
      };
    }),
  );

  /**
   * B0-502 — RoutingAccuracyBoard data. `keyword_route`/`llm_route`/`routing_confidence`/
   * `intended_agent_label` are plain columns on `test_result_items` (B0-500/501), already present on
   * `resultItems` (`select('*')` above) — no extra fetch needed, unlike the tool-routing report above
   * which has to join back to `workflow_steps`.
   */
  const routingComparisonInputs: RoutingComparisonReportInput[] = resultItems.map((row) => ({
    resultItemId: row.id,
    testItemId: row.test_item_id,
    rowIndex: row.row_index,
    prompt: promptByItemId.get(row.test_item_id) ?? '',
    intendedAgentLabel: row.intended_agent_label,
    routingDecision: row.routing_decision,
    keywordRoute: row.keyword_route,
    llmRoute: row.llm_route,
  }));
  const hasRoutingInstrumentation = resultItems.some((row) => row.keyword_route !== null);
  const routingComparisonReport = computeRoutingComparisonReport(routingComparisonInputs);
  const keywordConfusionMatrix = buildConfusionMatrix(routingComparisonInputs, 'keyword');
  const llmConfusionMatrix = buildConfusionMatrix(routingComparisonInputs, 'llm');
  const ambiguousRates = computeAmbiguousRouteRate(routingComparisonInputs);
  const confidenceDistribution = computeConfidenceDistribution(
    resultItems.map((row) => row.routing_confidence),
  );

  const itemLevelCsvRows = chronologicalItems.map((row) => {
    const expectedRaw = expectedShouldAnswerByItemId.get(row.test_item_id);
    const expectedForCell: boolean | null =
      expectedRaw === undefined ? null : expectedRaw;

    const priority = priorityByItemId.get(row.test_item_id) ?? null;
    const expectations = conceptExpectationsByItemId.get(row.test_item_id);

    return {
      row_index: row.row_index,
      prompt: promptByItemId.get(row.test_item_id) ?? '',
      priority: priority === null ? '' : String(priority),
      expected_answer: formatExpectedShouldAnswerCell(expectedForCell),
      passed: row.passed ? 'Yes' : 'No',
      sim_conf: formatItemSimilarityConfidenceLabel(row.response_payload),
      elapsed: formatDurationSeconds(row.elapsed_ms),
      model:
        modelByWorkflowRunId.get(
          workflowRunIdByResultItemId.get(row.id) || '',
        ) ?? 'n/a',
      agent: extractRoutingDecision(row.response_payload) ?? 'n/a',
      rounds_cache_search: formatTimingBreakdownLabel(row.response_payload),
      message: row.error_message || row.response_text || 'n/a',
      ideal_response: idealResponseByItemId.get(row.test_item_id) ?? '',
      expected_concepts: expectations?.expected_concepts ?? '',
      minimum_concepts: expectations?.minimum_concepts ?? '',
      expected_sources: expectations?.expected_sources ?? '',
      should_cite: formatShouldAnswerExport(expectations?.should_cite ?? null),
      item_detail_path: `/admin/tests/${test.id}/items/${row.test_item_id}`,
      retrieved_chunks: formatRetrievedChunksForCsv(
        extractRetrievedDocumentChunks(row.response_payload),
      ),
      test_item_id: row.test_item_id,
    };
  });

  const isCompleted = isCompletedRunStatus(result.status);
  const fullExportData = isCompleted
    ? {
        run: {
          id: result.id,
          test_id: test.id,
          test_name: test.name,
          status: result.status,
          started_at: result.started_at,
          created_at: result.created_at,
          elapsed_ms: result.elapsed_ms,
          total_items: result.total_items,
          passed_items: passCount,
          failed_items: failCount,
          notes: result.notes,
        },
        items: chronologicalItems.map((row): RunExportItem => {
          const modelTag = modelByWorkflowRunId.get(
            workflowRunIdByResultItemId.get(row.id) || '',
          );
          return {
            row_index: row.row_index,
            test_item_id: row.test_item_id,
            prompt: promptByItemId.get(row.test_item_id) ?? '',
            priority: priorityByItemId.get(row.test_item_id) ?? null,
            expected_should_answer:
              expectedShouldAnswerByItemId.get(row.test_item_id) ?? null,
            passed: row.passed,
            status: row.status,
            similarity: extractItemSimilarityScore(row.response_payload),
            confidence: extractItemValidatorConfidence(row.response_payload),
            elapsed_ms: row.elapsed_ms,
            model: modelTag ?? null,
            agent: extractRoutingDecision(row.response_payload),
            response_text: row.response_text,
            error_message: row.error_message,
            ideal_response: idealResponseByItemId.get(row.test_item_id) ?? null,
            expected_concepts:
              conceptExpectationsByItemId.get(row.test_item_id)
                ?.expected_concepts ?? null,
            minimum_concepts:
              conceptExpectationsByItemId.get(row.test_item_id)
                ?.minimum_concepts ?? null,
            expected_sources:
              conceptExpectationsByItemId.get(row.test_item_id)
                ?.expected_sources ?? null,
            should_cite:
              conceptExpectationsByItemId.get(row.test_item_id)?.should_cite ??
              null,
            timing: extractTimingBreakdown(row.response_payload),
            retrieved_document_chunks: extractRetrievedDocumentChunks(
              row.response_payload,
            ),
            response_payload: row.response_payload,
            created_at: row.created_at,
          };
        }),
      }
    : null;

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
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                  Run details
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                  {test.name}
                </h1>
                <TestRunNotesDisplay />
                <p className="mt-3 flex flex-wrap items-center gap-2 font-mono text-xs text-slate-600">
                  <span>Run id: {result.id}</span>
                  <PromptBundleVersionBadge summary={promptBundleVersionSummary} />
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button asChild size="sm" variant="outline">
                  <Link href={`/admin/tests/${test.id}`}>Back to test</Link>
                </Button>
                <TestRunNotesToolbarButton />
                <RunReportButton
                  enabled={isCompletedRunStatus(result.status)}
                  hasExistingReport={Boolean(result.report)}
                  runId={result.id}
                  testId={test.id}
                />
                {fullExportData ? (
                  <RunFullExportDownload
                    data={fullExportData}
                    fileBase={`${test.name}-run-${result.id}-full-export`}
                  />
                ) : null}
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
            erroredCount,
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
          similarityBuckets={similarityBuckets}
          similarityStatsData={similarityStatsData}
          similarityTrendData={similarityTrendData}
          slowOverTenSecondsCount={slowOverTenSecondsCount}
          totalItems={result.total_items}
        />

        <RunToolRoutingPanel report={toolRoutingReport} testId={test.id} />

        <RoutingAccuracyBoard
          ambiguousRates={ambiguousRates}
          comparisonReport={routingComparisonReport}
          confidenceDistribution={confidenceDistribution}
          hasRoutingInstrumentation={hasRoutingInstrumentation}
          keywordConfusionMatrix={keywordConfusionMatrix}
          llmConfusionMatrix={llmConfusionMatrix}
        />

        <RunInsightsPanel
          initialGeneratedAt={result.insights_generated_at}
          initialInsights={
            Array.isArray(result.insights)
              ? (result.insights as unknown as Insight[])
              : null
          }
          runId={result.id}
        />

        <section
          className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm"
          id="item-level-results"
        >
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-lg font-semibold text-slate-900">
                Item-level results
              </h2>
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 p-1">
                {(
                  [
                    {
                      value: 'all',
                      label: 'All',
                      count: chronologicalItems.length,
                    },
                    {
                      value: 'passed',
                      label: 'Passed',
                      count: chronologicalItems.filter((r) => r.passed).length,
                    },
                    {
                      value: 'failed',
                      label: 'Failed',
                      count: chronologicalItems.filter((r) => !r.passed).length,
                    },
                  ] as const
                ).map(({ value, label, count }) => (
                  <Link
                    key={value}
                    href={`?filter=${value}#item-level-results`}
                    className={`rounded-md px-3 py-1 text-sm font-medium transition-colors ${
                      activeFilter === value
                        ? 'bg-white text-slate-900 shadow-sm'
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {label}
                    <span
                      className={`ml-1.5 rounded-full px-1.5 py-0.5 text-xs ${
                        activeFilter === value
                          ? value === 'failed'
                            ? 'bg-red-100 text-red-700'
                            : value === 'passed'
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-slate-100 text-slate-600'
                          : 'bg-slate-200 text-slate-500'
                      }`}
                    >
                      {count}
                    </span>
                  </Link>
                ))}
              </div>
              <RunItemResultsCsvDownload
                fileBase={`${test.name}-run-${result.id}`}
                rows={itemLevelCsvRows}
              />
            </div>
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
                  <TableHead>Agent</TableHead>
                  <TableHead>Rounds | Cache | Elapsed</TableHead>
                  <TableHead>Message</TableHead>
                  <TableHead>Trace</TableHead>
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
                  chronologicalItems
                    .filter((row) =>
                      activeFilter === 'passed'
                        ? row.passed
                        : activeFilter === 'failed'
                          ? !row.passed
                          : true,
                    )
                    .map((row) => {
                      const expectedShouldAnswer =
                        expectedShouldAnswerByItemId.get(row.test_item_id) ??
                        null;
                      const itemPriority =
                        priorityByItemId.get(row.test_item_id) ?? null;
                      const rowWorkflowRunId =
                        workflowRunIdByResultItemId.get(row.id) ?? null;
                      const itemHistoryHref = `/admin/tests/${test.id}/items/${row.test_item_id}`;
                      return (
                        <TableRow id={`run-item-result-${row.id}`} key={row.id}>
                          {/* Row index and prompt are the *column* axis: this prompt over time.
                              They stay on item history — only the Trace column drills into this
                              single execution. */}
                          <TableCell>
                            <Link
                              className="text-sky-700 underline-offset-2 hover:underline"
                              href={itemHistoryHref}
                              title="This prompt's outcomes across every run"
                            >
                              {row.row_index}
                            </Link>
                          </TableCell>
                          <TableCell className="max-w-[420px] whitespace-normal text-xs text-slate-700">
                            {itemPriority !== null ? (
                              <Badge
                                className="mr-1.5 align-middle text-slate-500"
                                title={`Priority ${itemPriority} — lower = more important`}
                                variant="secondary"
                              >
                                P{itemPriority}
                              </Badge>
                            ) : null}
                            <Link
                              className="text-sky-700 underline-offset-2 hover:underline"
                              href={itemHistoryHref}
                              title="This prompt's outcomes across every run"
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
                              {formatExpectedShouldAnswerCell(
                                expectedShouldAnswer,
                              )}
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
                                rowWorkflowRunId || '',
                              ) || 'n/a'}
                            </Badge>
                          </TableCell>
                          <TableCell className="whitespace-nowrap">
                            <div className="flex flex-wrap items-center gap-1">
                              {(() => {
                                const agent = extractRoutingDecision(
                                  row.response_payload,
                                );
                                if (!agent)
                                  return (
                                    <span className="text-xs text-slate-400">
                                      —
                                    </span>
                                  );
                                const colorClass =
                                  getAgentBadgeClassName(agent);
                                return (
                                  <Badge className={colorClass} variant="outline">
                                    {agent}
                                  </Badge>
                                );
                              })()}
                              {/* B0-398 — per-item promptVersion chip (B0-393 hash). Absent
                                  entirely for pre-capture items rather than a placeholder. */}
                              {(() => {
                                const promptVersion = extractPromptVersion(
                                  row.response_payload,
                                );
                                if (!promptVersion) return null;
                                return (
                                  <Badge
                                    title={`promptVersion: ${promptVersion}`}
                                    variant="outline"
                                  >
                                    {shortHash(promptVersion)}
                                  </Badge>
                                );
                              })()}
                            </div>
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
                          {/* B0-419 — this cell is the *cell* axis: this one execution. The
                              retired "Docs" dialog is no longer needed, since B0-418 renders the
                              retrieved chunks on the trace itself. When no workflow run was
                              recorded, fall back to item history rather than 404 on a null id. */}
                          <TableCell>
                            <Button asChild size="sm" variant="outline">
                              <Link
                                href={
                                  rowWorkflowRunId
                                    ? `/admin/observability/${rowWorkflowRunId}`
                                    : itemHistoryHref
                                }
                                title={
                                  rowWorkflowRunId
                                    ? 'Full trace for this execution'
                                    : 'No workflow run was recorded for this execution — showing this prompt’s history instead'
                                }
                              >
                                View
                              </Link>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })
                )}
              </TableBody>
            </table>
          </div>
          <p className="mt-3 text-xs text-slate-500">
            {activeFilter === 'all' ? (
              <>
                Showing {Math.min(200, allResultItems.length)} of{' '}
                {allResultItems.length} item-level results from{' '}
                {formatDate(result.created_at)}.
              </>
            ) : (
              <>
                Showing{' '}
                {
                  chronologicalItems.filter((r) =>
                    activeFilter === 'passed' ? r.passed : !r.passed,
                  ).length
                }{' '}
                {activeFilter} results out of {allResultItems.length} total.
              </>
            )}
          </p>
        </section>
      </main>
    </div>
  );
}
