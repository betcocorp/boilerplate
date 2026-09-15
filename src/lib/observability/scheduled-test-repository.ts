/**
 * B0-941 — all Supabase I/O for `public.scheduled_test_runs` / `public.scheduled_test_items`.
 *
 * Everything that touches those two tables goes through here: the nightly sweep
 * (`~/lib/observability/run-golden-test-sweep.ts`) writes the ledger, and the hourly reconciler
 * (`~/lib/observability/reconcile-scheduled-tests.ts`) folds terminal state back into it through
 * the port this module builds. The reconciler itself stays pure and database-free, exactly like
 * `stalled-run-sweeper.ts` / `stalled-run-repository.ts`.
 */

import {
  computeScheduledRunAggregates,
  scheduledTestItemSchema,
  scheduledTestRunSchema,
  type ScheduledTestItem,
  type ScheduledTestRun,
} from '~/lib/observability/scheduled-test-types';
import { logInfo, logWarn } from '~/lib/observability/logger';
import {
  reconcileScheduledTests,
  type ReconcileScheduledTestsInput,
  type ReconcileScheduledTestsResult,
  type ReconcilerSweepRun,
  type ReconcilerTestRun,
  type ScheduledItemTally,
  type ScheduledTestReconcilerPort,
} from '~/lib/observability/reconcile-scheduled-tests';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import { z } from 'zod';

/** Columns a caller may patch on a child row (identity/audit columns are never written). */
export type ScheduledTestItemPatch = Partial<
  Omit<ScheduledTestItem, 'id' | 'scheduled_run_id' | 'created_at' | 'updated_at'>
>;

/** Columns a caller may patch on a parent row. */
export type ScheduledTestRunPatch = Partial<
  Omit<ScheduledTestRun, 'id' | 'created_at' | 'updated_at'>
>;

export const DEFAULT_SWEEP_NAME = 'golden_test_sweep';

/* -------------------------------------------------------------------------- *
 * The one untyped seam
 * -------------------------------------------------------------------------- */

type ScheduledTableName = 'scheduled_test_runs' | 'scheduled_test_items';

type QueryResult = { data: unknown; error: { message: string } | null };
type CountResult = { count: number | null; error: { message: string } | null };

/** Only the fragment of the PostgREST builder this module actually calls. */
interface ScheduledQuery extends PromiseLike<QueryResult> {
  select(columns: string): ScheduledQuery;
  eq(column: string, value: string): ScheduledQuery;
  in(column: string, values: readonly string[]): ScheduledQuery;
  order(column: string, options: { ascending: boolean }): ScheduledQuery;
  limit(count: number): ScheduledQuery;
  single(): PromiseLike<QueryResult>;
}

interface ScheduledTable {
  select(columns: string): ScheduledQuery;
  insert(values: Record<string, unknown> | Record<string, unknown>[]): ScheduledQuery;
  update(values: Record<string, unknown>): ScheduledQuery;
}

/**
 * The generated Supabase types do not yet carry these two B0-941 tables (regenerating
 * `src/types/supabase.public.ts` needs CLI auth that is not available here), so the client has to
 * be widened to reach them. That cast is confined to this single function: every exported helper
 * below re-validates what comes back with the Zod contracts in `scheduled-test-types.ts`, so only
 * properly-typed rows leave this module.
 */
function scheduledTable(table: ScheduledTableName): ScheduledTable {
  const client = getSupabaseServiceRoleClient() as unknown as {
    from(name: ScheduledTableName): ScheduledTable;
  };
  return client.from(table);
}

function unwrap(result: QueryResult, context: string): unknown {
  if (result.error) {
    throw new Error(`${context}: ${result.error.message}`);
  }
  return result.data;
}

/* -------------------------------------------------------------------------- *
 * Writes — used by the sweep
 * -------------------------------------------------------------------------- */

export async function insertScheduledTestRun(input: {
  sweepName?: string;
  sweepTriggeredAt: string;
  totalTests: number;
  metadata: Record<string, unknown>;
}): Promise<ScheduledTestRun> {
  const result = await scheduledTable('scheduled_test_runs')
    .insert({
      sweep_name: input.sweepName ?? DEFAULT_SWEEP_NAME,
      sweep_triggered_at: input.sweepTriggeredAt,
      started_at: input.sweepTriggeredAt,
      status: 'in_progress',
      total_tests: input.totalTests,
      metadata: input.metadata,
    })
    .select('*')
    .single();

  return scheduledTestRunSchema.parse(unwrap(result, 'insert scheduled_test_runs'));
}

export async function insertScheduledTestItems(input: {
  scheduledRunId: string;
  startedAt: string;
  tests: { id: string; name: string }[];
}): Promise<ScheduledTestItem[]> {
  if (input.tests.length === 0) {
    return [];
  }

  const result = await scheduledTable('scheduled_test_items')
    .insert(
      input.tests.map((test) => ({
        scheduled_run_id: input.scheduledRunId,
        test_id: test.id,
        test_name: test.name,
        status: 'running',
        started_at: input.startedAt,
      })),
    )
    .select('*');

  return z
    .array(scheduledTestItemSchema)
    .parse(unwrap(result, 'insert scheduled_test_items'));
}

export async function updateScheduledTestItem(
  id: string,
  patch: ScheduledTestItemPatch,
): Promise<void> {
  const result = await scheduledTable('scheduled_test_items')
    .update(patch as Record<string, unknown>)
    .eq('id', id);

  unwrap(result, 'update scheduled_test_items');
}

export async function updateScheduledTestRun(
  id: string,
  patch: ScheduledTestRunPatch,
): Promise<void> {
  const result = await scheduledTable('scheduled_test_runs')
    .update(patch as Record<string, unknown>)
    .eq('id', id);

  unwrap(result, 'update scheduled_test_runs');
}

/* -------------------------------------------------------------------------- *
 * Reads — used by the reconciler
 * -------------------------------------------------------------------------- */

/** Non-terminal children, oldest first, so a backlog drains in the order it was created. */
export async function listNonTerminalScheduledTestItems(
  limit: number,
): Promise<ScheduledTestItem[]> {
  const result = await scheduledTable('scheduled_test_items')
    .select('*')
    .in('status', ['queued', 'claimed', 'running'])
    .order('created_at', { ascending: true })
    .limit(limit);

  return z
    .array(scheduledTestItemSchema)
    .parse(unwrap(result, 'select scheduled_test_items') ?? []);
}

export async function listScheduledTestItemsForRuns(
  scheduledRunIds: string[],
): Promise<ScheduledTestItem[]> {
  if (scheduledRunIds.length === 0) {
    return [];
  }

  const result = await scheduledTable('scheduled_test_items')
    .select('*')
    .in('scheduled_run_id', scheduledRunIds)
    .order('created_at', { ascending: true });

  return z
    .array(scheduledTestItemSchema)
    .parse(unwrap(result, 'select scheduled_test_items') ?? []);
}

export async function listScheduledTestRuns(ids: string[]): Promise<ScheduledTestRun[]> {
  if (ids.length === 0) {
    return [];
  }

  const result = await scheduledTable('scheduled_test_runs').select('*').in('id', ids);

  return z
    .array(scheduledTestRunSchema)
    .parse(unwrap(result, 'select scheduled_test_runs') ?? []);
}

/* -------------------------------------------------------------------------- *
 * Reads against the test harness's own tables (these ARE in the generated types)
 * -------------------------------------------------------------------------- */

export async function listTestRunsForReconciliation(
  testRunIds: string[],
): Promise<ReconcilerTestRun[]> {
  if (testRunIds.length === 0) {
    return [];
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('test_results')
    .select('id,status,started_at,completed_at,elapsed_ms')
    .in('id', testRunIds);

  if (error) {
    throw new Error(`select test_results: ${error.message}`);
  }

  return data ?? [];
}

/**
 * B0-989 — runs the sweep created for these tests at/after `sinceIso`, oldest first. Restricted to
 * `triggered_by = 'api-client'`: that is the label `POST /api/admin/tests/runs` stamps on a run
 * created with a registry token (B0-687), which is what the sweep uses; a human's run started in
 * the same window is never a candidate.
 */
export async function listSweepTestRunsForTests(
  testIds: string[],
  sinceIso: string,
): Promise<ReconcilerSweepRun[]> {
  if (testIds.length === 0) {
    return [];
  }

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('test_results')
    .select('id,test_id,status,started_at,completed_at,elapsed_ms,created_at')
    .in('test_id', testIds)
    .eq('triggered_by', 'api-client')
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(`select test_results (sweep backfill): ${error.message}`);
  }

  return data ?? [];
}

/**
 * B0-1014 — how many faulted rows are read back to name the dominant `provider_fault` kind. The
 * count itself is exact (PostgREST returns it in the range header regardless of the page size);
 * only the kind is sampled, and a run does not need more than this to say WHICH refusal it hit.
 * Well under `db-max-rows` (1000).
 */
const PROVIDER_FAULT_KIND_SAMPLE_LIMIT = 100;

/** Most frequent value in the sample; ties broken alphabetically for a stable message. */
function dominantProviderFault(
  rows: readonly { provider_fault: string | null }[],
): string | null {
  const counts = new Map<string, number>();

  for (const row of rows) {
    const kind = row.provider_fault?.trim();
    if (!kind) {
      continue;
    }
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  return (
    [...counts.entries()].sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    )[0]?.[0] ?? null
  );
}

/**
 * Per-run pass/fail counts, plus the B0-1014 provider-fault count.
 *
 * Counted with `head: true` count queries rather than by selecting the rows: a golden run can
 * hold several hundred `test_result_items` and PostgREST caps a response at `db-max-rows` (1000),
 * so fetching rows to tally them would silently truncate on a large sweep. The provider-fault query
 * is the one exception — it reads a bounded sample of the faulted rows so the reconciler can name
 * the kind in `error_message` — and its `count` is still exact.
 */
export async function listScheduledItemTallies(
  testRunIds: string[],
): Promise<ScheduledItemTally[]> {
  if (testRunIds.length === 0) {
    return [];
  }

  const supabase = getSupabaseServiceRoleClient();

  return Promise.all(
    testRunIds.map(async (testRunId): Promise<ScheduledItemTally> => {
      const [total, passed, faulted] = await Promise.all([
        supabase
          .from('test_result_items')
          .select('id', { count: 'exact', head: true })
          .eq('test_result_id', testRunId),
        supabase
          .from('test_result_items')
          .select('id', { count: 'exact', head: true })
          .eq('test_result_id', testRunId)
          .eq('passed', true),
        supabase
          .from('test_result_items')
          .select('provider_fault', { count: 'exact' })
          .eq('test_result_id', testRunId)
          .not('provider_fault', 'is', null)
          .limit(PROVIDER_FAULT_KIND_SAMPLE_LIMIT),
      ]);

      for (const result of [total, passed, faulted] as CountResult[]) {
        if (result.error) {
          throw new Error(`count test_result_items: ${result.error.message}`);
        }
      }

      const itemsTotal = total.count ?? 0;
      const itemsPassed = passed.count ?? 0;

      return {
        test_run_id: testRunId,
        items_total: itemsTotal,
        items_passed: itemsPassed,
        items_failed: Math.max(0, itemsTotal - itemsPassed),
        items_provider_faulted: faulted.count ?? 0,
        provider_fault_kind: dominantProviderFault(faulted.data ?? []),
      };
    }),
  );
}

/* -------------------------------------------------------------------------- *
 * Port + production wiring for the reconciler
 * -------------------------------------------------------------------------- */

export function createSupabaseScheduledTestReconcilerPort(): ScheduledTestReconcilerPort {
  return {
    listNonTerminalItems: listNonTerminalScheduledTestItems,
    listTestRuns: listTestRunsForReconciliation,
    listSweepTestRunsForTests,
    listItemTallies: listScheduledItemTallies,
    updateItem: updateScheduledTestItem,
    listItemsForScheduledRuns: listScheduledTestItemsForRuns,
    listScheduledRuns: listScheduledTestRuns,
    updateRun: updateScheduledTestRun,
  };
}

/** Composes the Supabase port, the real clock and the structured logger for the route handler. */
export async function runScheduledTestReconciliation(
  input: ReconcileScheduledTestsInput = {},
): Promise<ReconcileScheduledTestsResult> {
  return reconcileScheduledTests(
    {
      port: createSupabaseScheduledTestReconcilerPort(),
      now: () => Date.now(),
      log: (event, fields) => {
        if (event.endsWith('_failed')) {
          logWarn(event, fields);
          return;
        }
        logInfo(event, fields);
      },
    },
    input,
  );
}

/* -------------------------------------------------------------------------- *
 * Sweep-side convenience
 * -------------------------------------------------------------------------- */

/**
 * Closes a sweep's parent row from the in-memory child states the dispatcher produced.
 *
 * Aggregates come from `computeScheduledRunAggregates` so the sweep and the reconciler can never
 * disagree on the arithmetic. The parent is only moved to a terminal status when EVERY child is
 * already terminal (i.e. every dispatch failed); otherwise runs are still executing and closing
 * the parent is the reconciler's job.
 */
export async function closeScheduledRunAfterDispatch(input: {
  scheduledRunId: string;
  items: ScheduledTestItem[];
  completedAtIso: string;
  startedAtIso: string;
}): Promise<void> {
  const aggregates = computeScheduledRunAggregates(input.items);
  const patch: ScheduledTestRunPatch = {
    total_tests: aggregates.total_tests,
    successful_tests: aggregates.successful_tests,
    failed_tests: aggregates.failed_tests,
    timed_out_tests: aggregates.timed_out_tests,
    success_rate: aggregates.success_rate,
    avg_elapsed_ms: aggregates.avg_elapsed_ms,
  };

  if (aggregates.allTerminal) {
    patch.status = 'failed';
    patch.completed_at = input.completedAtIso;
    patch.elapsed_ms = Math.max(
      0,
      Date.parse(input.completedAtIso) - Date.parse(input.startedAtIso),
    );
    patch.error_message = 'Every golden test failed to dispatch';
  }

  await updateScheduledTestRun(input.scheduledRunId, patch);
}
