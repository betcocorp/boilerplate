'use client';

import { Loader2, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useRunInsights } from '~/components/admin/observability/run-insights-context';
import { Button } from '~/components/ui/button';
import { Skeleton } from '~/components/ui/skeleton';
import type { PromptInsight } from '~/lib/observability/prompt-insights';

/**
 * Prompt-level sibling of `~/components/admin/tests/RunInsightsPanel`, for the
 * Prompt Observability trace page (epic B0-330). Same layout and interaction;
 * the categories describe one prompt's own trace instead of a test run's
 * pass/fail spread.
 *
 * B0-420 — results are persisted under `ai_suggestions` (scope `workflow_run`), so
 * the panel reads them on mount rather than re-billing a `gpt-4.1-mini` call every
 * time someone opens the page. A completed run is immutable, so a stored set is as
 * good as a fresh one; the only reason to regenerate is an explicit "Re-analyze",
 * or the route deciding a grading-blind set is now improvable. The result is kept
 * in `RunInsightsProvider` rather than local state so the JSON export button can
 * include it.
 */

export type { PromptInsight };

const CATEGORY_STYLES: Record<string, string> = {
  prompt: 'bg-rose-100 text-rose-800',
  routing: 'bg-violet-100 text-violet-800',
  tools: 'bg-sky-100 text-sky-800',
  grounding: 'bg-emerald-100 text-emerald-800',
  confidence: 'bg-amber-100 text-amber-800',
};

const IMPACT_STYLES: Record<string, string> = {
  high: 'border-red-200 bg-red-50 text-red-700',
  medium: 'border-amber-200 bg-amber-50 text-amber-700',
  low: 'border-slate-200 bg-slate-100 text-slate-600',
};

type Props = {
  runId: string;
};

/** Content-shaped stand-in for the insight cards while analysis runs. */
function InsightsSkeleton() {
  return (
    <div aria-live="polite" role="status">
      <span className="sr-only">Analyzing this run…</span>
      <ol className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <li
            className="flex gap-4 rounded-2xl border border-slate-100 bg-slate-50 p-5"
            key={index}
          >
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Skeleton className="h-5 w-20 rounded-full" />
                <Skeleton className="h-5 w-24 rounded-full" />
                <Skeleton className="h-5 w-28 rounded-md" />
              </div>
              <div className="mt-2 space-y-1.5">
                <Skeleton className="h-4 w-full rounded-md" />
                <Skeleton className="h-4 w-4/5 rounded-md" />
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function RunPromptInsightsPanel({ runId }: Props) {
  const { insights, generatedAt, setResult } = useRunInsights();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydrating, setHydrating] = useState(true);

  /**
   * B0-420 — read any stored insights for this run. GET never calls the LLM, except in the one
   * case the route decides for itself: a stored set generated without harness grading context,
   * for a run that now has some. A failed read is deliberately silent — the Analyze button is
   * still there, so surfacing an error for "nothing cached" would be noise.
   */
  useEffect(() => {
    let ignore = false;

    void (async () => {
      try {
        const res = await fetch(`/api/admin/observability/runs/${runId}/insights`);
        const data = (await res.json()) as {
          ok?: boolean;
          insights?: PromptInsight[] | null;
          generatedAt?: string | null;
        };
        if (!ignore && res.ok && data.ok && data.insights?.length) {
          setResult(data.insights, data.generatedAt ?? null);
        }
      } catch {
        // Nothing to show; leave the panel in its "Analyze this run" state.
      } finally {
        if (!ignore) {
          setHydrating(false);
        }
      }
    })();

    return () => {
      ignore = true;
    };
  }, [runId, setResult]);

  async function analyze() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/observability/runs/${runId}/insights`, {
        method: 'POST',
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        insights?: PromptInsight[];
        generatedAt?: string | null;
      };
      if (!res.ok || !data.ok) {
        setError(data.error ?? 'Analysis failed.');
      } else {
        setResult(data.insights ?? [], data.generatedAt ?? null);
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
            Prompt insights
          </h2>
          <p className="mt-1 text-sm text-slate-500">
            Top 3 recommendations to improve this prompt&apos;s routing, grounding,
            and confidence.
          </p>
          {generatedAt ? (
            <p className="mt-1 text-xs text-slate-400">
              Last analyzed {new Date(generatedAt).toLocaleString()}
            </p>
          ) : null}
        </div>
        <Button
          disabled={loading || hydrating}
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

      {/* Hydrating shows the skeleton too, so a run with stored insights does not flash
          "Analyze this run" before they arrive. */}
      {loading || hydrating ? <InsightsSkeleton /> : null}

      {!loading && !hydrating && insights && insights.length > 0 ? (
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
                  <p className="font-semibold text-slate-900">{insight.title}</p>
                </div>
                <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
                  {insight.description}
                </p>
              </div>
            </li>
          ))}
        </ol>
      ) : !loading && insights && insights.length === 0 ? (
        <p className="mt-6 text-sm text-slate-500">No insights generated.</p>
      ) : null}
    </section>
  );
}
