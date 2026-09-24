'use client';

import { AlertTriangle, DatabaseZap, Loader2, RefreshCw } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';

import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';

type Aggregate = {
  metric: string;
  value: number | null;
  scoredCount: number;
  unscorableCount: number;
};

type Episode = {
  episodeId: string;
  itemId: string;
  rowIndex: number;
  question: string;
  passed: boolean;
  metrics: Record<string, { scored: boolean; value?: number; reason?: string }>;
};

export type RagEvaluationPanelData = {
  status: 'pending' | 'running' | 'ready' | 'failed';
  error: string | null;
  completedAt: string | null;
  coverage: {
    requested: number;
    resolved: number;
    missing: number;
    synthetic: number;
    noChunkId: number;
    resolvedShare: number | null;
  } | null;
  labelling: {
    items: number;
    labelled: number;
    unlabelled: number;
    documentLabelled: number;
    entityLabelled: number;
    orphanJudgements: number;
    labelledShare: number | null;
  } | null;
  aggregates: Aggregate[];
  episodes: Episode[];
};

type Props = {
  runId: string;
  eligible: boolean;
  initialEvaluation: RagEvaluationPanelData | null;
};

function percent(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

function metricValue(value: number | null): string {
  return value === null ? 'n/a' : value.toFixed(4);
}

export function RagEvaluationPanel({ runId, eligible, initialEvaluation }: Props) {
  const router = useRouter();
  const [evaluation, setEvaluation] = useState(initialEvaluation);
  const [busy, setBusy] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const shouldPoll = evaluation?.status === 'pending' || evaluation?.status === 'running';

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/admin/tests/runs/${runId}/rag-evaluation`, {
        cache: 'no-store',
      });
      if (!response.ok) return;
      const payload = (await response.json()) as {
        evaluation: RagEvaluationPanelData | null;
      };
      const nextEvaluation = payload.evaluation;
      if (!nextEvaluation) return;
      setEvaluation(nextEvaluation);
      if (nextEvaluation.status === 'ready' || nextEvaluation.status === 'failed') {
        router.refresh();
      }
    }, 1200);
    return () => window.clearInterval(timer);
  }, [runId, router, shouldPoll]);

  const aggregateByName = useMemo(
    () => new Map(evaluation?.aggregates.map((metric) => [metric.metric, metric]) ?? []),
    [evaluation?.aggregates],
  );

  async function start(action: 'evaluate' | 'recompute') {
    setBusy(true);
    setRequestError(null);
    try {
      const response = await fetch(`/api/admin/tests/runs/${runId}/rag-evaluation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'recompute' ? { action: 'recompute' } : {}),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'Unable to start retrieval evaluation.');
      setEvaluation({
        status: 'pending',
        error: null,
        completedAt: null,
        coverage: null,
        labelling: null,
        aggregates: [],
        episodes: [],
      });
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!eligible && !evaluation) return null;

  const evaluating = evaluation?.status === 'pending' || evaluation?.status === 'running';
  const cards = [
    ['Hit@1', 'hit@1'],
    ['MRR', 'reciprocal_rank'],
    ['Average precision', 'average_precision'],
    ['Precision@5', 'precision@5'],
    ['Recall@5', 'recall@5'],
  ] as const;
  const misses = (evaluation?.episodes ?? [])
    .filter((episode) => episode.metrics['hit@5']?.scored && episode.metrics['hit@5']?.value === 0)
    .slice(0, 8);

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Retrieval evaluation
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-950">
            Document precision and recall
          </h2>
          <p className="mt-2 max-w-3xl text-sm text-slate-600">
            Deterministic scoring of persisted retrieval calls against this dataset&apos;s expected
            source documents. These are retrieval metrics, not answer faithfulness.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {evaluation ? <Badge variant="outline">{evaluation.status}</Badge> : null}
          <Button
            disabled={busy || !eligible}
            onClick={() => start(evaluation ? 'recompute' : 'evaluate')}
            size="sm"
            variant="outline"
          >
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {evaluating ? 'Restart evaluation' : evaluation ? 'Recompute' : 'Evaluate retrieval'}
          </Button>
        </div>
      </div>

      {evaluating ? (
        <div className="mt-6 flex items-center gap-2 rounded-2xl bg-sky-50 p-4 text-sm text-sky-900">
          <Loader2 className="h-4 w-4 animate-spin" /> Scoring saved retrieval calls…
        </div>
      ) : null}

      {requestError || evaluation?.status === 'failed' ? (
        <div className="mt-6 flex items-start gap-2 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          {requestError ?? evaluation?.error ?? 'Retrieval evaluation failed.'}
        </div>
      ) : null}

      {!evaluation && eligible ? (
        <div className="mt-6 flex items-center gap-3 rounded-2xl border border-dashed border-slate-300 p-5 text-sm text-slate-600">
          <DatabaseZap className="h-5 w-5 text-sky-700" />
          This completed run has source labels and can be evaluated now.
        </div>
      ) : null}

      {evaluation?.status === 'ready' ? (
        <>
          <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {cards.map(([label, name]) => {
              const metric = aggregateByName.get(name);
              return (
                <article className="rounded-2xl border border-slate-200 p-4" key={name}>
                  <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
                  <p className="mt-2 text-2xl font-semibold text-slate-950">
                    {metricValue(metric?.value ?? null)}
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    n={metric?.scoredCount ?? 0}; {metric?.unscorableCount ?? 0} unscorable
                  </p>
                </article>
              );
            })}
          </div>

          <div className="mt-6 overflow-x-auto rounded-2xl border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr><th className="px-4 py-3">k</th><th className="px-4 py-3">Hit</th><th className="px-4 py-3">Precision</th><th className="px-4 py-3">Recall</th><th className="px-4 py-3">n scored</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {[1, 3, 5, 10, 20].map((k) => {
                  const hit = aggregateByName.get(`hit@${k}`);
                  const precision = aggregateByName.get(`precision@${k}`);
                  const recall = aggregateByName.get(`recall@${k}`);
                  return (
                    <tr key={k}>
                      <td className="px-4 py-3 font-medium text-slate-900">{k}</td>
                      <td className="px-4 py-3">{metricValue(hit?.value ?? null)}</td>
                      <td className="px-4 py-3">{metricValue(precision?.value ?? null)}</td>
                      <td className="px-4 py-3">{metricValue(recall?.value ?? null)}</td>
                      <td className="px-4 py-3 text-slate-500">{recall?.scoredCount ?? 0}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="mt-6 grid gap-4 lg:grid-cols-2">
            <article className="rounded-2xl border border-slate-200 p-5">
              <h3 className="text-sm font-semibold text-slate-900">Measurement coverage</h3>
              <dl className="mt-4 grid grid-cols-2 gap-4 text-sm">
                <div><dt className="text-slate-500">Document-labelled items</dt><dd className="font-semibold">{evaluation.labelling?.documentLabelled ?? 0}/{evaluation.labelling?.items ?? 0}</dd></div>
                <div><dt className="text-slate-500">Labelled share</dt><dd className="font-semibold">{percent(evaluation.labelling?.labelledShare ?? null)}</dd></div>
                <div><dt className="text-slate-500">Resolved chunk references</dt><dd className="font-semibold">{evaluation.coverage?.resolved ?? 0}/{(evaluation.coverage?.requested ?? 0) - (evaluation.coverage?.synthetic ?? 0)}</dd></div>
                <div><dt className="text-slate-500">Join resolution</dt><dd className="font-semibold">{percent(evaluation.coverage?.resolvedShare ?? null)}</dd></div>
              </dl>
              {(evaluation.coverage?.missing ?? 0) > 0 ? (
                <p className="mt-4 text-xs text-amber-700">
                  {evaluation.coverage?.missing} chunk references could not be resolved. Treat metrics cautiously.
                </p>
              ) : null}
            </article>

            <article className="rounded-2xl border border-slate-200 p-5">
              <h3 className="text-sm font-semibold text-slate-900">Reranker evidence</h3>
              <dl className="mt-4 grid grid-cols-3 gap-4 text-sm">
                {['rerank.mrr_retrieved', 'rerank.mrr_reranked', 'rerank.mrr_lift'].map((name) => {
                  const metric = aggregateByName.get(name);
                  return <div key={name}><dt className="text-slate-500">{name.replace('rerank.', '').replaceAll('_', ' ')}</dt><dd className="font-semibold">{metricValue(metric?.value ?? null)}</dd><dd className="text-xs text-slate-500">n={metric?.scoredCount ?? 0}</dd></div>;
                })}
              </dl>
              <p className="mt-4 text-xs text-slate-500">
                Reranker metrics exclude episodes where no rerank ranks were captured.
              </p>
            </article>
          </div>

          {misses.length > 0 ? (
            <article className="mt-6 rounded-2xl border border-slate-200 p-5">
              <h3 className="text-sm font-semibold text-slate-900">Retrieval misses at 5</h3>
              <ul className="mt-3 space-y-2">
                {misses.map((episode) => (
                  <li className="flex items-start gap-2 text-sm" key={episode.episodeId}>
                    <Badge
                      className={episode.passed
                        ? 'shrink-0 border-emerald-600/45 bg-emerald-600/12 text-emerald-900 dark:border-emerald-500/40 dark:bg-emerald-500/15 dark:text-emerald-50'
                        : 'shrink-0'}
                      variant={episode.passed ? 'outline' : 'destructive'}
                    >
                      {episode.passed ? 'Test passed' : 'Test failed'}
                    </Badge>
                    <a className="min-w-0 text-sky-700 underline-offset-2 hover:underline" href={`#run-item-result-${episode.episodeId}`}>
                      Row {episode.rowIndex}: {episode.question}
                    </a>
                  </li>
                ))}
              </ul>
            </article>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
