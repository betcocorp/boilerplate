/**
 * Generic store for short AI-generated suggestion sets, keyed by
 * (`entity_type`, `entity_id`). Two scopes use it today:
 *  - `'item'` — per-test-item recommendations (`/admin/tests/[testId]/items/[itemId]`)
 *  - `'workflow_run'` — trace prompt insights (B0-420)
 *
 * Deliberately unaware of either payload: `metadata` is the escape hatch for the
 * fields a caller needs that this table has no column for. Row encoding lives with
 * the caller (see `~/lib/observability/prompt-insights` for the trace scope).
 */

import { assertSupabaseNoError as assertNoError } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import type { Json, Tables, TablesInsert } from '~/types/supabase.public';

export type AiSuggestionRecord = Tables<'ai_suggestions'>;
export type NewAiSuggestionRecord = TablesInsert<'ai_suggestions'>;

/** Rows come back ordered, and each carries its `metadata` and `created_at`. */
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
  suggestions: Array<{
    title: string;
    content: string;
    model?: string | null;
    /** Generation metadata; omitted entries keep the column's `'{}'` default. */
    metadata?: Json;
  }>,
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
    // `metadata` is `not null default '{}'`; sending undefined would violate that on
    // an explicit insert, so normalise here rather than relying on the default.
    metadata: s.metadata ?? {},
  }));

  const result = await supabase.from('ai_suggestions').insert(rows).select('*');
  return assertNoError(result) as AiSuggestionRecord[];
}
