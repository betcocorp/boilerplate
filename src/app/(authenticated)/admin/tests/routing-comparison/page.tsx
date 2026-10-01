import { connection } from 'next/server';

import { RoutingComparisonDashboard } from '~/components/admin/tests/RoutingComparisonDashboard';
import { PERMISSIONS } from '~/lib/permissions/constants';
import { requirePagePermission } from '~/lib/permissions/require-page-permission';
import { listRoutingComparisonRows } from '~/lib/tests/repository';
import {
  buildRouterDisagreementMatrix,
  buildSemanticLlmDisagreementMatrix,
  computeRouterLatencyProfile,
  computeRoutingComparisonSummary,
  computeSemanticLlmLatencyProfile,
  computeSemanticRoutingReport,
  computeThreeWayAgreement,
  type RoutingComparisonSummaryInput,
  type SemanticRoutingItem,
} from '~/lib/tests/routing-comparison';

export const metadata = {
  title: 'Routing Comparison | Betco BEX',
  description:
    'Cross-run LLM vs. semantic router comparison: disagreement matrix, latency profiling, and cutover-readiness signals (keyword vs. LLM legacy comparison available below).',
};

/**
 * B0-509 — aggregate, cross-run counterpart to the per-run RoutingAccuracyBoard (B0-502, on
 * `/admin/tests/[testId]/runs/[runId]`). `listRoutingComparisonRows` returns every
 * `test_result_items` row across every test/run with dual-router instrumentation
 * (`keyword_route IS NOT NULL`, B0-500/501) — these are plain columns on that table, so no join
 * back to `test_items`/`tests` is needed for the comparison math itself.
 */
export default async function AdminRoutingComparisonPage() {
  await requirePagePermission(
    PERMISSIONS.NAVIGATION_SIDEBAR_TESTS,
    'GET /admin/tests/routing-comparison',
  );
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

  // B0-668 — LLM vs. semantic is now the primary comparison; keyword vs. LLM above is demoted to a
  // secondary section in the dashboard component but still computed the same way.
  const semanticDisagreementMatrix = buildSemanticLlmDisagreementMatrix(
    rows.map((row) => ({ semanticRoute: row.semanticRoute, llmRoute: row.llmRoute })),
  );
  const semanticLatencyProfile = computeSemanticLlmLatencyProfile(
    rows.map((row) => ({
      semanticRouteLatencyMs: row.semanticRouteLatencyMs,
      llmRouteLatencyMs: row.llmRouteLatencyMs,
    })),
  );
  const semanticRoutingItems: SemanticRoutingItem[] = rows.map((row) => ({
    intendedAgentLabel: row.intendedAgentLabel,
    semanticRoute: row.semanticRoute,
    semanticPath: row.semanticPath,
    semanticRouteLatencyMs: row.semanticRouteLatencyMs,
    semanticEmbeddingMs: row.semanticEmbeddingMs,
    semanticScoringMs: row.semanticScoringMs,
  }));
  const semanticRoutingReport = computeSemanticRoutingReport(semanticRoutingItems);
  const threeWayAgreement = computeThreeWayAgreement(
    rows.map((row) => ({
      keywordRoute: row.keywordRoute,
      llmRoute: row.llmRoute,
      semanticRoute: row.semanticRoute,
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
            LLM vs. semantic router — cross-run
          </h1>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-600">
            Aggregates every eval item with router instrumentation (B0-500/501, B0-652), across
            every test and run, to help decide whether the semantic router is ready for a wider
            rollout against the LLM classifier — the two routers actually likely to be used in
            production. The keyword router is a legacy fallback and its comparison against the LLM
            classifier is still available below, demoted. For a single run&apos;s confusion matrix
            and confidence distribution, see the &quot;Routing accuracy&quot; panel on that
            run&apos;s detail page.
          </p>
        </section>

        <RoutingComparisonDashboard
          cutoverReport={cutoverReport}
          disagreementMatrix={disagreementMatrix}
          latencyProfile={latencyProfile}
          semanticDisagreementMatrix={semanticDisagreementMatrix}
          semanticLatencyProfile={semanticLatencyProfile}
          semanticRoutingReport={semanticRoutingReport}
          threeWayAgreement={threeWayAgreement}
          totalItemCount={rows.length}
          totalRunCount={totalRunCount}
        />
      </main>
    </div>
  );
}
