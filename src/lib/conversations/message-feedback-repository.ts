import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

export type AgentMessageFeedbackRow = {
  id: string;
  message_id: string;
  conversation_id: string;
  workflow_run_id: string | null;
  rating: 'up' | 'down';
  reason_code: string | null;
  comment: string | null;
  created_at: string;
  updated_at: string;
};

type UpsertMessageFeedbackInput = {
  messageId: string;
  conversationId: string;
  workflowRunId?: string | null;
  rating: 'up' | 'down';
  reasonCode?: string | null;
  comment?: string | null;
};

export async function upsertMessageFeedback(
  input: UpsertMessageFeedbackInput,
): Promise<AgentMessageFeedbackRow> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('agent_message_feedback')
    .upsert(
      {
        message_id: input.messageId,
        conversation_id: input.conversationId,
        workflow_run_id: input.workflowRunId ?? null,
        rating: input.rating,
        reason_code: input.reasonCode ?? null,
        comment: input.comment ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'message_id' },
    )
    .select('*')
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to save message feedback');
  }

  return data as AgentMessageFeedbackRow;
}

export async function listMessageFeedbackForConversation(
  conversationId: string,
): Promise<AgentMessageFeedbackRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('agent_message_feedback')
    .select('*')
    .eq('conversation_id', conversationId);

  if (error) {
    throw new Error(error.message);
  }

  return (data ?? []) as AgentMessageFeedbackRow[];
}
