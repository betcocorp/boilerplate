/**
 * B0-421 — the prompt's recent outcomes, read from a trace page (one grid cell) about its own column.
 *
 * During triage the question straight after "why did this fail" is "does this always fail". Answering
 * it used to mean navigating away to `/admin/tests/<testId>/items/<itemId>` and losing your place, so
 * the trace page now carries a compact strip of the prompt's last N executions plus its overall pass
 * rate.
 *
 * **This is deliberately not the item page's reader.** `listResultItemsByTestItemId(item.id, 500)`
 * pulls up to 500 whole rows — `response_payload` and all — because the column page really does
 * aggregate similarity and elapsed trends off them. A cell must not pay that cost to answer one
 * question, so this module issues three bounded reads instead:
 *
 *  1. the most recent N rows, selecting only the four columns the strip renders;
 *  2. `count: 'exact', head: true` for total executions — a count, no rows over the wire;
 *  3. the same count filtered to `passed = true`.
 *
 * Read-only and, like `getHarnessContextForRun`, it **never throws**: a PostgREST failure or an
 * unconfigurable client degrades to an empty history (no strip) rather than taking down a trace page
 * whose own content loaded fine. Counts degrade independently of the window, so a failed count shows
 * the dots without a pass rate rather than hiding both.
 */

import { logWarn } from '~/lib/observability/logger';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/** How many executions the strip shows. Roughly "recent history", not a statistical sample. */
export const PROMPT_HISTORY_WINDOW = 10;

/** The only columns the strip renders — anything wider would defeat the point of the module. */
const HISTORY_COLUMNS = 'id, workflow_run_id, passed, created_at';

/** One execution of the prompt: one dot in the strip. */
export type PromptHistoryOutcome = {
  /** `test_result_items.id` — identifies "this run" without a second lookup. */
  resultItemId: string;
  /**
   * `test_result_items.workflow_run_id`, null for 1,488 of 10,176 rows today: search-eval rows,
   * error rows that never opened a run, and rows whose run has since been deleted. Those dots still
   * render — the outcome happened — but they link nowhere, because there is no trace to open.
   */
  workflowRunId: string | null;
  passed: boolean;
  createdAt: string;
};

export type PromptHistory = {
  /** Oldest → newest, at most `PROMPT_HISTORY_WINDOW`. Empty means "render no strip". */
  outcomes: PromptHistoryOutcome[];
  /** Every execution of this prompt, not just the window. Null when the count query failed. */
  totalExecutions: number | null;
  passedExecutions: number | null;
  /** 0–1, or null when the counts are unavailable or the prompt has never been executed. */
  passRate: number | null;
};

export const EMPTY_PROMPT_HISTORY: PromptHistory = {
  outcomes: [],
  totalExecutions: null,
  passedExecutions: null,
  passRate: null,
};

function readString(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * Narrows the window query's rows into outcomes, newest-first input to **oldest-first** output.
 *
 * Rows missing an id or a timestamp are dropped: a dot with no identity cannot be marked as "this
 * run" and a dot with no timestamp cannot be placed in the sequence. A missing `workflow_run_id` is
 * *not* a reason to drop — see `PromptHistoryOutcome.workflowRunId`.
 *
 * Exported for unit tests, since every rejection here is silent in the UI.
 */
export function mapPromptHistoryRows(rows: unknown): PromptHistoryOutcome[] {
  if (!Array.isArray(rows)) {
    return [];
  }

  const outcomes: PromptHistoryOutcome[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      continue;
    }
    const record = row as Record<string, unknown>;
    const resultItemId = readString(record, 'id');
    const createdAt = readString(record, 'created_at');
    if (!resultItemId || !createdAt) {
      continue;
    }
    outcomes.push({
      resultItemId,
      workflowRunId: readString(record, 'workflow_run_id'),
      passed: record.passed === true,
      createdAt,
    });
  }

  // The query orders newest-first so `limit(N)` takes the *recent* N; the strip reads left-to-right
  // as time passing, so reverse once here rather than in the component.
  return outcomes.reverse();
}

/**
 * Recent outcomes and the overall pass rate for one prompt (`test_items.id`).
 *
 * Returns `EMPTY_PROMPT_HISTORY` rather than throwing or propagating a PostgREST error. Callers
 * render the strip only when `outcomes` is non-empty.
 */
export async function getPromptHistoryForItem(
  testItemId: string,
  limit: number = PROMPT_HISTORY_WINDOW,
): Promise<PromptHistory> {
  if (!testItemId.trim()) {
    return EMPTY_PROMPT_HISTORY;
  }

  try {
    const supabase = getSupabaseServiceRoleClient();
    const [windowResult, totalResult, passedResult] = await Promise.all([
      supabase
        .from('test_result_items')
        .select(HISTORY_COLUMNS)
        .eq('test_item_id', testItemId)
        .order('created_at', { ascending: false })
        .limit(limit),
      supabase
        .from('test_result_items')
        .select('*', { count: 'exact', head: true })
        .eq('test_item_id', testItemId),
      supabase
        .from('test_result_items')
        .select('*', { count: 'exact', head: true })
        .eq('test_item_id', testItemId)
        .eq('passed', true),
    ]);

    if (windowResult.error) {
      logWarn('prompt_history_window_query_failed', {
        testItemId,
        message: windowResult.error.message,
      });
      return EMPTY_PROMPT_HISTORY;
    }

    const outcomes = mapPromptHistoryRows(windowResult.data);

    // Counts degrade on their own: the dots are the load-bearing part of the strip, so a failed
    // count drops the pass rate instead of the whole strip.
    if (totalResult.error || passedResult.error) {
      logWarn('prompt_history_count_query_failed', {
        testItemId,
        message: (totalResult.error ?? passedResult.error)?.message ?? 'unknown',
      });
      return { ...EMPTY_PROMPT_HISTORY, outcomes };
    }

    const totalExecutions = totalResult.count ?? 0;
    const passedExecutions = passedResult.count ?? 0;

    return {
      outcomes,
      totalExecutions,
      passedExecutions,
      passRate: totalExecutions > 0 ? passedExecutions / totalExecutions : null,
    };
  } catch (error) {
    logWarn('prompt_history_lookup_threw', {
      testItemId,
      message: error instanceof Error ? error.message : String(error),
    });
    return EMPTY_PROMPT_HISTORY;
  }
}
