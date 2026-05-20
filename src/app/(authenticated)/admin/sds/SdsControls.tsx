'use client';

import { Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { formatDurationMmSs, formatEasternTimestamp } from '~/lib/utils/time';

import { runSdsAction, type SdsActionState } from './actions';
import type { SdsDashboardStatus, SdsIngestionRunMode } from './pipeline';

const initialState: SdsActionState = {
  ok: false,
  message: null,
  error: null,
  timestamp: 0,
  result: null,
};

const AUTO_REPEAT_MODES = ['embed-next'] as const;
type AutoRepeatMode = (typeof AUTO_REPEAT_MODES)[number];

function isAutoRepeatMode(value: string | undefined): value is AutoRepeatMode {
  return AUTO_REPEAT_MODES.includes(value as AutoRepeatMode);
}

function pendingCountForMode(
  _mode: AutoRepeatMode,
  status: SdsDashboardStatus,
): number {
  return status.totals.pendingChunks ?? 0;
}

function statusClasses(status: string) {
  if (status === 'ingested') {
    return 'bg-emerald-50 text-emerald-700';
  }
  if (status === 'failed') {
    return 'bg-rose-50 text-rose-700';
  }
  if (status === 'registered') {
    return 'bg-amber-50 text-amber-700';
  }
  return 'bg-slate-100 text-slate-700';
}

function formatIso(value: string | null) {
  if (!value) {
    return 'N/A';
  }

  return formatEasternTimestamp(value);
}

export function SdsControls({
  initialStatus,
}: {
  initialStatus: SdsDashboardStatus;
}) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(runSdsAction, initialState);
  const [batchSize, setBatchSize] = useState('2');
  const [activeMode, setActiveMode] = useState<SdsIngestionRunMode | null>(null);
  const [actionStartedAt, setActionStartedAt] = useState<number | null>(null);
  const [timerNow, setTimerNow] = useState(() => Date.now());
  const [autoRunMode, setAutoRunMode] = useState<AutoRepeatMode | null>(null);
  const [autoRunNextAt, setAutoRunNextAt] = useState<number | null>(null);
  const embedFormRef = useRef<HTMLFormElement>(null);

  const activeStatus = state.result?.status ?? initialStatus;

  // Refresh server-fetched stats every 2.5 min while ingestion is running
  useEffect(() => {
    if (!pending && autoRunMode === null) return;
    const interval = window.setInterval(() => router.refresh(), 150_000);
    return () => window.clearInterval(interval);
  }, [pending, autoRunMode, router]);

  const actionLabels: Record<SdsIngestionRunMode, string> = {
    'register-seed': 'Register discovered PDFs',
    'ingest-next': 'Ingest next batch',
    'ingest-all': 'Ingest all pending',
    'retry-failed': 'Retry failed files',
    'embed-next': 'Embed next batch',
    'embed-all': 'Embed all pending',
  };

  useEffect(() => {
    if (state.timestamp === 0) {
      return;
    }

    const description = `Completed at ${formatEasternTimestamp(state.timestamp)}.`;

    if (state.ok) {
      toast.success(state.message || 'SDS ingestion action completed.', { description });
    } else {
      toast.error(state.error || 'SDS ingestion action failed.', { description });
    }

    // Schedule next auto-run pass when an embedding action succeeds with work remaining.
    const completedMode = state.result?.mode;
    if (state.ok && isAutoRepeatMode(completedMode) && state.result?.status) {
      const remaining = pendingCountForMode(completedMode, state.result.status);
      if (remaining > 0) {
        setAutoRunMode(completedMode);
        setAutoRunNextAt(Date.now());
        return;
      }
    }
    setAutoRunMode(null);
    setAutoRunNextAt(null);
  }, [state]);

  // Tick every second while an action is running to update the elapsed timer.
  useEffect(() => {
    if (!pending) {
      return;
    }

    const interval = window.setInterval(() => {
      setTimerNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [pending]);

  // Fire the next auto-run pass immediately when triggered.
  useEffect(() => {
    if (autoRunNextAt === null || autoRunMode === null || pending) {
      return;
    }

    const delay = Math.max(0, autoRunNextAt - Date.now());
    const timer = window.setTimeout(() => {
      embedFormRef.current?.requestSubmit();
    }, delay);

    return () => {
      window.clearTimeout(timer);
    };
  }, [autoRunNextAt, autoRunMode, pending]);

  const currentElapsedMs =
    pending && actionStartedAt !== null
      ? Math.max(0, timerNow - actionStartedAt)
      : 0;

  const lastRunDurationMs =
    state.result?.startedAt && state.result?.finishedAt
      ? Math.max(
          0,
          Date.parse(state.result.finishedAt) - Date.parse(state.result.startedAt),
        )
      : null;

  const buttons: [SdsIngestionRunMode, string][] = [
    ['register-seed', 'Register discovered PDFs'],
    ['ingest-next', 'Ingest next batch'],
    ['ingest-all', 'Ingest all pending'],
    ['retry-failed', 'Retry failed files'],
    ['embed-next', 'Embed next batch'],
    ['embed-all', 'Embed all pending'],
  ];

  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.9fr)]">
      <section className="rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
          Ingestion controls
        </p>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-slate-950">
          Seed and process SDS PDFs
        </h2>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Discover and register S3 PDFs first, then ingest into `rag.document`
          and `rag.document_chunk`. Use embedding actions to fill vectors for
          SDS chunks, and retry for files that fail due to object access or
          parsing.
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
          {buttons.map(([mode, label]) => (
            <form
              action={formAction}
              className="flex"
              key={mode}
              ref={mode === 'embed-next' ? embedFormRef : undefined}
              onSubmit={() => {
                // Cancel scheduled auto-run when the user manually triggers any action.
                setAutoRunMode(null);
                setAutoRunNextAt(null);
                const startedAt = Date.now();
                setActiveMode(mode);
                setActionStartedAt(startedAt);
                setTimerNow(startedAt);
              }}
            >
              <input name="mode" type="hidden" value={mode} />
              <input name="batchSize" type="hidden" value={batchSize} />
              <Button
                className="h-11 w-full rounded-2xl px-4 font-semibold"
                disabled={pending}
                type="submit"
              >
                {pending ? (
                  <>
                    <Loader2 className="mr-2 size-4 animate-spin" />
                    Working...
                  </>
                ) : (
                  label
                )}
              </Button>
            </form>
          ))}
        </div>

        {pending ? (
          <div className="mt-6 flex items-center justify-between gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
            <div className="flex items-center gap-3">
              <Loader2 className="size-4 animate-spin" />
              <div>
                <p className="font-semibold">
                  {activeMode ? (actionLabels[activeMode] ?? activeMode) : 'SDS action'}
                </p>
                <p className="mt-0.5">
                  Elapsed: {formatDurationMmSs(currentElapsedMs)}
                </p>
              </div>
            </div>
            {autoRunMode !== null ? (
              <button
                className="rounded-xl bg-sky-100 px-3 py-1.5 text-xs font-semibold text-sky-900 hover:bg-sky-200"
                onClick={() => {
                  setAutoRunMode(null);
                  setAutoRunNextAt(null);
                }}
                type="button"
              >
                Stop auto
              </button>
            ) : null}
          </div>
        ) : autoRunMode !== null ? (
          <div className="mt-6 flex items-center justify-between gap-3 rounded-2xl border border-violet-200 bg-violet-50 p-4 text-sm text-violet-800">
            <div className="flex items-center gap-3">
              <Loader2 className="size-4 animate-spin" />
              <span>Auto-embed active &mdash; queuing next pass&hellip;</span>
            </div>
            <button
              className="rounded-xl bg-violet-100 px-3 py-1.5 text-xs font-semibold text-violet-800 hover:bg-violet-200"
              onClick={() => {
                setAutoRunMode(null);
                setAutoRunNextAt(null);
              }}
              type="button"
            >
              Stop
            </button>
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
            <p className="font-semibold">
              {state.ok ? state.message : state.error || 'Action failed.'}
            </p>
            {state.result ? (
              <p className="mt-2 text-xs">
                Processed {state.result.processed} • Succeeded{' '}
                {state.result.succeeded} • Failed {state.result.failed}
                {lastRunDurationMs !== null
                  ? ` • Duration ${formatDurationMmSs(lastRunDurationMs)}`
                  : ''}
              </p>
            ) : null}
            {state.result?.errors.length ? (
              <div className="mt-3 flex flex-col gap-2">
                {state.result.errors.map((item) => (
                  <p key={item.id}>
                    <span className="font-medium">{item.id}</span>:{' '}
                    {item.message}
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
        <div className="grid gap-4 md:grid-cols-3 xl:grid-cols-5">
          <article className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase text-slate-500">Seeded</p>
            <p className="mt-1 text-2xl font-semibold text-slate-950">
              {activeStatus.totals.seeded}
            </p>
          </article>
          <article className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase text-slate-500">Registered</p>
            <p className="mt-1 text-2xl font-semibold text-slate-950">
              {activeStatus.totals.registered}
            </p>
          </article>
          <article className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase text-slate-500">Ingested</p>
            <p className="mt-1 text-2xl font-semibold text-slate-950">
              {activeStatus.totals.ingested}
            </p>
          </article>
          <article className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase text-slate-500">Failed</p>
            <p className="mt-1 text-2xl font-semibold text-slate-950">
              {activeStatus.totals.failed}
            </p>
          </article>
          <article className="rounded-2xl bg-slate-50 p-4">
            <p className="text-xs font-medium uppercase text-slate-500">
              Embedded
            </p>
            <p className="mt-1 text-2xl font-semibold text-slate-950">
              {activeStatus.totals.embeddedChunks}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {activeStatus.totals.pendingChunks} pending
            </p>
          </article>
        </div>

        {activeStatus.preview.hidden > 0 ? (
          <p className="mt-4 text-xs text-slate-500">
            Showing {activeStatus.preview.showing} rows.{' '}
            {activeStatus.preview.hidden} additional SDS documents are hidden
            from this table preview.
          </p>
        ) : null}

        <div className="mt-5 max-h-[520px] overflow-auto rounded-2xl border border-slate-200">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="sticky top-0 bg-slate-50 text-xs uppercase tracking-wide text-slate-600">
              <tr>
                <th className="px-4 py-3 font-medium">SDS doc</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3 font-medium">Locale</th>
                <th className="px-4 py-3 font-medium">Chunks</th>
                <th className="px-4 py-3 font-medium">Last update</th>
              </tr>
            </thead>
            <tbody>
              {activeStatus.documents.map((row) => (
                <tr className="border-t border-slate-100" key={row.id}>
                  <td className="px-4 py-3 align-top">
                    <p className="font-medium text-slate-900">{row.title}</p>
                    <p className="mt-1 font-mono text-xs text-slate-500">
                      {row.s3Key}
                    </p>
                    {row.lastError ? (
                      <p className="mt-2 text-xs text-rose-700">{row.lastError}</p>
                    ) : null}
                  </td>
                  <td className="px-4 py-3 align-top">
                    <span
                      className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${statusClasses(row.status)}`}
                    >
                      {row.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 align-top text-slate-700">
                    {row.locale}
                  </td>
                  <td className="px-4 py-3 align-top text-slate-700">
                    {row.chunkCount}
                  </td>
                  <td className="px-4 py-3 align-top text-slate-700">
                    {formatIso(row.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
