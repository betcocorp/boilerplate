import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { Tables, TablesInsert } from '~/types/supabase.public';

export type AiSuggestionRecord = Tables<'ai_suggestions'>;
export type NewAiSuggestionRecord = TablesInsert<'ai_suggestions'>;

function assertNoError<T>(payload: { data: T; error: { message: string } | null }) {
  if (payload.error) {
    throw new Error(payload.error.message);
  }
  return payload.data;
}

export async function listAiSuggestions(
  entityType: string,
  entityId: string,
): Promise<AiSuggestionRecord[]> {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('ai_suggestions')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('sort_order', { ascending: true });
  return assertNoError(result) as AiSuggestionRecord[];
}

export async function replaceAiSuggestions(
  entityType: string,
  entityId: string,
  suggestions: Array<{ title: string; content: string; model?: string | null }>,
): Promise<AiSuggestionRecord[]> {
  const supabase = getSupabaseServiceRoleClient();

  await supabase
    .from('ai_suggestions')
    .delete()
    .eq('entity_type', entityType)
    .eq('entity_id', entityId);

  if (suggestions.length === 0) {
    return [];
  }

  const rows: NewAiSuggestionRecord[] = suggestions.map((s, i) => ({
    entity_type: entityType,
    entity_id: entityId,
    title: s.title,
    content: s.content,
    sort_order: i + 1,
    model: s.model ?? null,
  }));

  const result = await supabase.from('ai_suggestions').insert(rows).select('*');
  return assertNoError(result) as AiSuggestionRecord[];
}
