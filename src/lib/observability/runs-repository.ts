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
import { buildRunTimeline } from '~/lib/observability/timeline';
import { extractWorkflowRunId } from '~/lib/tests/response-payload';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type {
  AuditLogRow,
  ListWorkflowRunsFilters,
  RunSource,
  TimelineEvent,
  WorkflowRunListRow,
} from '~/types/observability';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/** Cap for the list view's `userMessagePreview`; the full text lives on the trace page. */
const USER_MESSAGE_PREVIEW_MAX_CHARS = 160;

/** Fallback window (days) when a caller omits `from`/`to`; the UI always sends ≤7 days. */
const DEFAULT_LOOKBACK_DAYS = 7;

/**
 * A harness `test_result_items` row is inserted *after* its workflow run is
 * created, so pad the item window on both sides before deriving run ids.
 */
const HARNESS_WINDOW_PADDING_MS = 60 * 60 * 1000;

/** PostgREST page size when sweeping `test_result_items` for harness run ids. */
const HARNESS_SCAN_PAGE_SIZE = 1000;
const HARNESS_SCAN_MAX_PAGES = 25;

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

function shiftIso(iso: string, deltaMs: number): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return iso;
  }
  return new Date(parsed + deltaMs).toISOString();
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
  source: RunSource,
  harnessTtftMs: number | null,
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
  };
}

/**
 * Harness runs indexed by workflow run id, with the test runner's own `ttft_ms` for each (null when
 * that item recorded no streamed delta). Built in one scan so run-source tagging and the "Stream"
 * column fallback (B0-428) share it.
 */
type HarnessRunIndex = Map<string, number | null>;

async function indexHarnessWorkflowRuns(
  from: string,
  to: string,
): Promise<HarnessRunIndex> {
  const supabase = getSupabaseServiceRoleClient();
  const index: HarnessRunIndex = new Map();

  for (let page = 0; page < HARNESS_SCAN_MAX_PAGES; page += 1) {
    const start = page * HARNESS_SCAN_PAGE_SIZE;
    const { data, error } = await supabase
      .from('test_result_items')
      .select('response_payload, ttft_ms')
      .gte('created_at', from)
      .lte('created_at', to)
      .range(start, start + HARNESS_SCAN_PAGE_SIZE - 1);

    if (error) {
      throw new Error(error.message);
    }

    const rows = data ?? [];
    for (const row of rows) {
      const runId = extractWorkflowRunId(row.response_payload);
      if (runId) {
        index.set(
          runId,
          typeof row.ttft_ms === 'number' && Number.isFinite(row.ttft_ms) && row.ttft_ms >= 0
            ? row.ttft_ms
            : null,
        );
      }
    }

    if (rows.length < HARNESS_SCAN_PAGE_SIZE) {
      break;
    }
  }

  return index;
}

/**
 * Run "source" is DERIVED, not stored: a run whose id appears in a
 * `test_result_items.response_payload.workflowRunId` came from the golden-set
 * test harness, which drives the same `runProductSupportWorkflow` path as chat.
 */
export async function listHarnessWorkflowRunIds(
  from: string,
  to: string,
): Promise<Set<string>> {
  return new Set((await indexHarnessWorkflowRuns(from, to)).keys());
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

  // Only needed up front when the caller filters BY source; otherwise the set is
  // derived after the fact (over the returned page's actual date range) purely
  // for tagging.
  let harnessIndex: HarnessRunIndex | null = null;
  if (filters.source) {
    const to = filters.to ?? new Date().toISOString();
    const from =
      filters.from ??
      new Date(Date.parse(to) - DEFAULT_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();
    harnessIndex = await indexHarnessWorkflowRuns(
      shiftIso(from, -HARNESS_WINDOW_PADDING_MS),
      shiftIso(to, HARNESS_WINDOW_PADDING_MS),
    );
  }

  let query = supabase
    .from('workflow_runs')
    .select()
    .order('created_at', { ascending: false });

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

  if (harnessIndex) {
    const ids = [...harnessIndex.keys()];
    if (filters.source === 'harness') {
      if (ids.length === 0) {
        return { rows: [], hasMore: false };
      }
      query = query.in('id', ids);
    } else if (ids.length > 0) {
      query = query.not('id', 'in', `(${ids.join(',')})`);
    }
  }

  // Over-fetch by one to detect a further page without a count query.
  const { data, error } = await query.range(offset, offset + limit);
  if (error) {
    throw new Error(error.message);
  }

  const fetched = data ?? [];
  const hasMore = fetched.length > limit;
  const page = hasMore ? fetched.slice(0, limit) : fetched;

  if (!harnessIndex && page.length > 0) {
    const timestamps = page.map((row) => Date.parse(row.created_at)).filter(Number.isFinite);
    const min = Math.min(...timestamps);
    const max = Math.max(...timestamps);
    harnessIndex = await indexHarnessWorkflowRuns(
      new Date(min - HARNESS_WINDOW_PADDING_MS).toISOString(),
      new Date(max + HARNESS_WINDOW_PADDING_MS).toISOString(),
    );
  }

  const rows = page.map((row) =>
    toListRow(
      row,
      harnessIndex?.has(row.id) ? 'harness' : 'live',
      harnessIndex?.get(row.id) ?? null,
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
} | null> {
  const bundle = await getWorkflowRunWithSteps(runId);
  if (!bundle) {
    return null;
  }

  const auditLogs = (await listAuditLogsForRun(runId)) as AuditLogRow[];

  return {
    run: bundle.run,
    steps: bundle.steps,
    auditLogs,
    timeline: buildRunTimeline(bundle.run, bundle.steps, auditLogs),
  };
}
