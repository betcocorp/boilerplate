import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';

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
import { readRunPayloadView } from '~/lib/observability/run-payload';
import { getWorkflowRunTrace } from '~/lib/observability/runs-repository';
import { formatDurationSeconds, formatEasternTimestamp } from '~/lib/utils/time';

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

  try {
    trace = await getWorkflowRunTrace(runId);
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : 'Unable to load this workflow run trace. If this persists, apply the latest Supabase migration.';
  }

  // `notFound()` throws, so it must stay outside the try/catch above.
  if (!loadError && !trace) {
    notFound();
  }

  const run = trace?.run ?? null;
  const routingDecision = readStringField(run?.final_output, 'routingDecision');
  const userMessage = readStringField(run?.user_input, 'message');
  const totalDurationMs = run ? durationMsBetween(run.created_at, run.updated_at) : null;
  // B0-418 — the run's own payload (answer, chunks, similarity, timing, validation,
  // usage). Tolerates a null `final_output` and error-only payloads.
  const payload = readRunPayloadView(run?.final_output, run?.user_input);

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
                </div>

                <dl className="mt-6 grid gap-3 text-sm sm:grid-cols-3">
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
                    <dd className="break-all font-mono text-xs text-slate-800">
                      {run.conversation_id}
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

          {loadError ? (
            <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
              {loadError}
            </section>
          ) : null}

          {/* Answer — read the thing being evaluated before anything else. */}
          {trace ? (
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
              <RunTraceTimeline events={trace.timeline} />
            </section>
          ) : null}

          {/* Retrieved chunks — collapsed by default; the bulkiest section on the page. */}
          {trace ? <RunRetrievedChunksPanel chunks={payload.chunks} /> : null}
        </main>
      </div>
    </RunInsightsProvider>
  );
}
