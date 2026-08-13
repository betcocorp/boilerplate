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

/**
 * The `audit_logs` row for one event, without `created_at` (which the immediate writer
 * below leaves to the column default).
 *
 * B0-439 — extracted so the deferred writer (`~/lib/audit/audit-log-queue.ts`) produces
 * byte-identical rows to this immediate path: same merged payload, same column mapping.
 * Only the timing of the insert differs between the two.
 */
export type AuditLogRowInsert = {
  event_type: string;
  payload: Json;
  conversation_id: string | null;
  workflow_run_id: string | null;
};

export function buildAuditLogRow(
  eventType: string,
  payload: Record<string, unknown>,
  ctx: AuditContext,
): AuditLogRowInsert {
  const merged: Json = {
    trace_id: ctx.traceId,
    conversation_id: ctx.conversationId ?? null,
    workflow_run_id: ctx.workflowRunId ?? null,
    step_id: ctx.stepId ?? null,
    model: ctx.model ?? null,
    tool_name: ctx.toolName ?? null,
    ...payload,
  } as Json;

  return {
    event_type: eventType,
    payload: merged,
    conversation_id: ctx.conversationId ?? null,
    workflow_run_id: ctx.workflowRunId ?? null,
  };
}

export async function writeAuditLog(
  eventType: string,
  payload: Record<string, unknown>,
  ctx: AuditContext,
): Promise<void> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    await supabase.from('audit_logs').insert(buildAuditLogRow(eventType, payload, ctx));
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
