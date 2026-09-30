/**
 * B0-990 — Supabase wiring for `~/lib/observability/stalled-test-run-sweeper.ts`.
 *
 * Two touches on `test_results`, both narrow: a read of candidate rows, and ONE compare-and-set
 * write (`running` → `queued`, guarded by `.eq('status', 'running')`) so a run that finished or was
 * paused between the SELECT and the UPDATE is left exactly as its executor left it. The actual
 * execution is never done here — the sweeper hands the run to `POST /api/admin/tests/runs/[runId]`
 * in background mode, and that route owns the claim and the run.
 */

import { logInfo, logWarn } from '~/lib/observability/logger';
import {
  REARMABLE_QUEUED_RUNNER_STATES,
  sweepStalledTestRuns,
  sweepStalledTestRunsInputSchema,
  type StalledTestRunCandidate,
  type StalledTestRunSweeperPort,
  type SweepStalledTestRunsContext,
  type SweepStalledTestRunsInput,
  type SweepStalledTestRunsResult,
} from '~/lib/observability/stalled-test-run-sweeper';
import { CHAT_RUN_MODES } from '~/lib/tests/run-mode';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { Json } from '~/types/supabase.public';

/**
 * Over-fetch: `queued` rows can only be filtered on `summary.runner_state` after the read, and a
 * page of never-started queued rows must not starve genuinely stalled running ones.
 */
const CANDIDATE_FETCH_MULTIPLIER = 3;

async function lastItemCreatedAt(runId: string): Promise<string | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('test_result_items')
    .select('created_at')
    .eq('test_result_id', runId)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    throw new Error(`select test_result_items: ${error.message}`);
  }

  return data?.[0]?.created_at ?? null;
}

export async function listStalledTestRunCandidates(
  limit: number,
): Promise<StalledTestRunCandidate[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('test_results')
    .select('id,test_id,status,created_at,started_at,summary')
    // B0-1110 — only the chat runner (`full` and `partial`) yields/resumes; search evals are seconds
    // long and never stall this way, so they stay excluded.
    .in('run_mode', [...CHAT_RUN_MODES])
    .in('status', ['running', 'queued'])
    .order('created_at', { ascending: true })
    .limit(limit * CANDIDATE_FETCH_MULTIPLIER);

  if (error) {
    throw new Error(`select test_results: ${error.message}`);
  }

  const rows = (data ?? []).filter((row) => {
    if (row.status === 'running') return true;
    const summary =
      row.summary && typeof row.summary === 'object' && !Array.isArray(row.summary)
        ? (row.summary as Record<string, unknown>)
        : {};
    return (
      typeof summary.runner_state === 'string' &&
      (REARMABLE_QUEUED_RUNNER_STATES as readonly string[]).includes(summary.runner_state)
    );
  });

  return Promise.all(
    rows.slice(0, limit).map(async (row) => ({
      id: row.id,
      test_id: row.test_id,
      status: row.status,
      created_at: row.created_at,
      started_at: row.started_at,
      summary: row.summary,
      last_item_at: await lastItemCreatedAt(row.id),
    })),
  );
}

export async function requeueRunningTestRun(id: string, summary: Json): Promise<boolean> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('test_results')
    .update({ status: 'queued', summary })
    .eq('id', id)
    .eq('status', 'running')
    .select('id');

  if (error) {
    throw new Error(`update test_results: ${error.message}`);
  }

  return Array.isArray(data) && data.length > 0;
}

export function createSupabaseStalledTestRunSweeperPort(): StalledTestRunSweeperPort {
  return {
    listCandidates: listStalledTestRunCandidates,
    requeueRunningRun: requeueRunningTestRun,
  };
}

/** Composes the Supabase port, the real clock and the structured logger for the route handler. */
export async function runStalledTestRunSweep(
  input: SweepStalledTestRunsInput,
  context: SweepStalledTestRunsContext,
): Promise<SweepStalledTestRunsResult> {
  return sweepStalledTestRuns(sweepStalledTestRunsInputSchema.parse(input), context, {
    port: createSupabaseStalledTestRunSweeperPort(),
    now: () => Date.now(),
    log: (event, fields) => {
      if (event.endsWith('_failed')) {
        logWarn(event, fields);
        return;
      }
      logInfo(event, fields);
    },
  });
}
