import { connection } from 'next/server';

import { RoutingComparisonDashboard } from '~/components/admin/tests/RoutingComparisonDashboard';
import { listRoutingComparisonRows } from '~/lib/tests/repository';
import {
  buildRouterDisagreementMatrix,
  computeRouterLatencyProfile,
  computeRoutingComparisonSummary,
  type RoutingComparisonSummaryInput,
} from '~/lib/tests/routing-comparison';

export const metadata = {
  title: 'Routing Comparison | Betco BEX',
  description:
    'Cross-run keyword vs. LLM router comparison: disagreement matrix, latency profiling, and cutover-readiness signals.',
};

/**
 * B0-509 — aggregate, cross-run counterpart to the per-run RoutingAccuracyBoard (B0-502, on
 * `/admin/tests/[testId]/runs/[runId]`). `listRoutingComparisonRows` returns every
 * `test_result_items` row across every test/run with dual-router instrumentation
 * (`keyword_route IS NOT NULL`, B0-500/501) — these are plain columns on that table, so no join
 * back to `test_items`/`tests` is needed for the comparison math itself.
 */
export default async function AdminRoutingComparisonPage() {
  await connection();

  const rows = await listRoutingComparisonRows();
  const totalRunCount = new Set(rows.map((row) => row.testResultId)).size;

  const disagreementMatrix = buildRouterDisagreementMatrix(
    rows.map((row) => ({ keywordRoute: row.keywordRoute, llmRoute: row.llmRoute })),
  );
  const summaryInputs: RoutingComparisonSummaryInput[] = rows.map((row) => ({
    intendedAgentLabel: row.intendedAgentLabel,
    routingDecision: row.routingDecision,
    keywordRoute: row.keywordRoute,
    llmRoute: row.llmRoute,
  }));
  const cutoverReport = computeRoutingComparisonSummary(summaryInputs);
  const latencyProfile = computeRouterLatencyProfile(
    rows.map((row) => ({
      keywordRouteLatencyMs: row.keywordRouteLatencyMs,
      llmRouteLatencyMs: row.llmRouteLatencyMs,
    })),
  );

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Routing comparison
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            Keyword vs. LLM router — cross-run
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
            Aggregates every eval item with dual-router instrumentation (B0-500/501), across every
            test and run, to help decide whether the LLM classifier is ready to take over routing
            from the keyword router. For a single run&apos;s confusion matrix and confidence
            distribution, see the &quot;Routing accuracy&quot; panel on that run&apos;s detail page.
          </p>
        </section>

        <RoutingComparisonDashboard
          cutoverReport={cutoverReport}
          disagreementMatrix={disagreementMatrix}
          latencyProfile={latencyProfile}
          totalItemCount={rows.length}
          totalRunCount={totalRunCount}
        />
      </main>
    </div>
  );
}
