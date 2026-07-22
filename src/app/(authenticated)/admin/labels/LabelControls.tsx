'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { formatDurationMmSs, formatEasternTimestamp } from '~/lib/utils/time';

import { runLabelAction, type LabelActionState } from './actions';
import type { LabelDashboardStatus, LabelIngestionRunMode } from './pipeline';

const initialState: LabelActionState = {
  ok: false,
  message: null,
  error: null,
  timestamp: 0,
  result: null,
};

const BUTTONS: [LabelIngestionRunMode, string][] = [
  ['register-seed', 'Register discovered files'],
  ['ingest-next', 'Ingest next batch'],
  ['ingest-all', 'Ingest all pending'],
  ['retry-failed', 'Retry failed files'],
  ['embed-next', 'Embed next batch'],
  ['embed-all', 'Embed all pending'],
];

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
  const [batchSize, setBatchSize] = useState('25');
  const [activeMode, setActiveMode] = useState<LabelIngestionRunMode | null>(null);
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const activeStatus = state.result?.status ?? initialStatus;

  useEffect(() => {
    if (!pending) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [pending]);

  useEffect(() => {
    if (!pending && activeMode) {
      const refresh = window.setTimeout(() => router.refresh(), 250);
      return () => window.clearTimeout(refresh);
    }
  }, [pending, activeMode, router]);

  useEffect(() => {
    if (state.timestamp === 0) return;
    const description = `Completed at ${formatEasternTimestamp(state.timestamp)}.`;
    if (state.ok) toast.success(state.message ?? 'Action completed.', { description });
    else toast.error(state.error ?? 'Action failed.', { description });
  }, [state]);

  const elapsedMs = pending && startedAt !== null ? Math.max(0, now - startedAt) : 0;
  const lastRunMs =
    state.result?.startedAt && state.result?.finishedAt
      ? Math.max(0, Date.parse(state.result.finishedAt) - Date.parse(state.result.startedAt))
      : null;

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)]">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
          Ingestion controls
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
          Seed and process product label markdown
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Register discovered `.md` label files first, then ingest (parse
          frontmatter + heading-aware chunk) into `rag.document` /
          `rag.document_chunk`, and embed to fill vectors. Documents are
          linked to `rag.entity` (SKU-based Path B bootstrap) when a match
          exists. Retry re-runs files that failed on S3 access or parsing.
        </p>

        <div className="mt-6 flex flex-col gap-2">
          <Label className="text-sm font-medium text-slate-700">Batch size</Label>
          <Input
            className="h-11 rounded-2xl px-4"
            min={1}
            onChange={(event) => setBatchSize(event.target.value)}
            type="number"
            value={batchSize}
          />
        </div>

        <div className="mt-6 grid gap-3">
          {BUTTONS.map(([mode, label]) => (
            <form
              action={formAction}
              className="flex"
              key={mode}
              onSubmit={() => {
                setActiveMode(mode);
                setStartedAt(Date.now());
                setNow(Date.now());
              }}
            >
              <input name="mode" type="hidden" value={mode} />
              <input name="batchSize" type="hidden" value={batchSize} />
              <Button className="h-11 w-full rounded-2xl px-4 font-semibold" disabled={pending} type="submit">
                {pending && activeMode === mode ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Working…
                  </>
                ) : (
                  label
                )}
              </Button>
            </form>
          ))}
        </div>

        {pending ? (
          <div className="mt-6 flex items-center gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
            <Loader2 className="size-4 animate-spin" />
            <span>Elapsed: {formatDurationMmSs(elapsedMs)}</span>
          </div>
        ) : null}

        {state.timestamp > 0 ? (
          <div
            className={`mt-6 rounded-2xl border p-4 text-sm ${
              state.ok
                ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
                : 'border-rose-200 bg-rose-50 text-rose-800'
            }`}
          >
            <p className="font-semibold">{state.ok ? state.message : state.error ?? 'Action failed.'}</p>
            {state.result ? (
              <p className="mt-2 text-xs">
                Processed {state.result.processed} • Succeeded {state.result.succeeded} • Failed{' '}
                {state.result.failed}
                {lastRunMs !== null ? ` • Duration ${formatDurationMmSs(lastRunMs)}` : ''}
              </p>
            ) : null}
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
        {activeStatus.warning ? (
          <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {activeStatus.warning}
          </div>
        ) : null}
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-6">
          {[
            ['Seeded', activeStatus.totals.seeded],
            ['Registered', activeStatus.totals.registered],
            ['Ingested', activeStatus.totals.ingested],
            ['Failed', activeStatus.totals.failed],
            ['Linked to entity', activeStatus.totals.linkedToEntity],
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
                <th className="px-4 py-3 font-medium">Last update</th>
              </tr>
            </thead>
            <tbody>
              {activeStatus.documents.map((row) => (
                <tr className="border-t border-slate-100" key={row.id}>
                  <td className="px-4 py-3 align-top">
                    <p className="font-medium text-slate-900">{row.title}</p>
                    <p className="mt-1 font-mono text-xs text-slate-500">{row.s3Key}</p>
                    {row.lastError ? <p className="mt-2 text-xs text-rose-700">{row.lastError}</p> : null}
                  </td>
                  <td className="px-4 py-3 align-top text-slate-700">{row.brand}</td>
                  <td className="px-4 py-3 align-top font-mono text-xs text-slate-700">{row.sku ?? '—'}</td>
                  <td className="px-4 py-3 align-top">
                    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusClasses(row.status)}`}>
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 align-top text-slate-700">{row.chunkCount}</td>
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
