'use client';

import { CheckCircle2, Loader2, PlayCircle, StopCircle } from 'lucide-react';

import { SourceFileLink } from '~/components/admin/rag/SourceFileLink';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '~/components/ui/button';
import { formatEasternTimestamp } from '~/lib/utils/time';

import { runLabelAction, type LabelActionState } from './actions';
import type { LabelDashboardStatus } from './pipeline';

const initialState: LabelActionState = {
  ok: false,
  message: null,
  error: null,
  timestamp: 0,
  result: null,
};

function StepNumber({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sm font-semibold text-sky-700">
      {children}
    </span>
  );
}

function statusClasses(status: string) {
  if (status === 'ingested') return 'bg-emerald-50 text-emerald-700';
  if (status === 'failed') return 'bg-rose-50 text-rose-700';
  if (status === 'registered') return 'bg-amber-50 text-amber-700';
  return 'bg-slate-100 text-slate-700';
}

function formatIso(value: string | null) {
  return value ? formatEasternTimestamp(value) : 'N/A';
}

export function LabelControls({ initialStatus }: { initialStatus: LabelDashboardStatus }) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(runLabelAction, initialState);
  const [activeMode, setActiveMode] = useState<string | null>(null);
  const [autoEmbedding, setAutoEmbedding] = useState(false);
  const [autoEmbedNextAt, setAutoEmbedNextAt] = useState<number | null>(null);
  const embedFormRef = useRef<HTMLFormElement>(null);

  const activeStatus = state.result?.status ?? initialStatus;

  const embedProgressPct =
    activeStatus.totals.chunks > 0
      ? Math.min(
          100,
          Math.round((activeStatus.totals.embeddedChunks / activeStatus.totals.chunks) * 100),
        )
      : 0;
  const embedIsDone =
    activeStatus.totals.chunks > 0 && activeStatus.totals.pendingChunks === 0;

  // Toast + auto-continue embedding while chunks remain.
  useEffect(() => {
    if (state.timestamp === 0) return;

    const description = `Completed at ${formatEasternTimestamp(state.timestamp)}.`;
    if (state.ok) {
      toast.success(state.message ?? 'Action completed.', { description });
    } else {
      toast.error(state.error ?? 'Action failed.', { description });
      setAutoEmbedding(false);
      setAutoEmbedNextAt(null);
      return;
    }

    if (state.result?.mode === 'embed-all' && state.result.status.totals.pendingChunks > 0) {
      setAutoEmbedding(true);
      setAutoEmbedNextAt(Date.now());
    } else {
      setAutoEmbedding(false);
      setAutoEmbedNextAt(null);
    }
  }, [state]);

  // Refresh server-fetched stats periodically while work is running.
  useEffect(() => {
    if (!pending && !autoEmbedding) return;
    const interval = window.setInterval(() => router.refresh(), 150_000);
    return () => window.clearInterval(interval);
  }, [pending, autoEmbedding, router]);

  // Fire the next embed pass when auto-embedding.
  useEffect(() => {
    if (autoEmbedNextAt === null || !autoEmbedding || pending) return;
    const delay = Math.max(0, autoEmbedNextAt - Date.now());
    const timer = window.setTimeout(() => embedFormRef.current?.requestSubmit(), delay);
    return () => window.clearTimeout(timer);
  }, [autoEmbedNextAt, autoEmbedding, pending]);

  function stopEmbedding() {
    setAutoEmbedding(false);
    setAutoEmbedNextAt(null);
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
          Ingestion pipeline
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
          Get product label markdown from S3 into Bex
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
          Three steps, run in order. Each one only processes what the previous step
          left behind, so it&apos;s safe to run a step again — it just won&apos;t find
          any new work to do.
        </p>

        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-3">
          {/* Step 1 — Register */}
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="flex flex-col items-center gap-1">
              <StepNumber>1</StepNumber>
              <h3 className="text-lg font-semibold text-slate-950">Register discovered files</h3>
              <p className="text-xs text-slate-500">
                {activeStatus.totals.registered.toLocaleString()} /{' '}
                {activeStatus.totals.seeded.toLocaleString()} files registered
              </p>
            </div>
            <p className="text-center text-sm leading-6 text-slate-600">
              Scans the S3 label folder for `.md` files Bex doesn&apos;t already know
              about and creates a record for each new one. Files that are already
              registered are skipped, so this is safe to run anytime.
            </p>
            <form action={formAction} onSubmit={() => setActiveMode('register-seed')}>
              <input name="mode" type="hidden" value="register-seed" />
              <Button className="h-11 rounded-2xl px-5 font-semibold" disabled={pending} type="submit">
                {pending && activeMode === 'register-seed' ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Registering…
                  </>
                ) : (
                  'Register new files'
                )}
              </Button>
            </form>
          </div>

          {/* Step 2 — Ingest */}
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="flex flex-col items-center gap-1">
              <StepNumber>2</StepNumber>
              <h3 className="text-lg font-semibold text-slate-950">Ingest registered files</h3>
              <p className="text-center text-xs text-slate-500">
                {activeStatus.totals.ingested.toLocaleString()} /{' '}
                {activeStatus.totals.registered.toLocaleString()} ingested
                {activeStatus.totals.failed > 0 ? (
                  <span className="text-rose-600">
                    {' '}· {activeStatus.totals.failed.toLocaleString()} failed
                  </span>
                ) : null}
              </p>
            </div>
            <p className="text-center text-sm leading-6 text-slate-600">
              Downloads every registered file, reads its frontmatter, and saves it as a
              searchable document — splitting it into heading-aware sections and linking
              it to a product (by SKU) when a match exists. Also re-ingests any file
              whose S3 master changed since last time, so it&apos;s safe to re-run.
            </p>
            <div className="flex flex-wrap justify-center gap-3">
              <form action={formAction} onSubmit={() => setActiveMode('ingest-all')}>
                <input name="mode" type="hidden" value="ingest-all" />
                <Button className="h-11 rounded-2xl px-5 font-semibold" disabled={pending} type="submit">
                  {pending && activeMode === 'ingest-all' ? (
                    <>
                      <Loader2 className="mr-2 size-4 animate-spin" />
                      Ingesting…
                    </>
                  ) : (
                    'Ingest all pending'
                  )}
                </Button>
              </form>
              {activeStatus.totals.failed > 0 ? (
                <form action={formAction} onSubmit={() => setActiveMode('retry-failed')}>
                  <input name="mode" type="hidden" value="retry-failed" />
                  <Button
                    className="h-11 rounded-2xl px-5 font-semibold"
                    disabled={pending}
                    type="submit"
                    variant="outline"
                  >
                    {pending && activeMode === 'retry-failed' ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Retrying…
                      </>
                    ) : (
                      `Retry ${activeStatus.totals.failed.toLocaleString()} failed file${activeStatus.totals.failed === 1 ? '' : 's'}`
                    )}
                  </Button>
                </form>
              ) : null}
            </div>
          </div>

          {/* Step 3 — Embed */}
          <div className="flex flex-col items-center gap-3 py-6">
            <div className="flex flex-col items-center gap-1">
              <StepNumber>3</StepNumber>
              <h3 className="text-lg font-semibold text-slate-950">Embed chunks</h3>
              <div className="flex items-center gap-2 text-xs text-slate-600">
                <span>
                  {embedIsDone
                    ? 'All chunks embedded'
                    : `${activeStatus.totals.embeddedChunks.toLocaleString()} / ${activeStatus.totals.chunks.toLocaleString()} chunks embedded`}
                </span>
                <span className="text-slate-400">{embedProgressPct}%</span>
              </div>
            </div>
            <p className="text-center text-sm leading-6 text-slate-600">
              Turns each chunk&apos;s text into a vector so Bex can find it by meaning,
              not just exact keywords. Keeps running automatically — in batches behind
              the scenes — until every chunk has one.
            </p>

            <div className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full transition-all duration-500 ${
                  embedIsDone ? 'bg-emerald-500' : 'bg-sky-500'
                }`}
                style={{ width: `${embedIsDone ? 100 : embedProgressPct}%` }}
              />
            </div>

            <div className="flex flex-wrap items-center justify-center gap-3">
              {embedIsDone ? (
                <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-2.5 text-sm font-semibold text-emerald-700">
                  <CheckCircle2 className="size-4" />
                  All chunks embedded
                </div>
              ) : (
                <form action={formAction} onSubmit={() => setActiveMode('embed-all')} ref={embedFormRef}>
                  <input name="mode" type="hidden" value="embed-all" />
                  <Button className="h-11 gap-2 rounded-2xl px-5 font-semibold" disabled={pending} type="submit">
                    {pending && activeMode === 'embed-all' ? (
                      <>
                        <Loader2 className="mr-2 size-4 animate-spin" />
                        Embedding…
                      </>
                    ) : (
                      <>
                        <PlayCircle className="size-4" />
                        Embed all pending
                      </>
                    )}
                  </Button>
                </form>
              )}

              {autoEmbedding ? (
                <Button
                  className="h-11 gap-2 rounded-2xl px-5 font-semibold"
                  onClick={stopEmbedding}
                  type="button"
                  variant="outline"
                >
                  <StopCircle className="size-4" />
                  Stop after this batch
                </Button>
              ) : null}

              {autoEmbedding && !pending ? (
                <div className="flex items-center gap-2 text-sm text-slate-600">
                  <Loader2 className="size-4 animate-spin" />
                  Queuing next batch…
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {state.timestamp > 0 ? (
          <div
            className={`mt-6 rounded-2xl border p-4 text-sm ${
              state.ok
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-rose-200 bg-rose-50 text-rose-800'
            }`}
          >
            <p className="font-semibold">{state.ok ? state.message : state.error ?? 'Action failed.'}</p>
            {state.result?.errors.length ? (
              <div className="mt-3 flex flex-col gap-2">
                {state.result.errors.map((item) => (
                  <p key={item.id}>
                    <span className="font-medium">{item.id}</span>: {item.message}
                  </p>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">Documents</p>

        {activeStatus.warning ? (
          <div className="mt-4 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
            {activeStatus.warning}
          </div>
        ) : null}

        <div className="mt-4 grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          {[
            ['Seeded', activeStatus.totals.seeded],
            ['Registered', activeStatus.totals.registered],
            ['Ingested', activeStatus.totals.ingested],
            ['Failed', activeStatus.totals.failed],
            ['Linked to entity', activeStatus.totals.linkedToEntity],
            ['Changed since ingest', activeStatus.totals.changed],
            ['Needs review', activeStatus.totals.needsReview],
          ].map(([label, value]) => (
            <article className="rounded-2xl bg-slate-50 p-4" key={label}>
              <p className="text-xs font-medium uppercase text-slate-500">{label}</p>
              <p className="mt-1 text-2xl font-semibold text-slate-950">{value}</p>
            </article>
          ))}
          <article className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase text-slate-500">Embedded</p>
            <p className="mt-1 text-2xl font-semibold text-slate-950">{activeStatus.totals.embeddedChunks}</p>
            <p className="mt-1 text-xs text-slate-500">{activeStatus.totals.pendingChunks} pending</p>
          </article>
        </div>

        {activeStatus.preview.hidden > 0 ? (
          <p className="mt-4 text-xs text-slate-500">
            Showing {activeStatus.preview.showing} rows. {activeStatus.preview.hidden} more hidden.
          </p>
        ) : null}

        <div className="mt-5 max-h-[520px] overflow-auto rounded-2xl border border-slate-200">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-4 py-3 font-medium">Document</th>
                <th className="px-4 py-3 font-medium">Brand</th>
                <th className="px-4 py-3 font-medium">SKU</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Chunks</th>
                <th className="px-4 py-3 font-medium">Tokens</th>
                <th className="px-4 py-3 font-medium">Last update</th>
              </tr>
            </thead>
            <tbody>
              {activeStatus.documents.map((row) => (
                <tr className="border-t border-slate-100" key={row.id}>
                  <td className="px-4 py-3 align-top">
                    <p className="font-medium text-slate-900">{row.title}</p>
                    <p className="mt-1"><SourceFileLink corpus="label" s3Key={row.s3Key} /></p>
                    {row.lastError ? <p className="mt-2 text-xs text-rose-700">{row.lastError}</p> : null}
                  </td>
                  <td className="px-4 py-3 align-top text-slate-700">{row.brand}</td>
                  <td className="px-4 py-3 align-top font-mono text-xs text-slate-700">{row.sku ?? '—'}</td>
                  <td className="px-4 py-3 align-top">
                    <div className="flex flex-wrap gap-1.5">
                      <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusClasses(row.status)}`}>
                        {row.status}
                      </span>
                      {row.needsResync ? (
                        <span className="inline-flex rounded-full bg-sky-50 px-2.5 py-1 text-xs font-medium text-sky-700">
                          changed on S3
                        </span>
                      ) : null}
                      {row.needsReview ? (
                        <span className="inline-flex rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
                          needs review
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 align-top text-slate-700">{row.chunkCount}</td>
                  <td className="px-4 py-3 align-top text-slate-700">{row.tokenCount?.toLocaleString() ?? '—'}</td>
                  <td className="px-4 py-3 align-top text-slate-700">{formatIso(row.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
