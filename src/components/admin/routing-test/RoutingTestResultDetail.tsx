'use client';

import { Badge } from '~/components/ui/badge';
import type { RoutingTestItemResult } from '~/lib/routing-test/types';

function formatScore(value: number): string {
  return value.toFixed(3);
}

/**
 * Shows whatever the selected router already reports — nothing is recomputed or invented here.
 * Keyword: matched phrases, decision path, rationale. Semantic: confidence, margin, path, scores.
 */
export function RoutingTestResultDetail({
  result,
}: {
  result: RoutingTestItemResult;
}) {
  const { detail, error } = result;

  return (
    <div className="flex flex-col gap-1.5 text-xs leading-relaxed text-slate-600">
      {error ? (
        <p className="font-medium text-amber-700">Router degraded: {error}</p>
      ) : null}

      {detail?.kind === 'keyword' ? (
        <>
          <p>
            <span className="font-medium text-slate-800">Path:</span>{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5">
              {detail.decisionPath}
            </code>
          </p>
          <p className="text-slate-600">{detail.rationale}</p>
          <div className="flex flex-wrap gap-1">
            {Object.entries(detail.matchedPhrases)
              .filter(([, phrases]) => phrases.length > 0)
              .map(([category, phrases]) => (
                <Badge key={category} variant="outline">
                  {category}: {phrases.join(', ')}
                </Badge>
              ))}
            {Object.values(detail.matchedPhrases).every(
              (phrases) => phrases.length === 0,
            ) ? (
              <span className="text-slate-500">No keyword phrases matched.</span>
            ) : null}
          </div>
        </>
      ) : null}

      {detail?.kind === 'semantic' ? (
        <>
          <p>
            <span className="font-medium text-slate-800">Confidence:</span>{' '}
            {formatScore(detail.confidence)}{' '}
            <span className="text-slate-400">|</span>{' '}
            <span className="font-medium text-slate-800">Margin:</span>{' '}
            {formatScore(detail.margin)}{' '}
            <span className="text-slate-400">|</span>{' '}
            <span className="font-medium text-slate-800">Path:</span>{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5">
              {detail.path}
            </code>
          </p>
          <p className="text-slate-500">
            Thresholds — confidence {formatScore(detail.thresholds.confidence)}{' '}
            {detail.thresholdsPassed.confidence ? 'met' : 'not met'}, margin{' '}
            {formatScore(detail.thresholds.margin)}{' '}
            {detail.thresholdsPassed.margin ? 'met' : 'not met'} ·{' '}
            {detail.latencyMs}ms · {detail.embeddingModel} ·{' '}
            {detail.examplesVersion}
          </p>
          <div className="flex flex-wrap gap-1">
            {detail.scores.slice(0, 5).map((score) => (
              <Badge key={score.route} variant="outline">
                {score.route}: {formatScore(score.similarity)}
              </Badge>
            ))}
          </div>
        </>
      ) : null}

      {detail?.kind === 'llm' ? (
        <>
          <p>
            <span className="font-medium text-slate-800">Source:</span>{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5">
              {detail.source}
            </code>{' '}
            <span className="text-slate-400">|</span>{' '}
            <span className="font-medium text-slate-800">Confidence:</span>{' '}
            {formatScore(detail.confidence)}
          </p>
          <p className="text-slate-500">
            {detail.model ? `Model: ${detail.model}` : 'No model call (fallback)'}
            {detail.suggestedTool ? ` · Suggested tool: ${detail.suggestedTool}` : ''}
          </p>
          {detail.fallbackReason ? (
            <p className="text-amber-700">
              Fallback reason: {detail.fallbackReason}
            </p>
          ) : null}
        </>
      ) : null}

      {!detail && !error ? (
        <span className="text-slate-500">No router detail reported.</span>
      ) : null}
    </div>
  );
}
