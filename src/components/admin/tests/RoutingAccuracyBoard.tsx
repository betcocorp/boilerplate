import { Badge } from '~/components/ui/badge';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { getAgentBadgeClassName } from '~/lib/bex/agent-badge';
import type {
  AmbiguousRateReport,
  ConfidenceDistribution,
  ConfusionMatrix,
  RoutingComparisonReport,
} from '~/lib/tests/routing-comparison';

type RoutingAccuracyBoardProps = {
  /** Whether ANY item in this run carries dual-router instrumentation at all (`keyword_route` set) —
   * distinct from `comparisonReport.scoredItemCount`, which is further narrowed to items that also
   * have ground truth. Runs that predate B0-500/501 have neither. */
  hasRoutingInstrumentation: boolean;
  comparisonReport: RoutingComparisonReport;
  keywordConfusionMatrix: ConfusionMatrix;
  llmConfusionMatrix: ConfusionMatrix;
  ambiguousRates: AmbiguousRateReport;
  confidenceDistribution: ConfidenceDistribution;
};

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function AgentBadge({ label }: { label: string }) {
  return (
    <Badge className={getAgentBadgeClassName(label)} variant="outline">
      {label}
    </Badge>
  );
}

function ConfusionMatrixTable({ matrix, routerLabel }: { matrix: ConfusionMatrix; routerLabel: string }) {
  if (matrix.totalCount === 0) {
    return (
      <p className="text-sm text-slate-500">
        No scored items (ground truth + a {routerLabel} route both present) for this run.
      </p>
    );
  }

  return (
    <div className="max-h-[min(50vh,26rem)] overflow-auto overscroll-contain rounded-xl border border-slate-100">
      <table className="w-full caption-bottom text-sm">
        <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226,232,240)] [&_tr]:border-b-0">
          <TableRow>
            <TableHead className="whitespace-nowrap">Ground truth ↓ / {routerLabel} →</TableHead>
            {matrix.predictedLabels.map((label) => (
              <TableHead className="text-right" key={label}>
                <AgentBadge label={label} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {matrix.groundTruthLabels.map((groundTruth) => (
            <TableRow key={groundTruth}>
              <TableCell className="whitespace-nowrap">
                <AgentBadge label={groundTruth} />
              </TableCell>
              {matrix.predictedLabels.map((predicted) => {
                const count = matrix.counts[groundTruth]?.[predicted] ?? 0;
                const isDiagonal = groundTruth === predicted;
                return (
                  <TableCell
                    className={`text-right font-mono text-xs ${
                      count === 0
                        ? 'text-slate-300'
                        : isDiagonal
                          ? 'font-semibold text-emerald-700'
                          : 'font-semibold text-red-700'
                    }`}
                    key={predicted}
                  >
                    {count === 0 ? '—' : count}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
        </TableBody>
      </table>
    </div>
  );
}

/**
 * B0-502 — per-run routing accuracy board: confusion matrix (ground truth vs. keyword/LLM route),
 * ambiguous rate, and confidence distribution. Sibling of `RunToolRoutingPanel` (B0-383) — same
 * card shell, same "headline badge + detail below" layout — but scoped to the SME-routing decision
 * (`keyword_route`/`llm_route`/`intended_agent_label`) rather than tool calls.
 */
export function RoutingAccuracyBoard({
  hasRoutingInstrumentation,
  comparisonReport,
  keywordConfusionMatrix,
  llmConfusionMatrix,
  ambiguousRates,
  confidenceDistribution,
}: RoutingAccuracyBoardProps) {
  const { scoredItemCount, keywordAccuracy, llmAccuracy, agreementRate, agreementCount } = comparisonReport;

  const confidenceMax = confidenceDistribution.buckets.reduce(
    (max, bucket) => Math.max(max, bucket.count),
    0,
  );

  return (
    <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">Routing accuracy</h2>
          <p className="mt-1 max-w-2xl text-sm text-slate-600">
            Keyword router (<code className="rounded bg-slate-100 px-1 py-0.5 text-xs">keyword_route</code>) vs.
            LLM classifier (<code className="rounded bg-slate-100 px-1 py-0.5 text-xs">llm_route</code>) against
            ground truth (<code className="rounded bg-slate-100 px-1 py-0.5 text-xs">intended_agent_label</code>
            ) for this run (B0-500/501 dual-router instrumentation).
          </p>
        </div>
        {scoredItemCount > 0 && keywordAccuracy !== null && llmAccuracy !== null ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              className={
                keywordAccuracy >= 0.8
                  ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900'
                  : keywordAccuracy >= 0.5
                    ? 'border-amber-500/45 bg-amber-500/12 text-amber-900'
                    : 'border-red-600/45 bg-red-600/12 text-red-900'
              }
              variant="outline"
            >
              Keyword {formatPercent(keywordAccuracy)} ({scoredItemCount} scored)
            </Badge>
            <Badge
              className={
                llmAccuracy >= 0.8
                  ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900'
                  : llmAccuracy >= 0.5
                    ? 'border-amber-500/45 bg-amber-500/12 text-amber-900'
                    : 'border-red-600/45 bg-red-600/12 text-red-900'
              }
              variant="outline"
            >
              LLM {formatPercent(llmAccuracy)} ({scoredItemCount} scored)
            </Badge>
          </div>
        ) : (
          <Badge variant="secondary">
            No ground truth (<code>intended_agent_label</code>) on this run&apos;s items — nothing to score
          </Badge>
        )}
      </div>

      {!hasRoutingInstrumentation ? (
        <p className="text-sm text-slate-500">
          No dual-router instrumentation recorded for this run — it predates B0-500/501, or the run
          never populated <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">keyword_route</code>/
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">llm_route</code>.
        </p>
      ) : (
        <div className="space-y-8">
          {agreementRate !== null ? (
            <p className="text-sm text-slate-600">
              Keyword and LLM agreed on <span className="font-semibold text-slate-900">{agreementCount}</span> of
              the comparable items ({formatPercent(agreementRate)} agreement rate), independent of ground truth.
            </p>
          ) : null}

          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">Ambiguous rate</h3>
            <p className="mb-3 max-w-2xl text-xs text-slate-500">
              How often each router gave up and reported <code>ambiguous</code> instead of a specialist. This is
              the only tie signal recoverable from stored data — the keyword router&apos;s real tie-break detail
              isn&apos;t persisted, only the already-collapsed <code>ambiguous</code> label is — so treat this as
              an ambiguous-outcome rate, not a literal keyword-scoring tie rate.
            </p>
            <div className="flex flex-wrap gap-3">
              <Badge variant="outline">
                Keyword ambiguous:{' '}
                {ambiguousRates.keywordAmbiguousRate !== null
                  ? `${formatPercent(ambiguousRates.keywordAmbiguousRate)} (${ambiguousRates.keywordAmbiguousCount}/${ambiguousRates.keywordPresentCount})`
                  : 'n/a'}
              </Badge>
              <Badge variant="outline">
                LLM ambiguous:{' '}
                {ambiguousRates.llmAmbiguousRate !== null
                  ? `${formatPercent(ambiguousRates.llmAmbiguousRate)} (${ambiguousRates.llmAmbiguousCount}/${ambiguousRates.llmPresentCount})`
                  : 'n/a'}
              </Badge>
            </div>
          </div>

          <div>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">LLM confidence distribution</h3>
            <p className="mb-3 max-w-2xl text-xs text-slate-500">
              Buckets of <code>routing_confidence</code> (LLM classifier only — the keyword router has no
              analogous score).
            </p>
            {confidenceDistribution.totalCount - confidenceDistribution.missingCount === 0 ? (
              <p className="text-sm text-slate-500">No confidence values recorded for this run.</p>
            ) : (
              <div className="space-y-2">
                {confidenceDistribution.buckets.map((bucket) => (
                  <div className="flex items-center gap-3" key={bucket.label}>
                    <span className="w-20 shrink-0 font-mono text-xs text-slate-700">{bucket.label}</span>
                    <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-sky-600"
                        style={{
                          width: `${confidenceMax > 0 ? Math.max(4, (bucket.count / confidenceMax) * 100) : 0}%`,
                        }}
                      />
                    </div>
                    <span className="w-20 shrink-0 whitespace-nowrap text-right text-xs text-slate-600">
                      {bucket.count} item{bucket.count === 1 ? '' : 's'}
                    </span>
                  </div>
                ))}
                {confidenceDistribution.missingCount > 0 ? (
                  <p className="pt-1 text-xs text-slate-400">
                    {confidenceDistribution.missingCount} item{confidenceDistribution.missingCount === 1 ? '' : 's'}{' '}
                    had no recorded confidence value.
                  </p>
                ) : null}
              </div>
            )}
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="mb-3 text-sm font-semibold text-slate-800">Keyword confusion matrix</h3>
              <ConfusionMatrixTable matrix={keywordConfusionMatrix} routerLabel="keyword" />
            </div>
            <div>
              <h3 className="mb-3 text-sm font-semibold text-slate-800">LLM confusion matrix</h3>
              <ConfusionMatrixTable matrix={llmConfusionMatrix} routerLabel="LLM" />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
