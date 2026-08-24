import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { Tables, TablesInsert, TablesUpdate } from '~/types/supabase.public';

export type AgentConversationRow = Tables<'agent_conversations'>;

export async function createConversation(
  input: Partial<
    Pick<
      TablesInsert<'agent_conversations'>,
      'title' | 'workspace_id' | 'user_id' | 'source' | 'test_name'
    >
  > = {},
): Promise<AgentConversationRow> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('agent_conversations')
    .insert({
      title: input.title ?? 'New conversation',
      workspace_id: input.workspace_id ?? null,
      user_id: input.user_id ?? null,
      ...(input.source !== undefined ? { source: input.source } : {}),
      ...(input.test_name !== undefined ? { test_name: input.test_name } : {}),
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

/**
 * B0-449 — a non-admin's own conversations: real chats only (`source = 'chat'`), never test-runner
 * noise. Same ordering as the superseded `listConversations`.
 */
export async function listConversationsForUser(
  userId: string,
  limit = 80,
): Promise<AgentConversationRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('agent_conversations')
    .select()
    .eq('user_id', userId)
    .eq('source', 'chat')
    .order('updated_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(error.message);
  }

  return data ?? [];
}

export type AgentConversationRowWithOwner = AgentConversationRow & {
  ownerName: string | null;
  ownerEmail: string | null;
};

/**
 * B0-449 — the unscoped listing for a service caller or a `bex.chat.view-all` admin. Optional
 * `userFilter`/`source` narrow it (B0-451's admin sidebar filters); with neither, this returns the
 * same rows `listConversations` used to.
 *
 * `agent_conversations.user_id` has no FK to `app_user` (it is a plain text match, not a database
 * constraint — see the B0-448 migration), so PostgREST cannot embed the join; the owner name/email
 * are resolved with a second query instead. B0-449's own route usage does not read `ownerName`/
 * `ownerEmail` — that is B0-451's job — but the join is cheap enough to do unconditionally now
 * rather than add a second version of this function later.
 */
export async function listAllConversations(options?: {
  userFilter?: string;
  source?: string;
  limit?: number;
}): Promise<AgentConversationRowWithOwner[]> {
  const limit = options?.limit ?? 80;
  const supabase = getSupabaseServiceRoleClient();

  let query = supabase
    .from('agent_conversations')
    .select()
    .order('updated_at', { ascending: false })
    .limit(limit);
  if (options?.userFilter) {
    query = query.eq('user_id', options.userFilter);
  }
  if (options?.source) {
    query = query.eq('source', options.source);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(error.message);
  }
  const rows = data ?? [];

  const userIds = [...new Set(rows.map((row) => row.user_id).filter((id): id is string => id != null))];
  if (userIds.length === 0) {
    return rows.map((row) => ({ ...row, ownerName: null, ownerEmail: null }));
  }

  const { data: owners, error: ownersError } = await supabase
    .from('app_user')
    .select('user_id, user_name, name, email')
    .in('user_id', userIds);
  if (ownersError) {
    throw new Error(ownersError.message);
  }

  const ownerById = new Map((owners ?? []).map((owner) => [owner.user_id, owner]));
  return rows.map((row) => {
    const owner = row.user_id ? ownerById.get(row.user_id) : undefined;
    return {
      ...row,
      ownerName: owner?.user_name ?? owner?.name ?? null,
      ownerEmail: owner?.email ?? null,
    };
  });
}



/**
 * B0-451 — single-row owner-join for `GET /api/bex/conversations/[id]`. Mirrors the fallback
 * chain `listAllConversations` already uses (`user_name` first, then `name`) but for one user id
 * rather than a batch, since the detail route only ever needs one.
 */
export async function getConversationOwnerInfo(
  userId: string,
): Promise<{ ownerName: string | null; ownerEmail: string | null }> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('app_user')
    .select('user_name, name, email')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return {
    ownerName: data?.user_name ?? data?.name ?? null,
    ownerEmail: data?.email ?? null,
  };
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
