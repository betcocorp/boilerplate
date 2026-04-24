'use client';

import { useActionState, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import moment from 'moment';
import { toast } from 'sonner';

import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';

import {
  type GenerateActionState,
  runGenerateAction,
} from '~/lib/rag/generate-actions';
import { formatDurationMmSs } from '~/lib/utils/time';

const initialGenerateActionState: GenerateActionState = {
  ok: false,
  message: null,
  error: null,
  timestamp: 0,
  durationMs: 0,
  history: [],
  result: null,
};

function formatJson(value: Record<string, unknown> | null) {
  if (!value) {
    return null;
  }

  return JSON.stringify(value, null, 2);
}

type GenerateControlsProps = {
  defaultLanguageCode?: string;
  defaultBatchSize?: number;
  defaultMaxBatches?: number;
};

function formatTimestamp(timestamp: number) {
  return `${moment.utc(timestamp).format('YYYY-MM-DD HH:mm:ss')} UTC`;
}

export function GenerateControls({
  defaultLanguageCode = 'EN',
  defaultBatchSize = 25,
  defaultMaxBatches = 4,
}: GenerateControlsProps) {
  const [state, formAction, pending] = useActionState(
    runGenerateAction,
    initialGenerateActionState,
  );
  const [languageCode, setLanguageCode] = useState(defaultLanguageCode);
  const [batchSize, setBatchSize] = useState(String(defaultBatchSize));
  const [maxBatches, setMaxBatches] = useState(String(defaultMaxBatches));
  const [actionStartedAt, setActionStartedAt] = useState<number | null>(null);
  const [timerNow, setTimerNow] = useState(() => Date.now());

  useEffect(() => {
    if (state.timestamp === 0) {
      return;
    }

    const title = state.ok
      ? state.message || 'Pipeline action completed.'
      : state.error || 'Pipeline action failed.';
    const description = `Completed at ${formatTimestamp(state.timestamp)}.`;

    if (state.ok) {
      toast.success(title, {
        description,
      });
    } else {
      toast.error(title, {
        description,
      });
    }
  }, [state]);

  useEffect(() => {
    if (!pending || actionStartedAt === null) {
      return;
    }

    const interval = window.setInterval(() => {
      setTimerNow(Date.now());
    }, 1000);

    return () => {
      window.clearInterval(interval);
    };
  }, [actionStartedAt, pending]);

  const currentElapsedMs =
    pending && actionStartedAt !== null
      ? Math.max(0, timerNow - actionStartedAt)
      : 0;

  const profileSyncResult = formatJson(state.result?.profileSyncResult ?? null);
  const chunkSyncResult = formatJson(state.result?.chunkSyncResult ?? null);
  const embeddingResult = formatJson(state.result?.embeddingResult ?? null);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-col gap-3">
        <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
          Pipeline Controls
        </p>
        <h2 className="text-2xl font-semibold tracking-tight text-slate-950">
          Run and monitor RAG generation
        </h2>
        <p className="max-w-3xl text-sm leading-6 text-slate-600">
          Use the buttons below to sync the next document batch, generate the next
          chunk batch, or run embeddings. The full pipeline action runs all stages
          in order and keeps document sync, chunking, and embedding in bounded
          batches until it finishes or hits the safety cap.
        </p>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-slate-700">Language code</Label>
          <Input
            className="h-12 rounded-2xl px-4"
            onChange={(event) => setLanguageCode(event.target.value.toUpperCase())}
            value={languageCode}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-slate-700">
            Embedding batch size
          </Label>
          <Input
            className="h-12 rounded-2xl px-4"
            min={1}
            onChange={(event) => setBatchSize(event.target.value)}
            type="number"
            value={batchSize}
          />
        </div>
        <div className="flex flex-col gap-2">
          <Label className="text-sm font-medium text-slate-700">
            Max batches per embedding run
          </Label>
          <Input
            className="h-12 rounded-2xl px-4"
            min={1}
            onChange={(event) => setMaxBatches(event.target.value)}
            type="number"
            value={maxBatches}
          />
        </div>
      </div>

      <div className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          ['sync-documents', 'Sync next document batch'],
          ['sync-chunks', 'Generate next chunk batch'],
          ['sync-embeddings', 'Embed next batches'],
          ['run-all', 'Run full pipeline'],
        ].map(([intent, label]) => (
          <form
            action={formAction}
            className="flex"
            key={intent}
            onSubmit={() => {
              const startedAt = Date.now();
              setActionStartedAt(startedAt);
              setTimerNow(startedAt);
            }}
          >
            <input name="intent" type="hidden" value={intent} />
            <input name="languageCode" type="hidden" value={languageCode} />
            <input name="batchSize" type="hidden" value={batchSize} />
            <input name="maxBatches" type="hidden" value={maxBatches} />
            <Button
              className="h-12 rounded-2xl px-6 font-semibold"
              disabled={pending}
              type="submit"
              variant="default"
            >
              {pending ? 'Working...' : label}
            </Button>
          </form>
        ))}
      </div>

      {pending ? (
        <div className="mt-8 flex items-center gap-3 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-800">
          <Loader2 className="size-4 animate-spin" />
          <span>
            Running the selected pipeline action. This page will update when the
            step completes. Elapsed: {formatDurationMmSs(currentElapsedMs)}
          </span>
        </div>
      ) : null}

      {state.timestamp > 0 ? (
        <section
          className={`mt-8 rounded-2xl border p-4 text-sm ${
            state.ok
              ? 'border-emerald-200 bg-emerald-50 text-emerald-800'
              : 'border-rose-200 bg-rose-50 text-rose-800'
          }`}
        >
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-semibold">
                {state.ok
                  ? 'Last pipeline action succeeded'
                  : 'Last pipeline action failed'}
              </p>
              <p className="mt-1">
                {state.ok ? state.message : state.error}
              </p>
              {!state.ok ? (
                <p className="mt-1 opacity-80">
                  The request completed, but the selected pipeline step returned
                  an error.
                </p>
              ) : null}
            </div>
            <div className="shrink-0 text-xs font-medium opacity-80">
              {formatTimestamp(state.timestamp)} • {formatDurationMmSs(state.durationMs)}
            </div>
          </div>
        </section>
      ) : null}

      {state.result ? (
        <div className="mt-8 grid gap-4 lg:grid-cols-3">
          <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-semibold text-slate-950">
              Document sync result
            </h3>
            <pre className="mt-3 wrap-break-word whitespace-pre-wrap text-xs leading-5 text-slate-700">
              {profileSyncResult || 'Not run in the last action.'}
            </pre>
          </section>
          <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-semibold text-slate-950">
              Chunk sync result
            </h3>
            <pre className="mt-3 wrap-break-word whitespace-pre-wrap text-xs leading-5 text-slate-700">
              {chunkSyncResult || 'Not run in the last action.'}
            </pre>
          </section>
          <section className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-semibold text-slate-950">
              Embedding result
            </h3>
            <pre className="mt-3 wrap-break-word whitespace-pre-wrap text-xs leading-5 text-slate-700">
              {embeddingResult || 'Not run in the last action.'}
            </pre>
          </section>
        </div>
      ) : null}

      <section className="mt-8 rounded-2xl border border-slate-200 bg-slate-50 p-4">
        <div className="flex items-center justify-between gap-3">
          <h3 className="text-sm font-semibold text-slate-950">Activity log</h3>
          <span className="text-xs text-slate-500">
            {state.history.length} recent event{state.history.length === 1 ? '' : 's'}
          </span>
        </div>

        {state.history.length === 0 ? (
          <p className="mt-3 text-sm text-slate-600">
            No pipeline actions have been run from this session yet.
          </p>
        ) : (
          <div className="mt-4 flex flex-col gap-3">
            {state.history.map((item) => (
              <div
                className={`rounded-2xl border px-4 py-3 ${
                  item.ok
                    ? 'border-emerald-200 bg-white text-emerald-900'
                    : 'border-rose-200 bg-white text-rose-900'
                }`}
                key={item.id}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-medium">{item.title}</p>
                  <span className="text-xs opacity-70">
                    {item.description} • {formatDurationMmSs(item.durationMs)}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </section>
  );
}
