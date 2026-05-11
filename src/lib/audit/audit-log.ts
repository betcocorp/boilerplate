import { getErrorMessage } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { Json } from '~/types/supabase.public';

export type AuditContext = {
  traceId: string;
  conversationId?: string | null;
  workflowRunId?: string | null;
  stepId?: string | null;
  model?: string | null;
  toolName?: string | null;
};

export async function writeAuditLog(
  eventType: string,
  payload: Record<string, unknown>,
  ctx: AuditContext,
): Promise<void> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const merged: Json = {
      trace_id: ctx.traceId,
      conversation_id: ctx.conversationId ?? null,
      workflow_run_id: ctx.workflowRunId ?? null,
      step_id: ctx.stepId ?? null,
      model: ctx.model ?? null,
      tool_name: ctx.toolName ?? null,
      ...payload,
    } as Json;

    await supabase.from('audit_logs').insert({
      event_type: eventType,
      payload: merged,
      conversation_id: ctx.conversationId ?? null,
      workflow_run_id: ctx.workflowRunId ?? null,
    });
  } catch (err) {
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'audit_log_write_failed',
        eventType,
        message: getErrorMessage(err),
      }),
    );
  }
}
