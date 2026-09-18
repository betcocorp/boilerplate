import { ChevronDownIcon } from 'lucide-react';
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
  LatencyDistribution,
  RouterDisagreementMatrix,
  RouterLatencyProfile,
  RouterLatencyStats,
  RoutingAgreement,
  RoutingComparisonSummary,
  SemanticLlmDisagreementMatrix,
  SemanticLlmLatencyProfile,
  SemanticRoutingReport,
  ThreeWayAgreementReport,
} from '~/lib/tests/routing-comparison';

type RoutingComparisonDashboardProps = {
  /** Distinct `test_result_id`s contributing to `disagreementMatrix`/`cutoverReport`. */
  totalRunCount: number;
  /** Total `test_result_items` rows with dual-router instrumentation across every run. */
  totalItemCount: number;
  /** Keyword vs. LLM — legacy comparison, demoted to a collapsed section (B0-668). */
  disagreementMatrix: RouterDisagreementMatrix;
  cutoverReport: RoutingComparisonSummary;
  /** B0-524 — null-safe: samples may be 0 if every row predates the latency columns. */
  latencyProfile: RouterLatencyProfile;
  /** B0-668 — LLM vs. semantic, the primary comparison. */
  semanticDisagreementMatrix: SemanticLlmDisagreementMatrix;
  semanticLatencyProfile: SemanticLlmLatencyProfile;
  semanticRoutingReport: SemanticRoutingReport;
  threeWayAgreement: ThreeWayAgreementReport;
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

function AccuracyBadge({
  label,
  accuracy,
  count,
}: {
  label: string;
  accuracy: number | null;
  count: number;
}) {
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

function LatencyStatBadge({
  label,
  stats,
}: {
  label: string;
  stats: RouterLatencyStats;
}) {
  if (stats.sampleCount === 0) {
    return <Badge variant="secondary">{label}: n/a (no samples)</Badge>;
  }
  return (
    <Badge variant="outline">
      {label}: {stats.medianMs}ms median / {stats.p95Ms}ms p95 (
      {stats.sampleCount} sample
      {stats.sampleCount === 1 ? '' : 's'})
    </Badge>
  );
}

function LatencyDistributionBadge({
  label,
  distribution,
}: {
  label: string;
  distribution: LatencyDistribution;
}) {
  if (distribution.sampleCount === 0) {
    return <Badge variant="secondary">{label}: n/a (no samples)</Badge>;
  }
  return (
    <Badge variant="outline">
      {label}: {distribution.p50Ms}ms p50 / {distribution.p95Ms}ms p95 /{' '}
      {distribution.p99Ms}ms p99 ({distribution.sampleCount} sample
      {distribution.sampleCount === 1 ? '' : 's'})
    </Badge>
  );
}

/**
 * B0-509/B0-668 — generic ground-truth/router-pair disagreement table, shared by the LLM-vs-semantic
 * (primary) and keyword-vs-LLM (demoted, legacy) sections so the two matrices render identically
 * apart from which pair of route columns feeds them.
 */
function DisagreementMatrixTable({
  rowLabels,
  columnLabels,
  counts,
  comparableCount,
  rowAxisLabel,
  columnAxisLabel,
}: {
  rowLabels: string[];
  columnLabels: string[];
  counts: Record<string, Record<string, number>>;
  comparableCount: number;
  rowAxisLabel: string;
  columnAxisLabel: string;
}) {
  return (
    <div className="max-h-[min(60vh,32rem)] overflow-auto overscroll-contain rounded-xl border border-slate-100">
      <table className="w-full caption-bottom text-sm">
        <TableHeader className="sticky top-0 z-10 bg-white shadow-[0_1px_0_0_rgb(226,232,240)] [&_tr]:border-b-0">
          <TableRow>
            <TableHead className="whitespace-nowrap">
              {rowAxisLabel} ↓ / {columnAxisLabel} →
            </TableHead>
            {columnLabels.map((columnLabel) => (
              <TableHead className="text-right" key={columnLabel}>
                <AgentBadge label={columnLabel} />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rowLabels.map((rowLabel) => (
            <TableRow key={rowLabel}>
              <TableCell className="whitespace-nowrap">
                <AgentBadge label={rowLabel} />
              </TableCell>
              {columnLabels.map((columnLabel) => {
                const count = counts[rowLabel]?.[columnLabel] ?? 0;
                const isDiagonal = rowLabel === columnLabel;
                return (
                  <TableCell
                    className={`text-right font-mono text-xs ${
                      count === 0
                        ? 'text-slate-300'
                        : isDiagonal
                          ? 'font-semibold text-emerald-700'
                          : 'font-semibold text-red-700'
                    }`}
                    key={columnLabel}
                    title={
                      comparableCount > 0
                        ? `${count} of ${comparableCount} comparable items`
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
  );
}

const THREE_WAY_AGREEMENT_LABELS: Record<RoutingAgreement, string> = {
  all_agree: 'All three agree',
  keyword_llm: 'Keyword + LLM agree (semantic differs)',
  keyword_semantic: 'Keyword + semantic agree (LLM differs)',
  llm_semantic: 'LLM + semantic agree (keyword differs)',
  all_differ: 'All three differ',
};

/**
 * B0-509/B0-652/B0-668 — cross-run routing comparison dashboard. Leads with LLM vs. semantic
 * (accuracy, disagreement matrix, latency profile, semantic's own accuracy/false-positive/fallback/
 * latency report, three-way agreement) — the pair actually likely to be used in production — and
 * demotes the original keyword-vs-LLM comparison to a collapsed "legacy" section below, per B0-668.
 * Aggregate/system-wide counterpart to the per-run `RoutingAccuracyBoard` (B0-502) — this component
 * receives already-aggregated data (every run with routing instrumentation), not one run's items.
 */
export function RoutingComparisonDashboard({
  totalRunCount,
  totalItemCount,
  disagreementMatrix,
  cutoverReport,
  latencyProfile,
  semanticDisagreementMatrix,
  semanticLatencyProfile,
  semanticRoutingReport,
  threeWayAgreement,
}: RoutingComparisonDashboardProps) {
  if (totalItemCount === 0) {
    return (
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">
          Routing comparison
        </h2>
        <p className="mt-3 text-sm text-slate-500">
          No dual-router instrumentation recorded anywhere yet (
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            keyword_route
          </code>{' '}
          is null on every{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            test_result_items
          </code>{' '}
          row). Run an eval suite through the current harness (B0-500/501) to
          populate this dashboard.
        </p>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <h3 className="mb-1 text-base font-semibold text-slate-900">
          Disagreement matrix — LLM vs. semantic
        </h3>
        <p className="mb-4 max-w-2xl text-sm text-slate-600">
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            semantic_route
          </code>{' '}
          (rows) vs.{' '}
          <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
            llm_route
          </code>{' '}
          (columns), independent of ground truth. Diagonal cells are agreement;
          off-diagonal cells are disagreement, broken down by what each router
          proposed instead.
        </p>
        {semanticDisagreementMatrix.comparableCount === 0 ? (
          <p className="text-sm text-slate-500">
            No items had both a semantic route and an LLM route recorded.
          </p>
        ) : (
          <>
            <p className="mb-4 text-sm text-slate-600">
              Disagreed on{' '}
              <span className="font-semibold text-slate-900">
                {semanticDisagreementMatrix.disagreementCount}
              </span>{' '}
              of {semanticDisagreementMatrix.comparableCount} comparable items (
              {semanticDisagreementMatrix.disagreementRate !== null
                ? formatPercent(semanticDisagreementMatrix.disagreementRate)
                : 'n/a'}{' '}
              disagreement rate).
            </p>
            <DisagreementMatrixTable
              columnAxisLabel="LLM"
              columnLabels={semanticDisagreementMatrix.llmLabels}
              comparableCount={semanticDisagreementMatrix.comparableCount}
              counts={semanticDisagreementMatrix.counts}
              rowAxisLabel="Semantic"
              rowLabels={semanticDisagreementMatrix.semanticLabels}
            />
          </>
        )}
      </section>

      {/* ---------------------------------------------------------------------------------- */}
      {/* Secondary/legacy: keyword vs. LLM, collapsed by default (B0-668)                    */}
      {/* ---------------------------------------------------------------------------------- */}

      <details className="group overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-sm">
        <summary className="flex cursor-pointer list-none flex-wrap items-center gap-3 px-8 py-6 hover:bg-slate-50">
          <h3 className="text-base font-semibold text-slate-900">
            Legacy: keyword vs. LLM router
          </h3>
          <Badge variant="secondary">
            Keyword is a legacy fallback, not a production candidate
          </Badge>
          <span className="ml-auto text-xs text-slate-500 transform transition-transform duration-300 group-open:rotate-180">
            <ChevronDownIcon className="h-4 w-4" />
          </span>
        </summary>
        <div className="flex flex-col gap-8 border-t border-slate-100 px-8 py-6">
          <div>
            <h4 className="mb-1 text-sm font-semibold text-slate-800">
              Disagreement matrix
            </h4>
            <p className="mb-4 max-w-2xl text-sm text-slate-600">
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
                keyword_route
              </code>{' '}
              (rows) vs.{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
                llm_route
              </code>{' '}
              (columns), independent of ground truth.
            </p>
            {disagreementMatrix.comparableCount === 0 ? (
              <p className="text-sm text-slate-500">
                No items had both routes recorded.
              </p>
            ) : (
              <>
                <p className="mb-4 text-sm text-slate-600">
                  Disagreed on{' '}
                  <span className="font-semibold text-slate-900">
                    {disagreementMatrix.disagreementCount}
                  </span>{' '}
                  of {disagreementMatrix.comparableCount} comparable items (
                  {disagreementMatrix.disagreementRate !== null
                    ? formatPercent(disagreementMatrix.disagreementRate)
                    : 'n/a'}{' '}
                  disagreement rate).
                </p>
                <DisagreementMatrixTable
                  columnAxisLabel="LLM"
                  columnLabels={disagreementMatrix.llmLabels}
                  comparableCount={disagreementMatrix.comparableCount}
                  counts={disagreementMatrix.counts}
                  rowAxisLabel="Keyword"
                  rowLabels={disagreementMatrix.keywordLabels}
                />
              </>
            )}
          </div>

          <div>
            <h4 className="mb-1 text-sm font-semibold text-slate-800">
              Latency profiling
            </h4>
            <p className="mb-4 max-w-2xl text-sm text-slate-600">
              Wall-clock time for each router&apos;s call in{' '}
              <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
                run-executor.ts
              </code>{' '}
              (B0-524).
            </p>
            {latencyProfile.keyword.sampleCount === 0 &&
            latencyProfile.llm.sampleCount === 0 ? (
              <p className="text-sm text-slate-500">
                No rows carry latency data yet — every item predates the B0-524
                columns.
              </p>
            ) : (
              <div className="flex flex-wrap gap-3">
                <LatencyStatBadge
                  label="Keyword router"
                  stats={latencyProfile.keyword}
                />
                <LatencyStatBadge
                  label="LLM classifier"
                  stats={latencyProfile.llm}
                />
              </div>
            )}
          </div>

          <div>
            <h4 className="mb-1 text-sm font-semibold text-slate-800">
              Cutover-readiness signals
            </h4>
            <p className="mb-4 max-w-2xl text-sm text-slate-600">
              Plain accuracy/agreement stats, not a fabricated composite score.
            </p>
            <div className="flex flex-wrap gap-3">
              {cutoverReport.agreementRate !== null ? (
                <Badge variant="outline">
                  Agreement rate: {formatPercent(cutoverReport.agreementRate)} (
                  {cutoverReport.agreementCount} of{' '}
                  {cutoverReport.comparableCount} comparable)
                </Badge>
              ) : (
                <Badge variant="secondary">
                  Agreement rate: n/a (no comparable items)
                </Badge>
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
          </div>
        </div>
      </details>

      <div className="grid grid-cols-3 gap-4">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-slate-900">
                Routing comparison
              </h2>
              <p className="mt-1 max-w-3xl text-sm text-slate-600">
                LLM classifier vs. semantic router, aggregated across every run
                with routing instrumentation (B0-500/501, B0-652) —{' '}
                {totalItemCount} item{totalItemCount === 1 ? '' : 's'} across{' '}
                {totalRunCount} run{totalRunCount === 1 ? '' : 's'}.
              </p>
            </div>
          </div>
        </section>

        {/* ---------------------------------------------------------------------------------- */}
        {/* Primary: LLM vs. semantic (B0-668)                                                  */}
        {/* ---------------------------------------------------------------------------------- */}

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h3 className="mb-1 text-base font-semibold text-slate-900">
            Accuracy comparison
          </h3>
          <p className="mb-4 max-w-2xl text-sm text-slate-600">
            Each router&apos;s own accuracy against ground truth (
            <code>intended_agent_label</code>), over its own scored-item
            denominator — the semantic router is often instrumented on fewer
            items than the LLM classifier, so the counts below can differ even
            when both are 100% healthy.
          </p>
          <div className="flex flex-wrap gap-3">
            <AccuracyBadge
              accuracy={cutoverReport.llmAccuracy}
              count={cutoverReport.scoredItemCount}
              label="LLM accuracy vs. ground truth"
            />
            <AccuracyBadge
              accuracy={cutoverReport.semanticAccuracy}
              count={cutoverReport.semanticScoredItemCount}
              label="Semantic accuracy vs. ground truth"
            />
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h3 className="mb-1 text-base font-semibold text-slate-900">
            Latency profiling — LLM vs. semantic
          </h3>
          <p className="mb-4 max-w-2xl text-sm text-slate-600">
            Wall-clock time for each router&apos;s call in{' '}
            <code className="rounded bg-slate-100 px-1 py-0.5 text-xs">
              run-executor.ts
            </code>{' '}
            (B0-524/B0-652) — measured independently of the real chat-turn
            answer&apos;s own latency.
          </p>
          {semanticLatencyProfile.semantic.sampleCount === 0 &&
          semanticLatencyProfile.llm.sampleCount === 0 ? (
            <p className="text-sm text-slate-500">
              No rows carry latency data yet — every item predates the latency
              columns. Run an eval suite through the current harness to populate
              this section.
            </p>
          ) : (
            <div className="flex flex-wrap gap-3">
              <LatencyStatBadge
                label="Semantic router"
                stats={semanticLatencyProfile.semantic}
              />
              <LatencyStatBadge
                label="LLM classifier"
                stats={semanticLatencyProfile.llm}
              />
            </div>
          )}
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h3 className="mb-1 text-base font-semibold text-slate-900">
            Semantic router — own report
          </h3>
          <p className="mb-4 max-w-2xl text-sm text-slate-600">
            B0-652 measurement set: accuracy (strict vs. lenient/plausible-agent
            grading, where available), false-positive rate (confident and
            wrong), fallback rate (declined to route), and a latency split
            between the embedding round-trip and the (much cheaper)
            cosine-scoring step.
          </p>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-3">
              <AccuracyBadge
                accuracy={semanticRoutingReport.accuracy.strictAccuracy}
                count={semanticRoutingReport.accuracy.scoredItemCount}
                label="Strict accuracy"
              />
              <AccuracyBadge
                accuracy={semanticRoutingReport.accuracy.lenientAccuracy}
                count={semanticRoutingReport.accuracy.scoredItemCount}
                label="Lenient accuracy"
              />
            </div>
            <div className="flex flex-wrap gap-3">
              {semanticRoutingReport.falsePositives.falsePositiveRate !==
              null ? (
                <Badge variant="outline">
                  False-positive rate:{' '}
                  {formatPercent(
                    semanticRoutingReport.falsePositives.falsePositiveRate,
                  )}{' '}
                  ({semanticRoutingReport.falsePositives.falsePositiveCount} of{' '}
                  {semanticRoutingReport.falsePositives.confidentItemCount}{' '}
                  confident)
                </Badge>
              ) : (
                <Badge variant="secondary">
                  False-positive rate: n/a (no confident routes)
                </Badge>
              )}
              {semanticRoutingReport.fallback.fallbackRate !== null ? (
                <Badge variant="outline">
                  Fallback rate:{' '}
                  {formatPercent(semanticRoutingReport.fallback.fallbackRate)} (
                  {semanticRoutingReport.fallback.fallbackCount} of{' '}
                  {semanticRoutingReport.fallback.pathPresentCount})
                </Badge>
              ) : (
                <Badge variant="secondary">
                  Fallback rate: n/a (router never reported a path)
                </Badge>
              )}
            </div>
            <div className="flex flex-wrap gap-3">
              <LatencyDistributionBadge
                distribution={semanticRoutingReport.latency.total}
                label="Total latency"
              />
              <LatencyDistributionBadge
                distribution={semanticRoutingReport.latency.embedding}
                label="Embedding round-trip"
              />
              <LatencyDistributionBadge
                distribution={semanticRoutingReport.latency.scoring}
                label="Cosine scoring"
              />
            </div>
          </div>
        </section>

        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <h3 className="mb-1 text-base font-semibold text-slate-900">
            Three-way agreement
          </h3>
          <p className="mb-4 max-w-2xl text-sm text-slate-600">
            Which pair of routers agreed, across every item where at least two
            of keyword/LLM/semantic reported a route — informative during a
            cutover: semantic tracking the LLM classifier is a very different
            story from semantic tracking the (legacy) keyword router the LLM
            disagrees with.
          </p>
          {threeWayAgreement.comparableCount === 0 ? (
            <p className="text-sm text-slate-500">
              No items had at least two routers report a route.
            </p>
          ) : (
            <>
              <p className="mb-4 text-sm text-slate-600">
                All three agreed on{' '}
                <span className="font-semibold text-slate-900">
                  {threeWayAgreement.counts.all_agree}
                </span>{' '}
                of {threeWayAgreement.comparableCount} comparable items (
                {threeWayAgreement.allAgreeRate !== null
                  ? formatPercent(threeWayAgreement.allAgreeRate)
                  : 'n/a'}
                ).
              </p>
              <div className="flex flex-wrap gap-3">
                {(
                  Object.entries(threeWayAgreement.counts) as Array<
                    [RoutingAgreement, number]
                  >
                ).map(([agreement, count]) => (
                  <Badge key={agreement} variant="outline">
                    {THREE_WAY_AGREEMENT_LABELS[agreement]}: {count}
                  </Badge>
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
