/**
 * B0-335 — Prompt observability runs list (epic B0-330).
 *
 * Server component. All filters are searchParams-driven so the page is
 * linkable/bookmarkable and the filter bar can stay a plain GET form.
 *
 * B0-585 — the B0-336 aggregate dashboard that used to render above the runs
 * table is decommissioned: its figures live on `/admin/bex/health` now.
 */

import Link from 'next/link';
import { connection } from 'next/server';

import {
  RunsTable,
  type RunsTableFilters,
} from '~/components/admin/observability/RunsTable';
import { SME_AGENT_IDS } from '~/lib/agents/agent-registry';
import { resolveUserFilterInput } from '~/lib/observability/run-attribution';
import { listWorkflowRuns } from '~/lib/observability/runs-repository';
import { listTests } from '~/lib/tests/repository';
import { PRODUCT_TOOL_NAMES } from '~/lib/tools/tool-schemas';
import { readSearchParam } from '~/lib/utils/params';

import type { RunSourceFilter, WorkflowRunListRow } from '~/types/observability';

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
/** B0-593 — the static, compile-time set of callable tool names, for the "Tool call" filter. */
const TOOL_NAMES = new Set<string>(PRODUCT_TOOL_NAMES);
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

  const toolParam = readSearchParam(params.tool).trim();
  const toolName = TOOL_NAMES.has(toolParam) ? toolParam : '';

  const confidenceMin = readConfidence(readSearchParam(params.confidenceMin).trim());
  const confidenceMax = readConfidence(readSearchParam(params.confidenceMax).trim());

  const search = normalizeSearchTerm(readSearchParam(params.q));

  const sourceParam = readSearchParam(params.source).trim();
  const source: RunSourceFilter | undefined = RUN_SOURCE_FILTERS.has(sourceParam)
    ? (sourceParam as RunSourceFilter)
    : undefined;

  // B0-338 — "single test" filter. `tests` is a couple dozen rows, cheap to fetch for the
  // dropdown and to validate the requested id against; a failure here degrades to an empty
  // dropdown rather than breaking the runs list (caught separately from the main load below).
  let testOptions: { id: string; name: string }[] = [];
  try {
    testOptions = (await listTests()).map((test) => ({ id: test.id, name: test.name }));
  } catch {
    testOptions = [];
  }
  const testIdParam = readSearchParam(params.testId).trim();
  const testId = testOptions.some((test) => test.id === testIdParam) ? testIdParam : '';

  // B0-338 — "single user" filter. Accepts a raw `app_user.user_id` (plain text — Salesforce ids,
  // GUIDs, …) or an email address, resolved to a user_id below. Capped rather than
  // shape-validated, mirroring the prompt search term above.
  const userId = readSearchParam(params.userId).trim().slice(0, SEARCH_MAX_CHARS);
  // An email that matches no `app_user` row resolves to null: the filter must return "no runs
  // match" rather than silently ignoring a stale/typo'd filter and showing everyone's runs.
  const resolvedUserId = userId ? await resolveUserFilterInput(userId) : undefined;
  const userFilterMatchedNothing = Boolean(userId) && resolvedUserId === null;

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
    userId,
    testId,
    toolName,
  };

  let loadError: string | null = null;
  let rows: WorkflowRunListRow[] = [];
  let hasMore = false;

  try {
    // When the typed email/id matched no `app_user` row, skip the fetch — the table must
    // report "no runs match" rather than silently dropping the filter and showing every
    // user's runs.
    if (!userFilterMatchedNothing) {
      const runs = await listWorkflowRuns({
        from: windowFrom,
        to: windowTo,
        status: status || undefined,
        routingDecision: routingDecision || undefined,
        confidenceMin: confidenceMin.parsed,
        confidenceMax: confidenceMax.parsed,
        source,
        search: search || undefined,
        userId: resolvedUserId || undefined,
        testId: testId || undefined,
        toolName: toolName || undefined,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      });
      rows = runs.rows;
      hasMore = runs.hasMore;
    }
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
          <p className="mt-3 max-w-3xl text-sm leading-6 text-slate-500">
            Looking for the aggregate dashboard (totals, confidence health, latency by step)?
            It moved to{' '}
            <Link
              className="font-medium text-sky-700 underline-offset-2 hover:underline"
              href="/admin/bex/health"
            >
              Bex health
            </Link>
            .
          </p>
        </section>

        {loadError ? (
          <section className="rounded-3xl border border-destructive/30 bg-destructive/5 p-6 text-sm text-destructive">
            {loadError}
          </section>
        ) : null}

        <RunsTable
          filters={filters}
          hasMore={hasMore}
          page={page}
          route={ROUTE}
          rows={rows}
          testOptions={testOptions}
        />
      </main>
    </div>
  );
}
