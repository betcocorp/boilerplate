import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { Json } from '~/types/supabase.public';
import type { Tables, TablesInsert } from '~/types/supabase.public';

export type AgentMessageRow = Tables<'agent_messages'>;

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

  return data;
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
