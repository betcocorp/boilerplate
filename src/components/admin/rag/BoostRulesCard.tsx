'use client';

import { useActionState, useState } from 'react';
import {
  saveBoostRulesAction,
  type SaveCorpusSettingsState,
} from '~/lib/rag/corpus-config-actions';
import type { BoostFieldCoverage } from '~/lib/rag/corpus-stats';
import { RAG_BOOST_WEIGHT_BOUNDS } from '~/lib/settings/rag-corpus-config';

type WeightKey = 'surfaceType' | 'dwellTime' | 'dilutionRatio';

type TunableRule = {
  key: WeightKey;
  field: BoostFieldCoverage['field'];
  matchType: string;
  description: string;
};

const TUNABLE_RULES: TunableRule[] = [
  {
    key: 'surfaceType',
    field: 'surface_type',
    matchType: 'Exact',
    description:
      'Boost chunks whose surface type matches the surface type passed with the query. Nothing infers one from a user question yet, so this rule cannot fire from the chat path today.',
  },
  {
    key: 'dwellTime',
    field: 'dwell_time_minutes',
    matchType: 'Range',
    description:
      'Boost chunks that carry an explicit dwell time. No chunk in the corpus has this field, so the rule is a no-op until documents are enriched.',
  },
  {
    key: 'dilutionRatio',
    field: 'dilution_ratio',
    matchType: 'Exact',
    description: 'Boost chunks that carry dilution ratio data.',
  },
];

function CoverageCell({ coverage }: { coverage: BoostFieldCoverage | undefined }) {
  if (!coverage) {
    return <span className="text-xs text-slate-400">—</span>;
  }

  const { chunksWithValue, totalChunks } = coverage;
  const pct = totalChunks > 0 ? (chunksWithValue / totalChunks) * 100 : 0;
  const none = chunksWithValue === 0;

  return (
    <div className="flex flex-col">
      <span
        className={`text-sm font-medium ${none ? 'text-rose-700' : 'text-slate-800'}`}
        title={`${chunksWithValue.toLocaleString()} of ${totalChunks.toLocaleString()} chunks`}
      >
        {chunksWithValue.toLocaleString()}
      </span>
      <span className={`text-[11px] ${none ? 'text-rose-500' : 'text-slate-400'}`}>
        {none ? 'no chunks — rule cannot fire' : `${pct.toFixed(2)}% of ${totalChunks.toLocaleString()}`}
      </span>
    </div>
  );
}

type Props = {
  enabled: boolean;
  weights: Record<WeightKey, number>;
  coverage: BoostFieldCoverage[];
};

export function BoostRulesCard({ enabled, weights, coverage }: Props) {
  const [boostEnabled, setBoostEnabled] = useState(enabled);
  const [values, setValues] = useState<Record<WeightKey, string>>({
    surfaceType: weights.surfaceType.toFixed(2),
    dwellTime: weights.dwellTime.toFixed(2),
    dilutionRatio: weights.dilutionRatio.toFixed(2),
  });

  const [state, formAction, isPending] = useActionState<SaveCorpusSettingsState, FormData>(
    saveBoostRulesAction,
    null,
  );

  // Same React 19 caveat as ChunkingConfigCard: `<form action={…}>` resets controlled inputs on a
  // successful submit, which would discard the weights just typed. Submit via onSubmit instead.
  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData();
    formData.set('enabled', boostEnabled ? 'true' : 'false');
    for (const [key, value] of Object.entries(values)) {
      formData.set(key, value);
    }
    formAction(formData);
  }

  const coverageByField = new Map(coverage.map((row) => [row.field, row]));
  const dirty =
    boostEnabled !== enabled ||
    (Object.keys(values) as WeightKey[]).some(
      (key) => Number(values[key]) !== Number(weights[key].toFixed(2)),
    );

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Improvement 4
          </p>
          <h2 className="mt-1 text-2xl font-semibold tracking-tight text-slate-900">
            Similarity boost rules
          </h2>
        </div>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            enabled ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-600'
          }`}
        >
          {enabled ? 'Active — boosting on' : 'Saved — boosting off'}
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-500">
        These weights are stored as <code className="font-mono text-xs">RAG_BOOST_*</code> in the{' '}
        <code className="font-mono text-xs">settings</code> table and used by{' '}
        <code className="font-mono text-xs">match_corpus_chunks</code> /{' '}
        <code className="font-mono text-xs">match_product_chunks</code> to reorder results. They
        affect ordering only — the <code className="font-mono text-xs">similarity</code> column
        returned to callers stays the true cosine value.
      </p>

      <form onSubmit={handleSubmit}>
        <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-200">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="bg-slate-50">
              <tr>
                {['Metadata field', 'Boost weight', 'Chunks with value', 'Match type', 'Description'].map(
                  (h) => (
                    <th
                      className="px-4 py-2.5 text-left text-xs font-semibold text-slate-600"
                      key={h}
                    >
                      {h}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {TUNABLE_RULES.map((rule) => (
                <tr className="align-middle" key={rule.field}>
                  <td className="px-4 py-3 font-mono text-xs text-slate-700">{rule.field}</td>
                  <td className="px-4 py-3">
                    <input
                      className="h-8 w-20 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500"
                      max={RAG_BOOST_WEIGHT_BOUNDS.max}
                      min={RAG_BOOST_WEIGHT_BOUNDS.min}
                      onChange={(e) =>
                        setValues((prev) => ({ ...prev, [rule.key]: e.target.value }))
                      }
                      step={0.01}
                      type="number"
                      value={values[rule.key]}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <CoverageCell coverage={coverageByField.get(rule.field)} />
                  </td>
                  <td className="px-4 py-3">
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                      {rule.matchType}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-slate-500">{rule.description}</td>
                </tr>
              ))}
              {/* Already live via filter_product_line_key — not stored as a tunable weight. */}
              <tr className="align-middle">
                <td className="px-4 py-3 font-mono text-xs text-slate-700">product_line_key</td>
                <td className="px-4 py-3">
                  <span className="text-sm text-slate-400">0.15</span>
                </td>
                <td className="px-4 py-3">
                  <span className="text-xs text-slate-400">n/a</span>
                </td>
                <td className="px-4 py-3">
                  <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                    ✓ Active
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-slate-500">
                  Already active — implemented via filter_product_line_key param
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <label className="mt-6 flex items-start gap-3 rounded-2xl bg-slate-50 px-4 py-3">
          <input
            checked={boostEnabled}
            className="mt-0.5 size-4 rounded border-slate-300 text-violet-600 focus:ring-violet-500"
            onChange={(e) => setBoostEnabled(e.target.checked)}
            type="checkbox"
          />
          <span className="text-xs text-slate-600">
            <strong className="text-slate-800">Enable metadata boosting</strong> — off by default.
            While off, every weight above is treated as <code className="font-mono">0</code> and
            results come back in pure cosine order. Weights stay saved across a disable/enable cycle.
          </span>
        </label>

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
              'Save boost rules'
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
    </section>
  );
}
