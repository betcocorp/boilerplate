/**
 * B0-419 — resolves a `workflow_runs.id` back to the harness execution that produced it.
 *
 * A workflow run is one cell in a grid: the *run* is the row, the *prompt* is the column. Until
 * B0-416 gave `test_result_items` a real `workflow_run_id` column there was no way to walk that
 * link, so `/admin/observability/<runId>` could not say which test run or which prompt it belonged
 * to. This module is the single reader for that linkage, and the only place the join lives.
 *
 * Read-only, and deliberately **never throws**. A run that is not a harness run (live Bex chat, a
 * direct orchestrator call), a run whose `test_result_items` row was deleted, or an outright
 * PostgREST failure all resolve to `null` — which is what lets the trace page render the verdict
 * band as *absent* rather than as an empty shell or an error. Callers treat `null` as "this is not
 * a harness run" and render exactly what they rendered before B0-419.
 *
 * Consumed by:
 *  - the trace page verdict band + `↑` breadcrumbs (B0-419)
 *  - the AI insights payload — `passed` / `expectedShouldAnswer` / `idealResponse` / `similarity` (B0-420)
 *  - the prompt-history strip, keyed off `testItemId` and excluding `testResultId` (B0-421)
 */

import { logWarn } from '~/lib/observability/logger';
import { extractItemSimilarityScore } from '~/lib/tests/response-payload';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

/**
 * One harness execution: the `test_result_items` row a `workflow_runs` row belongs to, joined to
 * the prompt it exercised (`test_items`) and the run it was part of (`test_results` / `tests`).
 */
export type HarnessRunContext = {
  /** `test_result_items.id` — the specific execution (the grid cell). */
  resultItemId: string;
  /** Echoed back so callers can round-trip without re-deriving it. */
  workflowRunId: string;

  /* Axis identity ---------------------------------------------------------- */
  /** `tests.id` — the dataset; both `/admin/tests` breadcrumbs are built from it. */
  testId: string;
  /** `tests.name`. */
  testName: string;
  /** `test_results.id` — the run (the row). B0-421 uses it to exclude "this run". */
  testResultId: string;
  /** `test_results.started_at`, falling back to `created_at`; labels "↑ Run <date>". */
  runStartedAt: string;
  /** `test_items.id` — the prompt (the column). B0-421 keys its history strip off this. */
  testItemId: string;

  /* Prompt expectations ---------------------------------------------------- */
  rowIndex: number;
  prompt: string;
  expectedShouldAnswer: boolean | null;
  priority: number | null;
  /**
   * `test_items.ideal_response` — free-form prose, shown beside the answer and never
   * character-diffed against it. Currently null for every row in the database.
   */
  idealResponse: string | null;

  /* This execution's verdict ---------------------------------------------- */
  passed: boolean;
  /** `test_result_items.status` (`completed` | `failed` | …). */
  status: string;
  elapsedMs: number;
  /** Max similarity across retrieved sources; null when the payload recorded none. */
  similarity: number | null;
  /** The harness's own record of the answer / failure, for B0-420's payload. */
  responseText: string | null;
  errorMessage: string | null;
};

/**
 * The columns this module reads. Declared explicitly rather than `select('*')` so the query stays a
 * narrow index read and so the mapper's input shape is checkable in a unit test.
 */
const RESULT_ITEM_COLUMNS =
  'id, workflow_run_id, test_item_id, test_result_id, row_index, passed, status, elapsed_ms, response_text, error_message, response_payload';
const TEST_ITEM_COLUMNS =
  'id, row_index, prompt, expected_should_answer, priority, ideal_response';

/**
 * PostgREST returns an embedded resource as an object or as a single-element array depending on how
 * it infers the relationship's cardinality, and both shapes reach this code. Normalising here keeps
 * that quirk out of the mapper's business logic.
 */
function firstEmbedded(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? (candidate as Record<string, unknown>)
    : null;
}

function readString(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === 'string' && value.trim() ? value : null;
}

function readNumber(
  record: Record<string, unknown> | null,
  key: string,
): number | null {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** `boolean | null` expectation flags must never be coerced — "unset" is a distinct verdict. */
function readNullableBoolean(
  record: Record<string, unknown> | null,
  key: string,
): boolean | null {
  const value = record?.[key];
  return typeof value === 'boolean' ? value : null;
}

/**
 * Narrows one joined row into a `HarnessRunContext`, or `null` when the linkage is incomplete.
 *
 * Exported for unit tests: every failure here is silent by design (the band simply does not
 * render), so the narrowing has to be asserted directly rather than inferred from the UI.
 */
export function mapHarnessContextRow(row: unknown): HarnessRunContext | null {
  const item = firstEmbedded(row);
  if (!item) {
    return null;
  }

  const testItem = firstEmbedded(item.test_items);
  const testResult = firstEmbedded(item.test_results);
  const test = firstEmbedded(testResult?.tests);

  const resultItemId = readString(item, 'id');
  const workflowRunId = readString(item, 'workflow_run_id');
  const testItemId = readString(testItem, 'id') ?? readString(item, 'test_item_id');
  const testResultId =
    readString(testResult, 'id') ?? readString(item, 'test_result_id');
  const testId = readString(test, 'id') ?? readString(testResult, 'test_id');

  // Without all four ids there is no navigable grid position, so there is nothing to render.
  if (!resultItemId || !workflowRunId || !testItemId || !testResultId || !testId) {
    return null;
  }

  const prompt = readString(testItem, 'prompt');
  if (prompt === null) {
    // The prompt was deleted (or the join produced no `test_items` parent): the band's whole
    // premise — "this answer against this expectation" — is gone.
    return null;
  }

  // `test_items.row_index` is the prompt's position in the dataset and is what the breadcrumb
  // label and the item-history page mean by "row"; `test_result_items.row_index` is a per-run copy
  // kept only as a fallback.
  const rowIndex =
    readNumber(testItem, 'row_index') ?? readNumber(item, 'row_index') ?? 0;

  const runStartedAt =
    readString(testResult, 'started_at') ?? readString(testResult, 'created_at');

  return {
    resultItemId,
    workflowRunId,
    testId,
    testName: readString(test, 'name') ?? '',
    testResultId,
    runStartedAt: runStartedAt ?? '',
    testItemId,
    rowIndex,
    prompt,
    expectedShouldAnswer: readNullableBoolean(testItem, 'expected_should_answer'),
    priority: readNumber(testItem, 'priority'),
    idealResponse: readString(testItem, 'ideal_response'),
    passed: item.passed === true,
    status: readString(item, 'status') ?? '',
    elapsedMs: readNumber(item, 'elapsed_ms') ?? 0,
    similarity: extractItemSimilarityScore(item.response_payload),
    responseText: readString(item, 'response_text'),
    errorMessage: readString(item, 'error_message'),
  };
}

/**
 * Resolves a workflow run to its harness execution, or `null` when the run is not a harness run.
 *
 * One indexed read against `test_result_items.workflow_run_id` (B0-416) with the prompt and run
 * joined in. `limit(1)` rather than `maybeSingle()` deliberately: nothing in the schema forbids two
 * result items pointing at one run, and `maybeSingle()` would turn that into a 406 that took the
 * whole trace page down instead of degrading to no band.
 */
export async function getHarnessContextForRun(
  workflowRunId: string,
): Promise<HarnessRunContext | null> {
  if (!workflowRunId.trim()) {
    return null;
  }

  try {
    const supabase = getSupabaseServiceRoleClient();
    const result = await supabase
      .from('test_result_items')
      .select(
        `${RESULT_ITEM_COLUMNS}, test_items!inner(${TEST_ITEM_COLUMNS}), test_results!inner(id, test_id, started_at, created_at, tests!inner(id, name))`,
      )
      .eq('workflow_run_id', workflowRunId)
      .limit(1);

    if (result.error) {
      // Degrade to "not a harness run": the trace page's own content is unaffected, and an
      // unexplained missing band would otherwise be untraceable.
      logWarn('harness_linkage_lookup_failed', {
        workflowRunId,
        message: result.error.message,
      });
      return null;
    }

    return mapHarnessContextRow(result.data?.[0] ?? null);
  } catch (error) {
    logWarn('harness_linkage_lookup_threw', {
      workflowRunId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
