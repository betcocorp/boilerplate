'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useState } from 'react';

import { Button } from '~/components/ui/button';

export type Insight = {
  rank: number;
  title: string;
  description: string;
  category: 'agent' | 'corpus' | 'retrieval' | 'evaluation';
  impact: 'high' | 'medium' | 'low';
};

const CATEGORY_STYLES: Record<string, string> = {
  agent: 'bg-rose-100 text-rose-800',
  corpus: 'bg-violet-100 text-violet-800',
  retrieval: 'bg-sky-100 text-sky-800',
  evaluation: 'bg-emerald-100 text-emerald-800',
};

const IMPACT_STYLES: Record<string, string> = {
  high: 'border-red-200 bg-red-50 text-red-700',
  medium: 'border-amber-200 bg-amber-50 text-amber-700',
  low: 'border-slate-200 bg-slate-100 text-slate-600',
};

type Props = {
  runId: string;
  initialInsights?: Insight[] | null;
  initialGeneratedAt?: string | null;
};

export function RunInsightsPanel({
  runId,
  initialInsights = null,
  initialGeneratedAt = null,
}: Props) {
  const [insights, setInsights] = useState<Insight[] | null>(initialInsights);
  const [generatedAt, setGeneratedAt] = useState<string | null>(
    initialGeneratedAt,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function analyze() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/tests/runs/${runId}/insights`, {
        method: 'POST',
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        insights?: Insight[];
        generatedAt?: string | null;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Analysis failed.');
      } else {
        setInsights(data.insights ?? []);
        setGeneratedAt(data.generatedAt ?? null);
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            AI analysis
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
            Run insights
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Top 3 recommendations to improve similarity and pass rate for this
            run.
          </p>
          {generatedAt ? (
            <p className="mt-1 text-xs text-slate-400">
              Last analyzed {new Date(generatedAt).toLocaleString()}
            </p>
          ) : null}
        </div>
        <Button
          disabled={loading}
          onClick={analyze}
          size="sm"
          variant={insights ? 'outline' : 'default'}
        >
          {loading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Analyzing…
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-4 w-4" />
              {insights ? 'Re-analyze' : 'Analyze this run'}
            </>
          )}
        </Button>
      </div>

      {error ? (
        <div className="mt-6 rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {insights && insights.length > 0 ? (
        <ol className="mt-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {insights.map((insight) => (
            <li
              className="flex gap-4 rounded-2xl border border-slate-100 bg-slate-50 p-5"
              key={insight.rank}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-sm font-bold text-sky-700">
                {insight.rank}
              </span>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium capitalize ${CATEGORY_STYLES[insight.category] ?? 'bg-slate-100 text-slate-700'}`}
                  >
                    {insight.category}
                  </span>
                  <span
                    className={`rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${IMPACT_STYLES[insight.impact] ?? 'border-slate-200 bg-slate-100 text-slate-600'}`}
                  >
                    {insight.impact} impact
                  </span>
                  <p className="font-semibold text-slate-900">
                    {insight.title}
                  </p>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
                  {insight.description}
                </p>
              </div>
            </li>
          ))}
        </ol>
      ) : insights && insights.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500">No insights generated.</p>
      ) : null}
    </section>
  );
}
