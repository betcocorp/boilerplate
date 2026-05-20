'use client';

import { CheckCircle2, Loader2, PlayCircle, StopCircle } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

import { Button } from '~/components/ui/button';
import {
  type SdsSyncActionState,
  runSdsSyncAction,
} from '~/lib/rag/sds-sync-actions';
import { formatDurationMmSs, formatEasternTime } from '~/lib/utils/time';

const initialState: SdsSyncActionState = {
  ok: false,
  message: null,
  error: null,
  timestamp: 0,
  durationMs: 0,
  hasMore: true,
  remaining: 0,
  totalProcessedThisSession: 0,
  totalChunksThisSession: 0,
  history: [],
  result: null,
};

type Props = {
  initialPending: number;
  languageCode?: string;
};

export function SdsSyncControls({ initialPending, languageCode = 'EN' }: Props) {
  const router = useRouter();
  const [state, formAction, pending] = useActionState(runSdsSyncAction, initialState);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoRunNextAt, setAutoRunNextAt] = useState<number | null>(null);
  const [actionStartedAt, setActionStartedAt] = useState<number | null>(null);
  const [timerNow, setTimerNow] = useState(() => Date.now());
  const formRef = useRef<HTMLFormElement>(null);

  // Total is set on first run; before that use initialPending
  const totalKnown =
    state.timestamp > 0
      ? state.totalProcessedThisSession + state.remaining
      : initialPending;
  const processed = state.totalProcessedThisSession;
  const progressPct =
    totalKnown > 0 ? Math.min(100, Math.round((processed / totalKnown) * 100)) : 0;
  const isDone = state.timestamp > 0 && !state.hasMore && state.ok;

  // React to completed action results
  useEffect(() => {
    if (state.timestamp === 0) return;

    if (state.ok) {
      if (state.hasMore && autoRunning) {
        setAutoRunNextAt(Date.now());
      } else if (!state.hasMore) {
        setAutoRunning(false);
        setAutoRunNextAt(null);
        toast.success('SDS sync complete', {
          description: `${state.totalProcessedThisSession.toLocaleString()} documents rechunked.`,
        });
      }
    } else {
      setAutoRunning(false);
      setAutoRunNextAt(null);
      toast.error(state.error ?? 'SDS sync failed.');
    }
  }, [state]);

  // Elapsed timer while pending
  useEffect(() => {
    if (!pending) return;
    const interval = window.setInterval(() => setTimerNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [pending]);

  // Refresh server-fetched stats every 2.5 min while sync is running
  useEffect(() => {
    if (!pending && !autoRunning) return;
    const interval = window.setInterval(() => router.refresh(), 150_000);
    return () => window.clearInterval(interval);
  }, [pending, autoRunning, router]);

  // Fire next batch when countdown expires
  useEffect(() => {
    if (autoRunNextAt === null || !autoRunning || pending) return;
    const delay = Math.max(0, autoRunNextAt - Date.now());
    const timer = window.setTimeout(() => {
      formRef.current?.requestSubmit();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [autoRunNextAt, autoRunning, pending]);

  const elapsedMs =
    pending && actionStartedAt !== null ? Math.max(0, timerNow - actionStartedAt) : 0;

  function startSync() {
    setAutoRunning(true);
    setAutoRunNextAt(null);
    setActionStartedAt(Date.now());
    setTimerNow(Date.now());
    formRef.current?.requestSubmit();
  }

  function stopSync() {
    setAutoRunning(false);
    setAutoRunNextAt(null);
  }

  return (
    <div className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
          SDS Chunk Sync
        </p>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
          Rechunk SDS documents
        </h2>
        <p className="max-w-2xl text-sm leading-6 text-slate-600">
          Runs <code className="rounded bg-slate-100 px-1 py-0.5 text-xs font-mono">sync_sds_chunks</code> in
          a loop — 100 documents per batch — until all documents have been rechunked with
          section-aware boundaries. Progress is shown live. Once complete, run embeddings
          from the RAG Generate page.
        </p>
      </div>

      {/* Progress bar */}
      <div className="mt-8">
        <div className="mb-2 flex items-center justify-between text-sm">
          <span className="font-medium text-slate-700">
            {isDone
              ? 'Rechunking complete'
              : processed > 0
                ? `${processed.toLocaleString()} of ~${totalKnown.toLocaleString()} documents rechunked`
                : `~${initialPending.toLocaleString()} documents pending`}
          </span>
          <span className="text-slate-500">{progressPct}%</span>
        </div>
        <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100">
          <div
            className={`h-full rounded-full transition-all duration-500 ${
              isDone ? 'bg-emerald-500' : 'bg-sky-500'
            }`}
            style={{ width: `${isDone ? 100 : progressPct}%` }}
          />
        </div>
        {state.totalChunksThisSession > 0 && (
          <p className="mt-1.5 text-xs text-slate-500">
            {state.totalChunksThisSession.toLocaleString()} chunks generated this session
          </p>
        )}
      </div>

      {/* Hidden form that the auto-runner submits */}
      <form ref={formRef} action={formAction} className="hidden">
        <input name="languageCode" type="hidden" value={languageCode} />
      </form>

      {/* Controls */}
      <div className="mt-6 flex flex-wrap items-center gap-3">
        {isDone ? (
          <div className="flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-3 text-sm font-semibold text-emerald-700">
            <CheckCircle2 className="size-4" />
            All documents rechunked — run embeddings next
          </div>
        ) : !autoRunning && !pending ? (
          <Button
            className="h-12 gap-2 rounded-2xl px-6 font-semibold"
            onClick={startSync}
            type="button"
          >
            <PlayCircle className="size-4" />
            {state.timestamp > 0 ? 'Resume sync' : 'Start SDS sync'}
          </Button>
        ) : (
          <Button
            className="h-12 gap-2 rounded-2xl px-6 font-semibold"
            onClick={stopSync}
            type="button"
            variant="outline"
          >
            <StopCircle className="size-4" />
            Stop after this batch
          </Button>
        )}

        {(pending || (autoRunning && !pending)) && (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <Loader2 className="size-4 animate-spin" />
            {pending
              ? `Batch running — ${formatDurationMmSs(elapsedMs)}`
              : 'Queuing next batch…'}
          </div>
        )}
      </div>

      {/* Last result banner */}
      {state.timestamp > 0 && (
        <div
          className={`mt-6 rounded-2xl border p-4 text-sm ${
            state.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-800'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <p>{state.ok ? state.message : state.error}</p>
            <span className="shrink-0 text-xs opacity-70">
              {formatEasternTime(state.timestamp)} •{' '}
              {formatDurationMmSs(state.durationMs)}
            </span>
          </div>
        </div>
      )}

      {/* Activity log */}
      {state.history.length > 0 && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-slate-50 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-950">Activity log</h3>
            <span className="text-xs text-slate-500">
              {state.history.length} batch{state.history.length === 1 ? '' : 'es'}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {state.history.map((item) => (
              <div
                key={item.id}
                className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 ${
                  item.ok
                    ? 'border-emerald-100 bg-white text-emerald-900'
                    : 'border-rose-100 bg-white text-rose-900'
                }`}
              >
                <p className="text-xs font-medium">{item.title}</p>
                <span className="shrink-0 text-xs opacity-60">
                  {item.description} • {formatDurationMmSs(item.durationMs)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
