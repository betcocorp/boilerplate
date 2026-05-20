'use client';

import { useState } from 'react';
import type { ChunkTokenStats } from '~/lib/rag/corpus-stats';

type Strategy = 'naive' | 'heading-aware';

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

export function ChunkingConfigCard({ chunkStats }: { chunkStats: ChunkTokenStats }) {
  const [strategy, setStrategy] = useState<Strategy>('naive');
  const [minTokens, setMinTokens] = useState(300);
  const [maxTokens, setMaxTokens] = useState(600);
  const [overlapTokens, setOverlapTokens] = useState(50);
  const [showConfig, setShowConfig] = useState(false);
  const [copied, setCopied] = useState(false);

  const migrationConfig = JSON.stringify(
    { strategy, min_tokens: minTokens, max_tokens: maxTokens, overlap_tokens: overlapTokens },
    null,
    2,
  );

  function copyConfig() {
    void navigator.clipboard.writeText(migrationConfig).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  const { totalChunks, avgTokens, minTokens: statMin, maxTokens: statMax, distribution } = chunkStats;

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
        <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
          Pending migration
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-500">
        Configure the desired chunking strategy and token targets. Copy the migration config below
        and use it to update the <code className="font-mono text-xs">sync_legacy_product_profile_chunks</code> RPC.
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
          {totalChunks > 0
            ? Math.round((distribution.from300to599 / totalChunks) * 100)
            : 0}
          % of chunks fall within it.
        </p>
      </div>

      {/* Config form */}
      <div className="mt-8 border-t border-slate-100 pt-6">
        <p className="mb-4 text-sm font-medium text-slate-700">Desired configuration</p>
        <div className="flex flex-wrap gap-4">
          {/* Strategy toggle */}
          <div className="flex flex-col gap-1.5">
            <label className="text-xs font-medium text-slate-600">Strategy</label>
            <div className="flex overflow-hidden rounded-xl border border-slate-200">
              {(['naive', 'heading-aware'] as Strategy[]).map((s) => (
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
            { label: 'Min tokens', value: minTokens, setter: setMinTokens, min: 50, max: 600 },
            { label: 'Max tokens', value: maxTokens, setter: setMaxTokens, min: 100, max: 2000 },
            { label: 'Overlap tokens', value: overlapTokens, setter: setOverlapTokens, min: 0, max: 200 },
          ].map(({ label, value, setter, min, max }) => (
            <div className="flex flex-col gap-1.5" key={label}>
              <label className="text-xs font-medium text-slate-600">{label}</label>
              <input
                className="h-10 w-28 rounded-xl border border-slate-200 bg-white px-3 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-violet-500"
                max={max}
                min={min}
                onChange={(e) => setter(Number(e.target.value) || 0)}
                type="number"
                value={value}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Migration config */}
      <div className="mt-6">
        <button
          className="flex items-center gap-2 text-sm font-medium text-violet-700 hover:text-violet-900"
          onClick={() => setShowConfig((v) => !v)}
          type="button"
        >
          <span>{showConfig ? '▼' : '▶'}</span>
          Migration config
        </button>
        {showConfig ? (
          <div className="mt-3">
            <pre className="overflow-x-auto rounded-2xl bg-slate-900 p-5 text-xs text-slate-100">
              {migrationConfig}
            </pre>
            <button
              className={`mt-2 rounded-xl px-4 py-2 text-xs font-medium transition ${
                copied
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
              onClick={copyConfig}
              type="button"
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        ) : null}
      </div>

      {/* Datalist for surface type (shared across metadata rows) */}
      <datalist id="surface-type-suggestions">
        {SURFACE_SUGGESTIONS.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </section>
  );
}
