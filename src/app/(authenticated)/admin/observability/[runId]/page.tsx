import Link from 'next/link';
import { connection } from 'next/server';

import { HarnessVerdictBand } from '~/components/admin/observability/HarnessVerdictBand';
import { PromptHistoryStrip } from '~/components/admin/observability/PromptHistoryStrip';
import { RunAttributionBadge } from '~/components/admin/observability/RunAttributionBadge';
import { RunAnswerPanel } from '~/components/admin/observability/RunAnswerPanel';
import { RunInsightsProvider } from '~/components/admin/observability/run-insights-context';
import { RunPayloadSummary } from '~/components/admin/observability/RunPayloadSummary';
import { RunPromptInsightsPanel } from '~/components/admin/observability/RunPromptInsightsPanel';
import { RunRetrievedChunksPanel } from '~/components/admin/observability/RunRetrievedChunksPanel';
import { RunTraceExportButton } from '~/components/admin/observability/RunTraceExportButton';
import { RunTraceTimeline } from '~/components/admin/observability/RunTraceTimeline';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { getAgentBadgeClassName } from '~/lib/bex/agent-badge';
import { getHarnessContextForRun } from '~/lib/observability/harness-linkage';
import {
  EMPTY_PROMPT_HISTORY,
  getPromptHistoryForItem,
} from '~/lib/observability/prompt-history';
import { readRunPayloadView } from '~/lib/observability/run-payload';
import {
  getWorkflowRunTrace,
  indexHarnessTtftByRunIds,
  readTtftMs,
} from '~/lib/observability/runs-repository';
import { getProdLineIdsByProductLineKeys } from '~/lib/rag/product-line-lookup';
import {
  extractPromptBundleVersion,
  extractPromptVersion,
} from '~/lib/tests/response-payload';
import {
  formatDurationSeconds,
  formatEasternTimestamp,
  formatShortDate,
} from '~/lib/utils/time';
import { shortHash } from '~/lib/workflows/product-support/prompt-version';

export const metadata = {
  title: 'Run Trace | Betco BEX',
  description: 'Single workflow run trace: steps, tool calls, and confidence gates.',
};

type PageProps = {
  params: Promise<{ runId: string }>;
};

function readStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.trim() ? field.trim() : null;
}

function statusBadgeClassName(status: string): string {
  switch (status) {
    case 'completed':
      return 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900';
    case 'failed':
      return 'border-destructive/45 bg-destructive/10 text-destructive';
    default:
      return 'border-amber-600/45 bg-amber-600/12 text-amber-900';
  }
}

function durationMsBetween(from: string, to: string): number | null {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  const delta = end - start;
  return delta >= 0 ? delta : null;
}

export default async function AdminRunTracePage({ params }: PageProps) {
  await connection();
  const { runId } = await params;

  let trace: Awaited<ReturnType<typeof getWorkflowRunTrace>> = null;
  let loadError: string | null = null;
  /**
   * B0-419 — the harness execution this run belongs to, or null for a live Bex chat run, a direct
   * orchestrator call, or a run whose test data was deleted. Resolved alongside the trace;
   * `getHarnessContextForRun` never throws, so it can never become this page's `loadError`.
   */
  let harness: Awaited<ReturnType<typeof getHarnessContextForRun>> = null;

  try {
    const [traceResult, harnessResult] = await Promise.all([
      getWorkflowRunTrace(runId),
      getHarnessContextForRun(runId),
    ]);
    trace = traceResult;
    harness = harnessResult;
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : 'Unable to load this workflow run trace. If this persists, apply the latest Supabase migration.';
  }

  /**
   * B0-399 — state #2 ("The workflow record for this item has been deleted."). Previously this
   * called the framework's bare `notFound()`, which renders the generic not-found page instead of
   * a message explaining *why* — a run id can 404 here because the row was deleted (e.g. via
   * "Delete run" on the test page), not because the URL is malformed.
   */
  const runRecordDeleted = !loadError && !trace;

  const run = trace?.run ?? null;
  const routingDecision = readStringField(run?.final_output, 'routingDecision');
  const userMessage = readStringField(run?.user_input, 'message');
  // B0-463 — run-level prompt stamps (B0-393), for the "view persisted prompts" UI.
  const promptVersion = extractPromptVersion(run?.final_output);
  const promptBundleVersion = extractPromptBundleVersion(run?.final_output);
  const totalDurationMs = run ? durationMsBetween(run.created_at, run.updated_at) : null;
  /**
   * B0-473 — same precedence as the dashboard's avg-TTFT tile (B0-430) and the runs list "Stream"
   * column (B0-416/B0-428): prefer the run's own `timingBreakdown.ttftMs`, falling back to the
   * harness's `test_result_items.ttft_ms` only when the run predates that instrumentation. The
   * harness lookup is a real query, so it's skipped entirely once the run's own value is present.
   */
  const ttftMs =
    readTtftMs(run?.final_output) ??
    (run ? (await indexHarnessTtftByRunIds([runId])).get(runId) ?? null : null);
  // B0-418 — the run's own payload (answer, chunks, similarity, timing, validation,
  // usage). Tolerates a null `final_output` and error-only payloads.
  const payload = readRunPayloadView(run?.final_output, run?.user_input);
  /**
   * B0-455 — legacy ERP product-line codes ("H610") for every distinct `product_line_key`
   * on this run's retrieved chunks, for the "Product line id" column on the chunks panel.
   * Admin-display lookup only — see `~/lib/rag/product-line-lookup`.
   */
  const prodLineIdByProductLineKey = await getProdLineIdsByProductLineKeys(
    [...new Set(payload.chunks.map((c) => c.product_line_key).filter((v): v is string => Boolean(v)))],
  );
  /**
   * B0-421 — where this cell sits in its column: the prompt's recent pass/fail outcomes. Necessarily
   * sequential, since the prompt's identity only exists once the harness lookup has resolved, and
   * skipped entirely for runs that belong to no grid. `getPromptHistoryForItem` is bounded (a
   * 10-row window plus two count-only queries) and never throws.
   */
  const promptHistory = harness
    ? await getPromptHistoryForItem(harness.testItemId)
    : EMPTY_PROMPT_HISTORY;

  return (
    <RunInsightsProvider>
      <div className="flex flex-1 bg-slate-50">
        <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
          {/* Header */}
          <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
                  Prompt observability
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
                  Run trace
                </h1>
                <p className="mt-2 break-all font-mono text-xs text-slate-500">{runId}</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {trace ? <RunTraceExportButton runId={runId} /> : null}
                {/* B0-419 — navigate up both axes of the grid this cell sits in: the run it was
                    part of, and the prompt's history across runs. Harness runs only. */}
                {harness ? (
                  <>
                    <Button asChild size="sm" variant="outline">
                      <Link
                        href={`/admin/tests/${harness.testId}/runs/${harness.testResultId}#item-level-results`}
                        title="Back to every prompt in this test run"
                      >
                        ↑ Run{' '}
                        {harness.runStartedAt
                          ? formatShortDate(harness.runStartedAt)
                          : 'results'}
                      </Link>
                    </Button>
                    <Button asChild size="sm" variant="outline">
                      <Link
                        href={`/admin/tests/${harness.testId}/items/${harness.testItemId}`}
                        title="This prompt's outcomes across every run"
                      >
                        ↑ Prompt #{harness.rowIndex} history
                      </Link>
                    </Button>
                  </>
                ) : null}
                <Button asChild size="sm" variant="outline">
                  <Link href="/admin/observability">All runs</Link>
                </Button>
              </div>
            </div>

            {run ? (
              <>
                <div className="mt-6 flex flex-wrap items-center gap-2">
                  <Badge className={statusBadgeClassName(run.status)} variant="outline">
                    {run.status}
                  </Badge>
                  <Badge variant="outline">{run.workflow_name}</Badge>
                  {routingDecision ? (
                    <Badge className={getAgentBadgeClassName(routingDecision)} variant="outline">
                      {routingDecision}
                    </Badge>
                  ) : null}
                  <Badge className="tabular-nums" variant="outline">
                    confidence{' '}
                    {typeof run.confidence === 'number' ? run.confidence.toFixed(2) : 'n/a'}
                  </Badge>
                  <Badge className="tabular-nums" variant="outline">
                    {formatDurationSeconds(totalDurationMs)}
                  </Badge>
                  {/* B0-473 — time to first streamed token, same precedence as the dashboard's
                      avg-TTFT tile and the runs list "Stream" column. */}
                  <Badge
                    className="tabular-nums"
                    title="Time to first token"
                    variant="outline"
                  >
                    TTFT {formatDurationSeconds(ttftMs)}
                  </Badge>
                  {/* B0-463 — run-level prompt stamps, visible without expanding the timeline. */}
                  {promptVersion ? (
                    <Badge
                      className="font-mono"
                      title={`promptVersion (specialist prompt): ${promptVersion}`}
                      variant="outline"
                    >
                      prompt {shortHash(promptVersion)}
                    </Badge>
                  ) : null}
                  {promptBundleVersion ? (
                    <Badge
                      className="font-mono"
                      title={`promptBundleVersion (prompt + tool bundle): ${promptBundleVersion}`}
                      variant="outline"
                    >
                      bundle {shortHash(promptBundleVersion)}
                    </Badge>
                  ) : null}
                </div>

                <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-4">
                  <div className="flex flex-col gap-0.5">
                    {/* B0-338 — who asked for this run. */}
                    <dt className="text-xs uppercase tracking-wide text-slate-500">Asked by</dt>
                    <dd className="text-sm">
                      <RunAttributionBadge attribution={trace?.attribution ?? { kind: 'unknown' }} />
                    </dd>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-xs uppercase tracking-wide text-slate-500">Created</dt>
                    <dd className="font-mono text-xs text-slate-800">
                      {formatEasternTimestamp(run.created_at)}
                    </dd>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-xs uppercase tracking-wide text-slate-500">Updated</dt>
                    <dd className="font-mono text-xs text-slate-800">
                      {formatEasternTimestamp(run.updated_at)}
                    </dd>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    <dt className="text-xs uppercase tracking-wide text-slate-500">
                      Conversation
                    </dt>
                    <dd className="break-all font-mono text-xs">
                      {run.conversation_id ? (
                        <Link
                          href={`/admin/bex?conversationId=${encodeURIComponent(run.conversation_id)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:text-blue-800 hover:underline"
                        >
                          {run.conversation_id}
                        </Link>
                      ) : (
                        <span className="text-slate-500">—</span>
                      )}
                    </dd>
                  </div>
                </dl>

                <RunPayloadSummary payload={payload} />

                <div className="mt-4 rounded-2xl border border-slate-100 bg-slate-50/70 p-4">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                    User message
                  </p>
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-sm text-slate-800">
                    {userMessage ?? '—'}
                  </p>
                </div>
              </>
            ) : null}
          </section>

          {/* Harness verdict — additional context when this run came from /admin/tests, absent
              entirely otherwise. */}
          {harness ? (
            <HarnessVerdictBand
              answerText={payload.answerText}
              context={harness}
            />
          ) : null}

          {/* B0-421 — lateral navigation along the column: does this prompt always fail? Renders
              itself as null when the prompt has no recorded outcomes. */}
          {harness ? (
            <PromptHistoryStrip
              currentResultItemId={harness.resultItemId}
              history={promptHistory}
              rowIndex={harness.rowIndex}
              testId={harness.testId}
              testItemId={harness.testItemId}
            />
          ) : null}

          {loadError ? (
            <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
              {loadError}
            </section>
          ) : null}

          {/* B0-399 — state #2: the run id resolved to no row (deleted), as opposed to a load
              error or a malformed id. */}
          {runRecordDeleted ? (
            <section className="rounded-3xl border border-slate-200 bg-white p-6 text-sm text-slate-600">
              The workflow record for this item has been deleted.
            </section>
          ) : null}

          {/* Answer — read the thing being evaluated before anything else.
              On a harness run the verdict band above already shows the answer, beside the
              ideal response it is being judged against, so this panel would render the same
              text a second time. Live and orphan runs have no band and keep it. */}
          {trace && !harness ? (
            <RunAnswerPanel answerText={payload.answerText} error={payload.error} />
          ) : null}

          {/* AI analysis — on-demand, so it renders as soon as the run resolves. */}
          {trace ? <RunPromptInsightsPanel runId={runId} /> : null}

          {/* Timeline */}
          {trace ? (
            <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
              <div className="mb-6 flex flex-wrap items-center gap-3">
                <h2 className="text-lg font-semibold text-slate-900">Timeline</h2>
                <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-sm font-medium text-slate-500">
                  {trace.timeline.length}
                </span>
              </div>
              <RunTraceTimeline
                emptyState={trace.emptyState}
                events={trace.timeline}
                promptBundleVersion={promptBundleVersion}
                promptVersion={promptVersion}
              />
            </section>
          ) : null}

          {/* Retrieved chunks — collapsed by default; the bulkiest section on the page. */}
          {trace ? (
            <RunRetrievedChunksPanel
              chunks={payload.chunks}
              prodLineIdByProductLineKey={Object.fromEntries(prodLineIdByProductLineKey)}
            />
          ) : null}
        </main>
      </div>
    </RunInsightsProvider>
  );
}
