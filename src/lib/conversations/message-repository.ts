import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import { clampedDurationMs } from '~/lib/conversations/turn-metrics';
import { logWarn } from '~/lib/observability/logger';

import type { Json } from '~/types/supabase.public';
import type { Tables, TablesInsert } from '~/types/supabase.public';

export type AgentMessageRow = Tables<'agent_messages'>;

/**
 * B0-532 — which stored metric a message row carries, keyed by its role. A user row carries the
 * pause that preceded it (measured back to the previous *assistant* message); an assistant row
 * carries the processing time that produced it (measured back to the most recent *user* message).
 * Tool/system rows carry neither.
 */
const TURN_METRIC_BY_ROLE: Record<
  string,
  { column: 'user_pause_ms' | 'processing_ms'; priorRole: string } | undefined
> = {
  user: { column: 'user_pause_ms', priorRole: 'assistant' },
  assistant: { column: 'processing_ms', priorRole: 'user' },
};

/**
 * B0-532 — stamp `user_pause_ms` / `processing_ms` onto a just-inserted message.
 *
 * Runs *after* the insert so both ends of the span are Postgres-stamped `created_at` values (the
 * inserted row's own timestamp comes back from the insert), rather than mixing the Node clock in —
 * the `workflow_steps.started_at`/`completed_at` cross-clock skew is the cautionary precedent.
 * `clampedDurationMs` still clamps at 0 so a skewed span can never violate the CHECK constraint.
 *
 * The lookup is scoped to `conversation_id` only (act-as-aware: a conversation has one owner, so
 * attributing by conversation never crosses owners). First turn of a conversation has no prior
 * assistant message, so `user_pause_ms` stays NULL there by design.
 *
 * Returns the metric patch applied (empty when there is nothing to stamp). Never throws: metrics
 * are best-effort telemetry and must not fail or roll back the message write itself.
 */
async function applyTurnMetrics(
  inserted: AgentMessageRow,
): Promise<Partial<Pick<AgentMessageRow, 'user_pause_ms' | 'processing_ms'>>> {
  const metric = TURN_METRIC_BY_ROLE[inserted.role];
  if (!metric || inserted[metric.column] !== null) {
    // Not a metered role, or the caller supplied the value explicitly on insert.
    return {};
  }

  try {
    const supabase = getSupabaseServiceRoleClient();
    // `lte` rather than `lt`: a same-millisecond prior turn should count as a 0ms span, not be
    // missed. The inserted row itself can never match — it has the opposite role.
    const { data: prior, error: priorError } = await supabase
      .from('agent_messages')
      .select('created_at')
      .eq('conversation_id', inserted.conversation_id)
      .eq('role', metric.priorRole)
      .lte('created_at', inserted.created_at)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (priorError) {
      throw new Error(priorError.message);
    }
    if (!prior) {
      return {};
    }

    const durationMs = clampedDurationMs(prior.created_at, inserted.created_at);
    if (durationMs === null) {
      return {};
    }

    const patch: Partial<Pick<AgentMessageRow, 'user_pause_ms' | 'processing_ms'>> =
      metric.column === 'user_pause_ms'
        ? { user_pause_ms: durationMs }
        : { processing_ms: durationMs };
    const { error: updateError } = await supabase
      .from('agent_messages')
      .update(patch)
      .eq('id', inserted.id);

    if (updateError) {
      throw new Error(updateError.message);
    }

    return patch;
  } catch (error) {
    logWarn('turn_metrics_stamp_failed', {
      messageId: inserted.id,
      conversationId: inserted.conversation_id,
      role: inserted.role,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

export async function insertMessage(
  row: TablesInsert<'agent_messages'>,
): Promise<AgentMessageRow> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('agent_messages')
    .insert(row)
    .select()
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to insert message');
  }

  // B0-532 — every caller (user turns in `run-chat-turn.ts`, assistant turns in
  // `run-product-support-workflow.ts`) funnels through here, so stamping in the repository
  // instruments both sides of the split without touching the workflow. `pause_tier` is a stored
  // generated column and is never written; it derives from `user_pause_ms` in Postgres.
  const metricPatch = await applyTurnMetrics(data);

  return { ...data, ...metricPatch };
}

export async function listMessagesForConversation(
  conversationId: string,
): Promise<AgentMessageRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('agent_messages')
    .select()
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

export async function getMessageById(messageId: string): Promise<AgentMessageRow | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('agent_messages')
    .select()
    .eq('id', messageId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export function jsonContent(value: unknown): Json {
  return value as Json;
}
