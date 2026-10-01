/**
 * B0-332 — read-only repository for the Prompt Observability admin feature (epic B0-330).
 *
 * Deliberately separate from `~/lib/conversations/workflow-repository.ts`, which
 * owns the write path *during* a run. Nothing here writes.
 *
 * The single-run trace page composes the existing readers
 * (`getWorkflowRunWithSteps` + `listAuditLogsForRun`) — see `getWorkflowRunTrace`
 * below — so that logic is not duplicated.
 */

import {
  getWorkflowRunWithSteps,
  listAuditLogsForRun,
  type WorkflowRunRow,
  type WorkflowStepRow,
} from '~/lib/conversations/workflow-repository';
import {
  getRunAttribution,
  resolveConversationIdsForUser,
  resolveRunAttributions,
  resolveWorkflowRunIdsForTest,
} from '~/lib/observability/run-attribution';
import {
  buildRunTimeline,
  deriveRunEmptyState,
  type RunEmptyState,
} from '~/lib/observability/timeline';
import { gradeFromScore, WEIGHTS } from '~/lib/tests/report/metrics';
import { parseReportState, type CaseScore } from '~/lib/tests/report/schemas';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type {
  AuditLogRow,
  ListWorkflowRunsFilters,
  RunAttribution,
  RunScore,
  RunSource,
  TimelineEvent,
  WorkflowRunListRow,
} from '~/types/observability';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Cap for the list view's `userMessagePreview`; the full text lives on the trace page. */
const USER_MESSAGE_PREVIEW_MAX_CHARS = 160;

/** PostgREST page size when sweeping `test_result_items` for harness TTFT values. */
const HARNESS_SCAN_PAGE_SIZE = 1000;
const HARNESS_SCAN_MAX_PAGES = 25;

/** B0-416 — the CHECK-constrained `workflow_runs.source` values, for narrowing the raw text. */
const RUN_SOURCES: readonly string[] = ['harness', 'bex_chat', 'orchestrator_api'];

const RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * B0-431 — a search term shaped like a `workflow_runs.id` is an id lookup rather than prompt
 * text, so pasting a run id out of a log line or a trace URL finds that exact run. Exported for
 * unit tests: getting this wrong fails silently, as an id search would fall through to a text
 * match on the prompt and return nothing.
 */
export function isRunIdSearchTerm(term: string): boolean {
  return RUN_ID_PATTERN.test(term);
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function clampOffset(offset: number | undefined): number {
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) {
    return 0;
  }
  return Math.floor(offset);
}

/**
 * B0-416 — narrows the raw `workflow_runs.source` text to the stored enum. Exported for unit
 * tests: the database CHECK constraint only guarantees the shape of rows written *after* the
 * migration, and every run predating it is legitimately null (unknown), which must not be
 * silently reported as one of the real sources.
 */
export function readRunSource(value: string | null): RunSource | null {
  return value !== null && RUN_SOURCES.includes(value) ? (value as RunSource) : null;
}

/** `final_output->>routingDecision`, read off the already-fetched row. */
function readRoutingDecision(finalOutput: unknown): string | null {
  if (!finalOutput || typeof finalOutput !== 'object' || Array.isArray(finalOutput)) {
    return null;
  }
  const value = (finalOutput as Record<string, unknown>).routingDecision;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** `user_input` is `{ message, modelTag }` (see run-product-support-workflow.ts). */
function readUserMessagePreview(userInput: unknown): string | null {
  if (!userInput || typeof userInput !== 'object' || Array.isArray(userInput)) {
    return null;
  }
  const value = (userInput as Record<string, unknown>).message;
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.length > USER_MESSAGE_PREVIEW_MAX_CHARS
    ? `${trimmed.slice(0, USER_MESSAGE_PREVIEW_MAX_CHARS - 1)}…`
    : trimmed;
}

/**
 * B0-428 — `final_output.timingBreakdown.ttftMs`, the workflow-recorded time to first streamed
 * assistant token. Exported for unit tests: `final_output` is untyped `Json`, and every historical
 * run predating B0-428 lands in one of the null branches.
 */
export function readTtftMs(finalOutput: unknown): number | null {
  if (!finalOutput || typeof finalOutput !== 'object' || Array.isArray(finalOutput)) {
    return null;
  }
  const timing = (finalOutput as Record<string, unknown>).timingBreakdown;
  if (!timing || typeof timing !== 'object' || Array.isArray(timing)) {
    return null;
  }
  const value = (timing as Record<string, unknown>).ttftMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function durationMsBetween(createdAt: string, updatedAt: string): number | null {
  const start = Date.parse(createdAt);
  const end = Date.parse(updatedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }
  const delta = end - start;
  return delta >= 0 ? delta : null;
}

function toListRow(
  row: WorkflowRunRow,
  source: RunSource | null,
  harnessTtftMs: number | null,
  attribution: RunAttribution,
  score: RunScore | null,
): WorkflowRunListRow {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    workflowName: row.workflow_name,
    status: row.status,
    confidence: row.confidence,
    routingDecision: readRoutingDecision(row.final_output),
    source,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    durationMs: durationMsBetween(row.created_at, row.updated_at),
    // Prefer the run's own measurement; the harness's `ttft_ms` covers runs recorded before
    // B0-428 instrumented the workflow.
    ttftMs: readTtftMs(row.final_output) ?? harnessTtftMs,
    userMessagePreview: readUserMessagePreview(row.user_input),
    attribution,
    score,
  };
}

/**
 * The test runner's own `ttft_ms` per workflow run id (null when that item recorded no streamed
 * delta). Only ever a TTFT lookup since B0-416: run *origin* is now the stored
 * `workflow_runs.source` column, not something derived from these rows.
 */
export type HarnessRunIndex = Map<string, number | null>;

/** Mirrors `readTtftMs`'s guards for the harness column, which is a plain integer. */
function readHarnessTtftMs(value: number | null): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * B0-416 — harness TTFT for a known set of runs, in one query against the indexed
 * `test_result_items.workflow_run_id` column. Used for the runs list's "Stream" fallback, so
 * `runIds` is a single page (≤ `MAX_LIMIT` + 1 ids).
 */
export async function indexHarnessTtftByRunIds(
  runIds: readonly string[],
): Promise<HarnessRunIndex> {
  const index: HarnessRunIndex = new Map();
  if (runIds.length === 0) {
    return index;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('test_result_items')
    .select('workflow_run_id, ttft_ms')
    .in('workflow_run_id', [...runIds]);

  if (error) {
    throw new Error(error.message);
  }

  for (const row of data ?? []) {
    if (row.workflow_run_id) {
      index.set(row.workflow_run_id, readHarnessTtftMs(row.ttft_ms));
    }
  }

  return index;
}

/** Run id → graded score, or `null` when the run was graded but unable to be evaluated. */
export type HarnessRunScoreIndex = Map<string, RunScore | null>;

/**
 * The same weighted-average / grade calculation `computeReportMetrics` applies per case
 * (`~/lib/tests/report/metrics.ts`), applied here to a single case's raw sub-scores. Kept
 * side-by-side rather than calling `computeReportMetrics` directly: that function also needs the
 * full case list to compute gating/status/concepts, none of which this table cell shows.
 */
function scoreFromSubScores(
  score: Pick<CaseScore, 'unableToEvaluate' | 'accuracy' | 'completeness' | 'relevance' | 'clarity'>,
): RunScore | null {
  if (
    score.unableToEvaluate ||
    score.accuracy == null ||
    score.completeness == null ||
    score.relevance == null ||
    score.clarity == null
  ) {
    return null;
  }
  const overall = Math.round(
    WEIGHTS.accuracy * score.accuracy +
      WEIGHTS.completeness * score.completeness +
      WEIGHTS.relevance * score.relevance +
      WEIGHTS.clarity * score.clarity,
  );
  return { overall, grade: gradeFromScore(overall) };
}

/**
 * B0-793 — graded score for a known set of runs, for the runs list's "Score" column. A run only
 * has a score when it was executed by the test harness as part of a scored test report: this
 * resolves each `workflow_run_id` to its `test_item_id` + `test_result_id` via
 * `test_result_items`, then reads that case's raw sub-scores out of the owning
 * `test_results.report_state.caseScores`. One bounded query per side of the join, same shape as
 * `indexHarnessTtftByRunIds` above — `runIds` is a single page.
 */
export async function indexHarnessScoresByRunIds(
  runIds: readonly string[],
): Promise<HarnessRunScoreIndex> {
  const index: HarnessRunScoreIndex = new Map();
  if (runIds.length === 0) {
    return index;
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data: items, error: itemsError } = await supabase
    .from('test_result_items')
    .select('workflow_run_id, test_item_id, test_result_id')
    .in('workflow_run_id', [...runIds]);

  if (itemsError) {
    throw new Error(itemsError.message);
  }
  if (!items || items.length === 0) {
    return index;
  }

  const testResultIds = [...new Set(items.map((item) => item.test_result_id))];
  const { data: results, error: resultsError } = await supabase
    .from('test_results')
    .select('id, report_state')
    .in('id', testResultIds);

  if (resultsError) {
    throw new Error(resultsError.message);
  }

  const reportStateByResultId = new Map(
    (results ?? []).map((result) => [result.id, parseReportState(result.report_state)]),
  );

  for (const item of items) {
    if (!item.workflow_run_id) {
      continue;
    }
    const caseScore = reportStateByResultId.get(item.test_result_id)?.caseScores[item.test_item_id];
    index.set(item.workflow_run_id, caseScore ? scoreFromSubScores(caseScore) : null);
  }

  return index;
}

/**
 * Harness TTFT for every graded item created in a window.
 *
 * Exported for `~/lib/observability/aggregates.ts` (B0-430), so the dashboard's average-TTFT tile
 * resolves each run's TTFT through exactly the same precedence as the "Stream" column here. That
 * caller reduces a whole window of runs at once (too many ids for a single `.in(...)`), so this
 * stays a windowed scan — but since B0-416 it reads the indexed `workflow_run_id` column instead
 * of extracting `response_payload->>'workflowRunId'` from the full JSON blob. Callers pad the
 * window themselves: a harness item is written *after* the run it belongs to.
 */
export async function indexHarnessWorkflowRuns(
  from: string,
  to: string,
): Promise<HarnessRunIndex> {
  const supabase = getSupabaseServiceRoleClient();
  const index: HarnessRunIndex = new Map();

  for (let page = 0; page < HARNESS_SCAN_MAX_PAGES; page += 1) {
    const start = page * HARNESS_SCAN_PAGE_SIZE;
    const { data, error } = await supabase
      .from('test_result_items')
      .select('workflow_run_id, ttft_ms')
      .not('workflow_run_id', 'is', null)
      .gte('created_at', from)
      .lte('created_at', to)
      .range(start, start + HARNESS_SCAN_PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message);
    }

    const rows = data ?? [];
    for (const row of rows) {
      if (row.workflow_run_id) {
        index.set(row.workflow_run_id, readHarnessTtftMs(row.ttft_ms));
      }
    }

    if (rows.length < HARNESS_SCAN_PAGE_SIZE) {
      break;
    }
  }

  return index;
}

/**
 * B0-593 — `workflow_runs.id`s whose agent step (`step_name = 'openai_responses_agent'`) recorded
 * a call to `toolName` in its persisted `output.toolTrace` (B0-331). `output->toolTrace` carries no
 * index, so — like `indexHarnessWorkflowRuns` above — this stays a windowed, page-capped scan
 * rather than one unbounded query; `from`/`to` (the same run-window bounds the caller already
 * applies to `workflow_runs.created_at`) are applied to `workflow_steps.started_at`, which closely
 * tracks its run's `created_at`, to keep the scan bounded as the table grows. Verified against live
 * data (see B0-593 QA notes): `.filter('output->toolTrace', 'cs', ...)` matches exactly the set of
 * rows a `jsonb_array_elements` + `toolName` equality scan finds.
 */
export async function resolveWorkflowRunIdsForToolCall(
  toolName: string,
  from?: string,
  to?: string,
): Promise<string[]> {
  const supabase = getSupabaseServiceRoleClient();
  const runIds = new Set<string>();

  for (let page = 0; page < HARNESS_SCAN_MAX_PAGES; page += 1) {
    const start = page * HARNESS_SCAN_PAGE_SIZE;
    let query = supabase
      .from('workflow_steps')
      .select('workflow_run_id')
      .eq('step_name', 'openai_responses_agent')
      .filter('output->toolTrace', 'cs', JSON.stringify([{ toolName }]));

    if (from) {
      query = query.gte('started_at', from);
    }
    if (to) {
      query = query.lte('started_at', to);
    }

    const { data, error } = await query.range(start, start + HARNESS_SCAN_PAGE_SIZE - 1);
    if (error) {
      throw new Error(error.message);
    }

    const rows = data ?? [];
    for (const row of rows) {
      if (row.workflow_run_id) {
        runIds.add(row.workflow_run_id);
      }
    }

    if (rows.length < HARNESS_SCAN_PAGE_SIZE) {
      break;
    }
  }

  return [...runIds];
}

/**
 * Filtered, offset-paginated run list for `/admin/observability`.
 *
 * Routing is filtered with a PostgREST JSON-path equality on
 * `final_output->>routingDecision`. That column is unindexed, which is
 * acceptable here: the window is ≤7 days by design and this is a low-QPS
 * internal admin tool. Documented follow-up if it ever proves slow: add a
 * generated `routing_decision` column on `workflow_runs` plus an index (would
 * require a migration — deliberately out of scope for B0-332).
 */
export async function listWorkflowRuns(
  filters: ListWorkflowRunsFilters,
): Promise<{ rows: WorkflowRunListRow[]; hasMore: boolean }> {
  const supabase = getSupabaseServiceRoleClient();
  const limit = clampLimit(filters.limit);
  const offset = clampOffset(filters.offset);

  // B0-338 / B0-593 — "single user" / "single test" / "tool call" filters each resolve to a set
  // of ids up front (small joins: `agent_conversations` is one user's rows, `test_result_items`
  // is one test's runs, `workflow_steps` is capped-and-paged for the tool-trace scan), then narrow
  // the main query with `.in('id'/'conversation_id', ...)`. `testId` and `toolName` both resolve to
  // `workflow_runs.id`s, so they are intersected in application code (rather than applying two
  // `.in('id', …)` calls) so the two filters narrow the SAME query instead of relying on
  // same-column filter semantics. An empty resolved set means "no runs match" without a wasted
  // `workflow_runs` query.
  let idFilterRunIds: string[] | null = null;
  const intersectIds = (existing: string[] | null, next: string[]): string[] =>
    existing === null ? next : existing.filter((id) => next.includes(id));

  if (filters.testId) {
    idFilterRunIds = intersectIds(idFilterRunIds, await resolveWorkflowRunIdsForTest(filters.testId));
    if (idFilterRunIds.length === 0) {
      return { rows: [], hasMore: false };
    }
  }

  if (filters.toolName) {
    idFilterRunIds = intersectIds(
      idFilterRunIds,
      await resolveWorkflowRunIdsForToolCall(filters.toolName, filters.from, filters.to),
    );
    if (idFilterRunIds.length === 0) {
      return { rows: [], hasMore: false };
    }
  }

  let userFilterConversationIds: string[] | null = null;
  if (filters.userId) {
    userFilterConversationIds = await resolveConversationIdsForUser(filters.userId);
    if (userFilterConversationIds.length === 0) {
      return { rows: [], hasMore: false };
    }
  }

  let query = supabase
    .from('workflow_runs')
    .select()
    .order('created_at', { ascending: false });

  if (idFilterRunIds) {
    query = query.in('id', idFilterRunIds);
  }
  if (userFilterConversationIds) {
    query = query.in('conversation_id', userFilterConversationIds);
  }

  // B0-431 — a run id names exactly one run, so the date window must not hide it. Without
  // this, pasting an id from an older alert returns nothing while the filter bar still shows
  // the default 7-day range, which reads as "that run does not exist".
  const isRunIdLookup = filters.search ? isRunIdSearchTerm(filters.search) : false;

  if (filters.from && !isRunIdLookup) {
    query = query.gte('created_at', filters.from);
  }
  if (filters.to && !isRunIdLookup) {
    query = query.lte('created_at', filters.to);
  }
  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  if (filters.routingDecision) {
    query = query.eq('final_output->>routingDecision', filters.routingDecision);
  }
  // B0-416 — an indexed equality on the stored `source` column. This replaces the old paged
  // scan of `test_result_items` that derived the set of harness run ids up front. `unknown` is
  // the pre-instrumentation cohort, which is `source IS NULL` rather than any stored value.
  if (filters.source) {
    query =
      filters.source === 'unknown'
        ? query.is('source', null)
        : query.eq('source', filters.source);
  }
  // SQL NULL comparison semantics: applying either bound drops rows whose
  // confidence IS NULL (in-flight / failed runs). That is intentional — asking
  // for a confidence range means asking for runs that have a confidence.
  if (typeof filters.confidenceMin === 'number') {
    query = query.gte('confidence', filters.confidenceMin);
  }
  if (typeof filters.confidenceMax === 'number') {
    query = query.lte('confidence', filters.confidenceMax);
  }
  // B0-431 — narrow by run id when the term is one, otherwise by prompt text. Like the
  // routing filter above this is an unindexed JSON-path predicate, accepted for the same
  // reasons (bounded window, low-QPS admin tool).
  if (filters.search) {
    query = isRunIdLookup
      ? query.eq('id', filters.search)
      : query.ilike('user_input->>message', `%${filters.search}%`);
  }

  // Over-fetch by one to detect a further page without a count query.
  const { data, error } = await query.range(offset, offset + limit);
  if (error) {
    throw new Error(error.message);
  }

  const fetched = data ?? [];
  const hasMore = fetched.length > limit;
  const page = hasMore ? fetched.slice(0, limit) : fetched;

  // Only for the "Stream" column's harness fallback (B0-428): one bounded query keyed on the
  // page's run ids. Run origin comes off each row's own `source` column.
  const [harnessTtft, attributionIndex, harnessScore] = await Promise.all([
    indexHarnessTtftByRunIds(page.map((row) => row.id)),
    // B0-338 — "Asked by" column: resolved for exactly this page, same bound as the TTFT lookup.
    resolveRunAttributions(
      page.map((row) => ({
        id: row.id,
        conversationId: row.conversation_id,
        source: readRunSource(row.source),
      })),
    ),
    // B0-793 — "Score" column: resolved for exactly this page, same bound as the TTFT lookup.
    indexHarnessScoresByRunIds(page.map((row) => row.id)),
  ]);

  const rows = page.map((row) =>
    toListRow(
      row,
      readRunSource(row.source),
      harnessTtft.get(row.id) ?? null,
      attributionIndex.get(row.id) ?? { kind: 'unknown' },
      harnessScore.get(row.id) ?? null,
    ),
  );

  return { rows, hasMore };
}

/**
 * Everything the single-run trace page needs, in one call: the run, its steps,
 * its audit trail, and the assembled timeline. Composes the existing
 * `workflow-repository` readers rather than re-implementing them.
 */
export async function getWorkflowRunTrace(runId: string): Promise<{
  run: WorkflowRunRow;
  steps: WorkflowStepRow[];
  auditLogs: AuditLogRow[];
  timeline: TimelineEvent[];
  /** B0-399 — which (if any) of the four empty/degraded-state banners the page should render. */
  emptyState: RunEmptyState;
  /** B0-338 — who asked for this run. */
  attribution: RunAttribution;
} | null> {
  const bundle = await getWorkflowRunWithSteps(runId);
  if (!bundle) {
    return null;
  }

  const [auditLogs, attribution] = await Promise.all([
    listAuditLogsForRun(runId) as Promise<AuditLogRow[]>,
    getRunAttribution({
      id: bundle.run.id,
      conversationId: bundle.run.conversation_id,
      source: readRunSource(bundle.run.source),
    }),
  ]);
  const timeline = buildRunTimeline(bundle.run, bundle.steps, auditLogs);

  return {
    run: bundle.run,
    steps: bundle.steps,
    auditLogs,
    timeline,
    emptyState: deriveRunEmptyState(bundle.run, bundle.steps, timeline),
    attribution,
  };
}
