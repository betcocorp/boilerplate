/**
 * B0-335 / B0-336 — Prompt observability runs list + aggregate dashboard (epic B0-330).
 *
 * Server component. All filters are searchParams-driven so the page is
 * linkable/bookmarkable and the filter bar can stay a plain GET form.
 */

import { connection } from 'next/server';

import { AggregateDashboard } from '~/components/admin/observability/AggregateDashboard';
import {
  RunsTable,
  type RunsTableFilters,
} from '~/components/admin/observability/RunsTable';
import { SME_AGENT_IDS } from '~/lib/agents/agent-registry';
import { getAggregateDashboardData } from '~/lib/observability/aggregates';
import { listWorkflowRuns } from '~/lib/observability/runs-repository';
import { readSearchParam } from '~/lib/utils/params';

import type {
  AggregateDashboardData,
  RunSourceFilter,
  WorkflowRunListRow,
} from '~/types/observability';

export const metadata = {
  title: 'Prompt observability | Betco BEX',
  description: 'Workflow runs across Bex chat, the v1 orchestrator API, and the test harness.',
};

const ROUTE = '/admin/observability';
const PAGE_SIZE = 50;
/** Inclusive default window: today plus the previous 6 UTC days. */
const DEFAULT_WINDOW_DAYS = 7;
const RUN_STATUSES = new Set(['running', 'completed', 'failed']);
/**
 * B0-416 — accepted `source` values: the stored `workflow_runs.source` enum plus `unknown`
 * for the pre-instrumentation NULL cohort. Mirrors `RunSourceFilter`.
 */
const RUN_SOURCE_FILTERS = new Set(['harness', 'bex_chat', 'orchestrator_api', 'unknown']);
/** `routingDecisionSchema` values: an SME agent id, or the planner's `ambiguous`. */
const ROUTING_DECISIONS = new Set<string>([...SME_AGENT_IDS, 'ambiguous']);
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
/** B0-431 — bound on the `q` term so a pathological URL can't build a huge LIKE pattern. */
const SEARCH_MAX_CHARS = 200;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** `YYYY-MM-DD` in UTC. */
function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function readDay(value: string, fallback: string): string {
  return DAY_PATTERN.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`))
    ? value
    : fallback;
}

/**
 * B0-431 — strips the characters that carry meaning inside a PostgREST filter
 * expression, so a search term stays a search term. Mirrors the normalization on
 * `/admin/products/legacy`. `%` and `*` both go because PostgREST accepts either as
 * the `ilike` wildcard, and one of them alone would match every run. `_` is left
 * alone deliberately: it is only a single-character wildcard, so it still matches
 * itself — stripping it would break searches for prompts containing underscores.
 */
function normalizeSearchTerm(value: string): string {
  return value
    .trim()
    .slice(0, SEARCH_MAX_CHARS)
    .replaceAll(',', ' ')
    .replaceAll('%', '')
    .replaceAll('*', '')
    .replaceAll('(', '')
    .replaceAll(')', '')
    .trim();
}

/** Confidence bounds are 0–1; anything else is treated as "not filtered". */
function readConfidence(value: string): { raw: string; parsed: number | undefined } {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    return { raw: '', parsed: undefined };
  }
  return { raw: value, parsed };
}

export default async function AdminObservabilityPage({ searchParams }: PageProps) {
  await connection();
  const params = await searchParams;

  const now = new Date();
  const defaultTo = utcDay(now);
  const defaultFrom = utcDay(
    new Date(now.getTime() - (DEFAULT_WINDOW_DAYS - 1) * 24 * 60 * 60 * 1000),
  );

  const fromDay = readDay(readSearchParam(params.from), defaultFrom);
  const toDayRequested = readDay(readSearchParam(params.to), defaultTo);
  // Guard against an inverted range typed into the date inputs.
  const toDay = toDayRequested < fromDay ? fromDay : toDayRequested;

  const statusParam = readSearchParam(params.status).trim();
  const status = RUN_STATUSES.has(statusParam) ? statusParam : '';

  const agentParam = readSearchParam(params.agent).trim();
  const routingDecision = ROUTING_DECISIONS.has(agentParam) ? agentParam : '';

  const confidenceMin = readConfidence(readSearchParam(params.confidenceMin).trim());
  const confidenceMax = readConfidence(readSearchParam(params.confidenceMax).trim());

  const search = normalizeSearchTerm(readSearchParam(params.q));

  const sourceParam = readSearchParam(params.source).trim();
  const source: RunSourceFilter | undefined = RUN_SOURCE_FILTERS.has(sourceParam)
    ? (sourceParam as RunSourceFilter)
    : undefined;

  const requestedPage = Number.parseInt(readSearchParam(params.page, '1'), 10);
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1;

  const windowFrom = `${fromDay}T00:00:00.000Z`;
  const windowTo = `${toDay}T23:59:59.999Z`;

  const filters: RunsTableFilters = {
    from: fromDay,
    to: toDay,
    status,
    routingDecision,
    confidenceMin: confidenceMin.raw,
    confidenceMax: confidenceMax.raw,
    source: source ?? '',
    search,
  };

  let loadError: string | null = null;
  let rows: WorkflowRunListRow[] = [];
  let hasMore = false;
  let aggregates: AggregateDashboardData | null = null;

  try {
    const [runs, dashboard] = await Promise.all([
      listWorkflowRuns({
        from: windowFrom,
        to: windowTo,
        status: status || undefined,
        routingDecision: routingDecision || undefined,
        confidenceMin: confidenceMin.parsed,
        confidenceMax: confidenceMax.parsed,
        source,
        search: search || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      }),
      getAggregateDashboardData({ from: windowFrom, to: windowTo }),
    ]);
    rows = runs.rows;
    hasMore = runs.hasMore;
    aggregates = dashboard;
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : 'Unable to load workflow runs. If this persists, check the Supabase service-role configuration.';
  }

  return (
    <div className="flex flex-1 bg-slate-50">
      <main className="flex w-full flex-1 flex-col gap-8 px-6 py-10 sm:px-8">

        {/* Header */}
        <section className="rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-sky-700">
            Observability
          </p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
            Prompt observability
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-slate-600">
            Every product-support workflow run, whichever entry point produced it —
            the Bex chat UI, the <code>/api/v1/orchestrator</code> API, or the
            golden-set test harness. Each run records its own entry point, so it can
            be included or excluded; runs from before that was recorded show as
            unknown. Select a run to open its trace.
          </p>
        </section>

        {loadError ? (
          <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
            {loadError}
          </section>
        ) : null}

        {aggregates ? <AggregateDashboard data={aggregates} /> : null}

        <RunsTable
          filters={filters}
          hasMore={hasMore}
          page={page}
          route={ROUTE}
          rows={rows}
        />
      </main>
    </div>
  );
}
