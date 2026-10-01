/**
 * B0-371 — Supabase wiring for the orphaned-run sweeper.
 *
 * All I/O for the sweeper lives here so that
 * `~/lib/observability/stalled-run-sweeper.ts` stays a pure decision module that
 * unit tests can drive with a stub port.
 *
 * This is the only WRITING module under `~/lib/observability/**` — the rest of the
 * observability domain (`runs-repository.ts`, `aggregates.ts`, `timeline.ts`) is
 * strictly read-only. Writes here are narrow on purpose: they touch only rows whose
 * `status` is still `'running'`, and the `.eq('status', 'running')` guard on each
 * update makes the transition a compare-and-set, so a run that finished between the
 * SELECT and the UPDATE is left exactly as the workflow left it.
 */

import { ORPHANED_SWEEP_AUDIT_EVENT } from '~/lib/observability/stalled-run-sweeper';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type {
  StalledRunCandidate,
  StalledRunSweeperPort,
  StalledStepCandidate,
} from '~/lib/observability/stalled-run-sweeper';

/** The one non-terminal `workflow_runs` / `workflow_steps` status in use. */
const RUNNING_STATUS = 'running';
const FAILED_STATUS = 'failed';

export function createSupabaseStalledRunSweeperPort(): StalledRunSweeperPort {
  return {
    async listStalledRunCandidates(
      cutoffIso: string,
      limit: number,
    ): Promise<StalledRunCandidate[]> {
      const supabase = getSupabaseServiceRoleClient();
      const { data, error } = await supabase
        .from('workflow_runs')
        .select('id,conversation_id,created_at,final_output')
        .eq('status', RUNNING_STATUS)
        .lte('created_at', cutoffIso)
        .order('created_at', { ascending: true })
        .limit(limit);

      if (error) {
        throw new Error(error.message);
      }

      return data ?? [];
    },

    async listStalledStepCandidates(
      cutoffIso: string,
      limit: number,
    ): Promise<StalledStepCandidate[]> {
      const supabase = getSupabaseServiceRoleClient();
      const { data, error } = await supabase
        .from('workflow_steps')
        .select('id,workflow_run_id,step_name,started_at,error')
        .eq('status', RUNNING_STATUS)
        .lte('started_at', cutoffIso)
        .order('started_at', { ascending: true })
        .limit(limit);

      if (error) {
        throw new Error(error.message);
      }

      return data ?? [];
    },

    async markRunOrphaned({ id, finalOutput, updatedAtIso }) {
      const supabase = getSupabaseServiceRoleClient();
      const { error } = await supabase
        .from('workflow_runs')
        .update({
          status: FAILED_STATUS,
          final_output: finalOutput,
          updated_at: updatedAtIso,
        })
        .eq('id', id)
        .eq('status', RUNNING_STATUS);

      if (error) {
        throw new Error(error.message);
      }
    },

    async markStepOrphaned({ id, error: stepError }) {
      const supabase = getSupabaseServiceRoleClient();
      // NOTE: `completed_at` is intentionally not written — see the comment in
      // `sweepStalledRuns`. The status flip is what makes the row terminal.
      const { error } = await supabase
        .from('workflow_steps')
        .update({ status: FAILED_STATUS, error: stepError })
        .eq('id', id)
        .eq('status', RUNNING_STATUS);

      if (error) {
        throw new Error(error.message);
      }
    },

    async recordSweepAudit({ runId, conversationId, payload }) {
      const supabase = getSupabaseServiceRoleClient();
      const { error } = await supabase.from('audit_logs').insert({
        event_type: ORPHANED_SWEEP_AUDIT_EVENT,
        workflow_run_id: runId,
        conversation_id: conversationId,
        payload: {
          workflow_run_id: runId,
          conversation_id: conversationId,
          ...payload,
        },
      });

      if (error) {
        throw new Error(error.message);
      }
    },
  };
}
