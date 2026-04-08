import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { Tables, TablesInsert, TablesUpdate } from '~/types/supabase.public';

export type AgentConversationRow = Tables<'agent_conversations'>;

export async function createConversation(
  input: Partial<Pick<TablesInsert<'agent_conversations'>, 'title' | 'workspace_id' | 'user_id'>> = {},
): Promise<AgentConversationRow> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('agent_conversations')
    .insert({
      title: input.title ?? 'New conversation',
      workspace_id: input.workspace_id ?? null,
      user_id: input.user_id ?? null,
    })
    .select()
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to create conversation');
  }

  return data;
}

export async function getConversationById(
  id: string,
): Promise<AgentConversationRow | null> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('agent_conversations')
    .select()
    .eq('id', id)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return data;
}

export async function listConversations(limit = 50): Promise<AgentConversationRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('agent_conversations')
    .select()
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

export async function updateConversation(
  id: string,
  patch: TablesUpdate<'agent_conversations'>,
): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .from('agent_conversations')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    throw new Error(error.message);
  }
}

export async function deleteConversation(id: string): Promise<void> {
  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .from('agent_conversations')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(error.message);
  }
}
