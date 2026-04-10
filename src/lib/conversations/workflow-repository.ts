import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { Json } from '~/types/supabase.public';
import type { Tables, TablesInsert, TablesUpdate } from '~/types/supabase.public';

export type WorkflowRunRow = Tables<'workflow_runs'>;
export type WorkflowStepRow = Tables<'workflow_steps'>;

export async function insertWorkflowRun(
  row: TablesInsert<'workflow_runs'>,
): Promise<WorkflowRunRow> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('workflow_runs')
    .insert(row)
    .select()
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to create workflow run');
  }

  return data;
}

export async function updateWorkflowRun(
  id: string,
  patch: TablesUpdate<'workflow_runs'>,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .from('workflow_runs')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    throw new Error(error.message);
  }
}

export async function insertWorkflowStep(
  row: TablesInsert<'workflow_steps'>,
): Promise<WorkflowStepRow> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('workflow_steps')
    .insert(row)
    .select()
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to create workflow step');
  }

  return data;
}

export async function completeWorkflowStep(
  id: string,
  patch: {
    status: string;
    output?: Json | null;
    error?: Json | null;
  },
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .from('workflow_steps')
    .update({
      status: patch.status,
      output: patch.output ?? null,
      error: patch.error ?? null,
      completed_at: new Date().toISOString(),
    })
    .eq('id', id);

  if (error) {
    throw new Error(error.message);
  }
}

export async function getWorkflowRunWithSteps(runId: string): Promise<{
  run: WorkflowRunRow;
  steps: WorkflowStepRow[];
} | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data: run, error: runError } = await supabase
    .from('workflow_runs')
    .select()
    .eq('id', runId)
    .maybeSingle();

  if (runError) {
    throw new Error(runError.message);
  }

  if (!run) {
    return null;
  }

  const { data: steps, error: stepsError } = await supabase
    .from('workflow_steps')
    .select()
    .eq('workflow_run_id', runId)
    .order('started_at', { ascending: true });

  if (stepsError) {
    throw new Error(stepsError.message);
  }

  return { run, steps: steps ?? [] };
}

export async function insertReviewTask(input: {
  workflowRunId: string;
  reason: string;
  payload: Json;
}): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase.from('review_tasks').insert({
    workflow_run_id: input.workflowRunId,
    status: 'open',
    reason: input.reason,
    payload: input.payload,
  });

  if (error) {
    throw new Error(error.message);
  }
}

export async function listAuditLogsForRun(runId: string) {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('audit_logs')
    .select()
    .eq('workflow_run_id', runId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}
