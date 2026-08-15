import { Badge } from '~/components/ui/badge';
import {
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '~/components/ui/table';
import { getAgentBadgeClassName } from '~/lib/bex/agent-badge';
import type { RouterDisagreementMatrix, RoutingComparisonSummary } from '~/lib/tests/routing-comparison';

type RoutingComparisonDashboardProps = {
  /** Distinct `test_result_id`s contributing to `disagreementMatrix`/`cutoverReport`. */
  totalRunCount: number;
  /** Total `test_result_items` rows with dual-router instrumentation across every run. */
  totalItemCount: number;
  disagreementMatrix: RouterDisagreementMatrix;
  cutoverReport: RoutingComparisonSummary;
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

function AccuracyBadge({ label, accuracy, count }: { label: string; accuracy: number | null; count: number }) {
  if (accuracy === null) {
    return <Badge variant="secondary">{label}: n/a (no ground truth)</Badge>;
  }
  return (
    <Badge
      className={
        accuracy >= 0.8
          ? 'border-emerald-600/45 bg-emerald-600/12 text-emerald-900'
          : accuracy >= 0.5
            ? 'border-amber-500/45 bg-amber-500/12 text-amber-900'
            : 'border-red-600/45 bg-red-600/12 text-red-900'
      }
      variant="outline"
    >
      {label}: {formatPercent(accuracy)} ({count} scored)
    </Badge>
  );
}

/**
 * B0-509 — cross-run routing comparison dashboard: keyword/LLM disagreement matrix, a latency
 * section that honestly reports "not available" (see comment below), and cutover-readiness signals.
 * Aggregate/system-wide counterpart to the per-run `RoutingAccuracyBoard` (B0-502) — this component
 * receives already-aggregated data (every run with dual-router instrumentation), not one run's items.
 */
export function RoutingComparisonDashboard({
  totalRunCount,
  totalItemCount,
  disagreementMatrix,
  cutoverReport,
}: RoutingComparisonDashboardProps) {
  if (totalItemCount === 0) {
    return (
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Routing comparison</h2>
        <p className="mt-3 text-sm text-slate-500">
          No dual-router instrumentation recorded anywhere yet (
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">keyword_route</code> is null on every{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">test_result_items</code> row). Run an eval
          suite through the current harness (B0-500/501) to populate this dashboard.
        </p>
      </section>
    );
  }

  const disagreementMax = disagreementMatrix.keywordLabels.reduce(
    (max, keywordLabel) =>
      Math.max(
        max,
        ...disagreementMatrix.llmLabels.map((llmLabel) => disagreementMatrix.counts[keywordLabel]?.[llmLabel] ?? 0),
      ),
    0,
  );

  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-slate-900">Routing comparison</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-600">
              Keyword router vs. LLM classifier, aggregated across every run with dual-router
              instrumentation (B0-500/501) — {totalItemCount} item{totalItemCount === 1 ? '' : 's'} across{' '}
              {totalRunCount} run{totalRunCount === 1 ? '' : 's'}.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <h3 className="mb-1 text-base font-semibold text-slate-900">Disagreement matrix</h3>
        <p className="mb-4 max-w-2xl text-sm text-slate-600">
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">keyword_route</code> (rows) vs.{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">llm_route</code> (columns), independent of
          ground truth. Diagonal cells are agreement; off-diagonal cells are disagreement, broken down by what
          each router proposed instead.
        </p>
        {disagreementMatrix.comparableCount === 0 ? (
          <p className="text-sm text-slate-500">No items had both routes recorded.</p>
        ) : (
          <>
            <p className="mb-4 text-sm text-slate-600">
              Disagreed on{' '}
              <span className="font-semibold text-slate-900">{disagreementMatrix.disagreementCount}</span> of{' '}
              {disagreementMatrix.comparableCount} comparable items (
              {disagreementMatrix.disagreementRate !== null ? formatPercent(disagreementMatrix.disagreementRate) : 'n/a'}{' '}
              disagreement rate).
            </p>
            <div className="max-h-[min(60vh,32rem)] overflow-auto overscroll-contain rounded-xl border border-slate-100">
              <table className="w-full caption-bottom text-sm">
                <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226,232,240)] [&_tr]:border-b-0">
                  <TableRow>
                    <TableHead className="whitespace-nowrap">Keyword ↓ / LLM →</TableHead>
                    {disagreementMatrix.llmLabels.map((llmLabel) => (
                      <TableHead className="text-right" key={llmLabel}>
                        <AgentBadge label={llmLabel} />
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {disagreementMatrix.keywordLabels.map((keywordLabel) => (
                    <TableRow key={keywordLabel}>
                      <TableCell className="whitespace-nowrap">
                        <AgentBadge label={keywordLabel} />
                      </TableCell>
                      {disagreementMatrix.llmLabels.map((llmLabel) => {
                        const count = disagreementMatrix.counts[keywordLabel]?.[llmLabel] ?? 0;
                        const isDiagonal = keywordLabel === llmLabel;
                        return (
                          <TableCell
                            className={`text-right font-mono text-xs ${
                              count === 0
                                ? 'text-slate-300'
                                : isDiagonal
                                  ? 'font-semibold text-emerald-700'
                                  : 'font-semibold text-red-700'
                            }`}
                            key={llmLabel}
                            title={
                              disagreementMax > 0
                                ? `${count} of ${disagreementMatrix.comparableCount} comparable items`
                                : undefined
                            }
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
          </>
        )}
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <h3 className="mb-1 text-base font-semibold text-slate-900">Latency profiling</h3>
        <p className="max-w-2xl text-sm text-slate-600">
          <span className="font-semibold text-amber-800">Not available yet.</span> Neither{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">test_result_items</code> nor{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">workflow_steps</code> records a
          classifier-specific latency: <code>elapsed_ms</code>/<code>ttft_ms</code> measure the whole eval item
          (including the real chat-turn answer), and{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">run-executor.ts</code>&apos;s dual-router
          instrumentation calls <code>routeUserMessageToSme</code> and <code>classifyUserIntent</code> with no
          timing capture around either call. Showing a chart here would mean fabricating numbers. To light this
          section up, add a <code>classifier_latency_ms</code> (or separate keyword/LLM columns) captured at the
          call sites in <code>~/lib/tests/run-executor.ts</code>.
        </p>
      </section>

      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <h3 className="mb-1 text-base font-semibold text-slate-900">Cutover-readiness signals</h3>
        <p className="mb-4 max-w-2xl text-sm text-slate-600">
          Plain accuracy/agreement stats, not a fabricated composite score — read all three before deciding
          whether the LLM router is ready to take over from the keyword router.
        </p>
        <div className="flex flex-wrap gap-3">
          {cutoverReport.agreementRate !== null ? (
            <Badge variant="outline">
              Agreement rate: {formatPercent(cutoverReport.agreementRate)} ({cutoverReport.agreementCount} of{' '}
              {cutoverReport.comparableCount} comparable)
            </Badge>
          ) : (
            <Badge variant="secondary">Agreement rate: n/a (no comparable items)</Badge>
          )}
          <AccuracyBadge
            accuracy={cutoverReport.llmAccuracy}
            count={cutoverReport.scoredItemCount}
            label="LLM accuracy vs. ground truth"
          />
          <AccuracyBadge
            accuracy={cutoverReport.keywordAccuracy}
            count={cutoverReport.scoredItemCount}
            label="Keyword accuracy vs. ground truth"
          />
        </div>
      </section>
    </div>
  );
}
