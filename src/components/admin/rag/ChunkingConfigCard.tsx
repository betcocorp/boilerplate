'use client';

import { useActionState, useState } from 'react';
import {
  saveChunkingConfigAction,
  type SaveCorpusSettingsState,
} from '~/lib/rag/corpus-config-actions';
import type { ChunkTokenStats } from '~/lib/rag/corpus-stats';
import {
  RAG_CHUNK_STRATEGIES,
  RAG_CHUNK_TOKEN_BOUNDS,
  type RagChunkingConfig,
  type RagChunkStrategy,
} from '~/lib/settings/rag-corpus-config';

const SURFACE_SUGGESTIONS = [
  'Hard floor',
  'Carpet',
  'Restroom',
  'Glass',
  'Stainless steel',
  'Food contact surface',
];

function DistributionBar({
  label,
  count,
  total,
  isTarget,
}: {
  label: string;
  count: number;
  total: number;
  isTarget?: boolean;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2 text-xs text-slate-500">
        <span className={isTarget ? 'font-semibold text-violet-700' : ''}>{label}</span>
        <span className={isTarget ? 'font-semibold text-violet-700' : ''}>{count}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-2 rounded-full transition-all ${isTarget ? 'bg-violet-500' : 'bg-slate-300'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-right text-[11px] text-slate-400">{pct}%</p>
    </div>
  );
}

type Props = {
  chunkStats: ChunkTokenStats;
  config: RagChunkingConfig;
};

export function ChunkingConfigCard({ chunkStats, config }: Props) {
  const [strategy, setStrategy] = useState<RagChunkStrategy>(config.strategy);
  const [minTokens, setMinTokens] = useState(String(config.minTokens));
  const [maxTokens, setMaxTokens] = useState(String(config.maxTokens));
  const [overlapTokens, setOverlapTokens] = useState(String(config.overlapTokens));

  const [state, formAction, isPending] = useActionState<SaveCorpusSettingsState, FormData>(
    saveChunkingConfigAction,
    null,
  );

  // React 19 resets a controlled input's DOM state when a `<form action={…}>` succeeds, which would
  // snap these fields back to their initial render values. They must keep what the operator typed
  // (the server round-trip is what confirms it), so the form submits via onSubmit + preventDefault.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData();
    formData.set('strategy', strategy);
    formData.set('minTokens', minTokens);
    formData.set('maxTokens', maxTokens);
    formData.set('overlapTokens', overlapTokens);
    formAction(formData);
  }

  const {
    totalChunks,
    avgTokens,
    minTokens: statMin,
    maxTokens: statMax,
    distribution,
  } = chunkStats;

  const isHeadingAware = strategy === 'heading-aware';
  const savedHeadingAware = config.strategy === 'heading-aware';
  const dirty =
    strategy !== config.strategy ||
    Number(minTokens) !== config.minTokens ||
    Number(maxTokens) !== config.maxTokens ||
    Number(overlapTokens) !== config.overlapTokens;

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Improvement 1 &amp; 2
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
            Chunking strategy &amp; token budget
          </h2>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            savedHeadingAware ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
          }`}
        >
          {savedHeadingAware ? 'Active — heading-aware' : 'Saved — naive (default)'}
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-500">
        These values are stored in the <code className="font-mono text-xs">settings</code> table as{' '}
        <code className="font-mono text-xs">RAG_CHUNK_*</code> and read by the ingestion pipeline the
        next time a document is chunked. Saving does not re-chunk the existing corpus.
      </p>

      {/* Live stats */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: 'Total chunks', value: totalChunks.toLocaleString() },
          { label: 'Avg tokens', value: avgTokens > 0 ? avgTokens.toLocaleString() : '—' },
          { label: 'Min tokens', value: statMin > 0 ? statMin.toLocaleString() : '—' },
          { label: 'Max tokens', value: statMax > 0 ? statMax.toLocaleString() : '—' },
        ].map(({ label, value }) => (
          <div className="rounded-2xl bg-slate-50 px-4 py-3" key={label}>
            <p className="text-xs text-slate-500">{label}</p>
            <p className="mt-1 text-xl font-semibold text-slate-900">{value}</p>
          </div>
        ))}
      </div>

      {/* Token distribution */}
      <div className="mt-6">
        <p className="mb-3 text-sm font-medium text-slate-700">Current token distribution</p>
        {totalChunks === 0 ? (
          <p className="text-sm text-slate-400">No chunk data yet.</p>
        ) : (
          <div className="grid grid-cols-5 gap-3">
            <DistributionBar label="<100" count={distribution.under100} total={totalChunks} />
            <DistributionBar label="100–299" count={distribution.from100to299} total={totalChunks} />
            <DistributionBar
              label="300–599 ✓"
              count={distribution.from300to599}
              total={totalChunks}
              isTarget
            />
            <DistributionBar label="600–999" count={distribution.from600to999} total={totalChunks} />
            <DistributionBar label="1000+" count={distribution.over1000} total={totalChunks} />
          </div>
        )}
        <p className="mt-2 text-xs text-slate-400">
          Violet bar (300–599) is the target range. Currently{' '}
          {totalChunks > 0 ? Math.round((distribution.from300to599 / totalChunks) * 100) : 0}% of
          chunks fall within it.
        </p>
      </div>

      {/* Config form */}
      <form className="mt-8 border-t border-slate-100 pt-6" onSubmit={handleSubmit}>
        <p className="mb-4 text-sm font-medium text-slate-700">Stored configuration</p>
        <div className="flex flex-wrap gap-4">
          {/* Strategy toggle */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">Strategy</label>
            <div className="flex overflow-hidden rounded-xl border border-slate-200">
              {RAG_CHUNK_STRATEGIES.map((s) => (
                <button
                  className={`px-4 py-2 text-sm font-medium transition ${
                    strategy === s
                      ? 'bg-violet-600 text-white'
                      : 'bg-white text-slate-600 hover:bg-slate-50'
                  }`}
                  key={s}
                  onClick={() => setStrategy(s)}
                  type="button"
                >
                  {s === 'naive' ? 'Naive (\\n\\n+)' : 'Heading-aware'}
                </button>
              ))}
            </div>
          </div>

          {/* Number inputs */}
          {[
            {
              label: 'Min tokens',
              value: minTokens,
              setter: setMinTokens,
              bounds: RAG_CHUNK_TOKEN_BOUNDS.minTokens,
            },
            {
              label: 'Max tokens',
              value: maxTokens,
              setter: setMaxTokens,
              bounds: RAG_CHUNK_TOKEN_BOUNDS.maxTokens,
            },
            {
              label: 'Overlap tokens',
              value: overlapTokens,
              setter: setOverlapTokens,
              bounds: RAG_CHUNK_TOKEN_BOUNDS.overlapTokens,
            },
          ].map(({ label, value, setter, bounds }) => (
            <div className="flex flex-col gap-1.5" key={label}>
              <label className="text-xs font-medium text-slate-600">{label}</label>
              <input
                className={`h-10 w-28 rounded-xl border border-slate-200 bg-white px-3 text-sm focus:outline-none focus:ring-2 focus:ring-violet-500 ${
                  isHeadingAware ? 'text-slate-900' : 'text-slate-400'
                }`}
                max={bounds.max}
                min={bounds.min}
                onChange={(e) => setter(e.target.value)}
                type="number"
                value={value}
              />
            </div>
          ))}
        </div>

        {!isHeadingAware ? (
          <p className="mt-4 rounded-2xl bg-slate-50 px-4 py-3 text-xs text-slate-600">
            The naive strategy splits on blank lines and does no packing, so the token budget and
            overlap above are stored but have no effect on chunking. Switch to{' '}
            <strong>heading-aware</strong> for them to apply.
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            className="flex h-10 items-center gap-2 rounded-xl bg-violet-600 px-4 text-sm font-medium text-white transition hover:bg-violet-700 disabled:opacity-50"
            disabled={isPending}
            type="submit"
          >
            {isPending ? (
              <>
                <span className="inline-block size-3 animate-spin rounded-full border-2 border-white border-t-transparent" />
                Saving
              </>
            ) : (
              'Save configuration'
            )}
          </button>
          {state?.ok === true && !dirty ? (
            <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
              Saved
            </span>
          ) : null}
          {state?.ok === false ? (
            <span
              className="rounded-full bg-rose-50 px-2.5 py-0.5 text-xs font-medium text-rose-700"
              title={state.error}
            >
              {state.error}
            </span>
          ) : null}
          <span className="text-xs text-slate-400">
            Cached for up to 30 seconds on the read path.
          </span>
        </div>
      </form>

      {/* Datalist for surface type (shared across metadata rows) */}
      <datalist id="surface-type-suggestions">
        {SURFACE_SUGGESTIONS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </section>
  );
}
