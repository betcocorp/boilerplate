'use client';

import { useState } from 'react';

type BoostRule = {
  field: string;
  weight: number;
  matchType: string;
  description: string;
  readOnly?: boolean;
};

const DEFAULT_RULES: BoostRule[] = [
  {
    field: 'surface_type',
    weight: 0.1,
    matchType: 'Exact',
    description: 'Boost chunks whose surface type matches the inferred query context',
  },
  {
    field: 'dwell_time_minutes',
    weight: 0.05,
    matchType: 'Range',
    description: 'Boost chunks that include an explicit dwell time value',
  },
  {
    field: 'dilution_ratio',
    weight: 0.05,
    matchType: 'Exact',
    description: 'Boost chunks that include dilution ratio data',
  },
  {
    field: 'product_line_key',
    weight: 0.15,
    matchType: 'Exact',
    description: 'Already active — implemented via filter_product_line_key param',
    readOnly: true,
  },
];

function sqlSnippet(rules: BoostRule[]) {
  const lines = rules
    .filter((r) => !r.readOnly)
    .map((r) => {
      if (r.matchType === 'Range') {
        return `  + CASE WHEN (dc.metadata->>'${r.field}') IS NOT NULL THEN ${r.weight.toFixed(2)} ELSE 0 END`;
      }
      return `  + CASE WHEN dc.metadata->>'${r.field}' = $inferred_${r.field} THEN ${r.weight.toFixed(2)} ELSE 0 END`;
    });
  return `-- Add to similarity expression in match_corpus_chunks / match_product_chunks:\nsimilarity\n${lines.join('\n')}`;
}

export function BoostRulesCard() {
  const [rules, setRules] = useState<BoostRule[]>(DEFAULT_RULES);
  const [showSql, setShowSql] = useState(false);
  const [copied, setCopied] = useState(false);

  function setWeight(field: string, weight: number) {
    setRules((prev) =>
      prev.map((r) => (r.field === field ? { ...r, weight } : r)),
    );
  }

  const sql = sqlSnippet(rules);

  function copySql() {
    void navigator.clipboard.writeText(sql).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

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
        <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700">
          Pending migration
        </span>
      </div>
      <p className="mt-2 text-sm text-slate-500">
        These weights are added to the cosine similarity score in{' '}
        <code className="font-mono text-xs">match_corpus_chunks</code> /{' '}
        <code className="font-mono text-xs">match_product_chunks</code> when a chunk&apos;s metadata
        matches the inferred query context. Tune the weights below, then copy the SQL snippet into
        your migration.
      </p>

      <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-200">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="bg-slate-50">
            <tr>
              {['Metadata field', 'Boost weight', 'Match type', 'Description'].map((h) => (
                <th
                  className="px-4 py-2.5 text-left text-xs font-semibold text-slate-600"
                  key={h}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rules.map((rule) => (
              <tr className="align-middle" key={rule.field}>
                <td className="px-4 py-3 font-mono text-xs text-slate-700">{rule.field}</td>
                <td className="px-4 py-3">
                  {rule.readOnly ? (
                    <span className="text-sm text-slate-400">{rule.weight.toFixed(2)}</span>
                  ) : (
                    <input
                      className="h-8 w-20 rounded-lg border border-slate-200 bg-white px-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-violet-500"
                      max={0.5}
                      min={0}
                      onChange={(e) =>
                        setWeight(rule.field, Math.min(0.5, Math.max(0, Number(e.target.value) || 0)))
                      }
                      step={0.01}
                      type="number"
                      value={rule.weight}
                    />
                  )}
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                      rule.readOnly
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {rule.readOnly ? '✓ Active' : rule.matchType}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-slate-500">{rule.description}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* SQL config */}
      <div className="mt-6">
        <button
          className="flex items-center gap-2 text-sm font-medium text-violet-700 hover:text-violet-900"
          onClick={() => setShowSql((v) => !v)}
          type="button"
        >
          <span>{showSql ? '▼' : '▶'}</span>
          Migration SQL snippet
        </button>
        {showSql ? (
          <div className="mt-3">
            <pre className="overflow-x-auto rounded-2xl bg-slate-900 p-5 text-xs text-slate-100">
              {sql}
            </pre>
            <button
              className={`mt-2 rounded-xl px-4 py-2 text-xs font-medium transition ${
                copied
                  ? 'bg-emerald-50 text-emerald-700'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
              onClick={copySql}
              type="button"
            >
              {copied ? 'Copied!' : 'Copy SQL'}
            </button>
          </div>
        ) : null}
      </div>
    </section>
  );
}
