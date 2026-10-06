/**
 * B0-528 — read/write repository for `public.escalations`, the durable record the
 * `escalation_specialist` tool creates when Bex cannot answer from approved documents.
 *
 * Every row that leaves this module is parsed through `escalationRowSchema`, so a hand-edited or
 * future-migrated row with an unexpected status/reason surfaces as a loud parse error rather than
 * a silently mis-rendered badge. All access is through the service-role client (RLS is on,
 * service_role-only — see the B0-528 migration).
 */

import { z } from 'zod';

import { ESCALATION_REASONS } from '~/lib/tools/tool-schemas';
import { assertSupabaseNoError } from '~/lib/utils';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';

import type { Json } from '~/types/supabase.public';

export const ESCALATION_STATUSES = ['open', 'in_review', 'resolved', 'dismissed'] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

/** B0-416 vocabulary, shared with `workflow_runs.source`; mirrors the table CHECK. */
export const ESCALATION_SOURCES = ['harness', 'bex_chat', 'orchestrator_api'] as const;
export type EscalationSource = (typeof ESCALATION_SOURCES)[number];

export const escalationRetrievedSourceRowSchema = z.object({
  title: z.string(),
  documentId: z.string().optional(),
});

export const escalationRowSchema = z.object({
  id: z.uuid(),
  created_at: z.string(),
  updated_at: z.string(),
  status: z.enum(ESCALATION_STATUSES),
  reference: z.string().min(1),
  source: z.enum(ESCALATION_SOURCES).nullable(),
  workflow_run_id: z.uuid().nullable(),
  conversation_id: z.uuid().nullable(),
  user_id: z.string().nullable(),
  acted_by_user_id: z.string().nullable(),
  specialist: z.string().nullable(),
  reason: z.enum(ESCALATION_REASONS),
  question: z.string(),
  summary: z.string(),
  // Tolerant: an unexpected jsonb shape renders as "no sources" rather than failing the page.
  retrieved_sources: z
    .array(escalationRetrievedSourceRowSchema)
    .catch(() => [] as Array<z.infer<typeof escalationRetrievedSourceRowSchema>>),
  external_ticket_ref: z.string().nullable(),
  resolved_at: z.string().nullable(),
  resolution_notes: z.string().nullable(),
});

export type EscalationRow = z.infer<typeof escalationRowSchema>;

export const ESCALATION_SELECT_COLUMNS =
  'id, created_at, updated_at, status, reference, source, workflow_run_id, conversation_id, user_id, acted_by_user_id, specialist, reason, question, summary, retrieved_sources, external_ticket_ref, resolved_at, resolution_notes';

export type InsertEscalationInput = {
  reason: EscalationRow['reason'];
  question: string;
  summary: string;
  retrievedSources: Array<{ title: string; documentId?: string }>;
  specialist: string | null;
  source: EscalationSource | null;
  workflowRunId: string | null;
  conversationId: string | null;
  userId: string | null;
  actedByUserId: string | null;
};

/** Inserts one escalation; the DB assigns `reference` (sequence default) and `status: 'open'`. */
export async function insertEscalation(input: InsertEscalationInput): Promise<EscalationRow> {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('escalations')
    .insert({
      reason: input.reason,
      question: input.question,
      summary: input.summary,
      retrieved_sources: input.retrievedSources as unknown as Json,
      specialist: input.specialist,
      source: input.source,
      workflow_run_id: input.workflowRunId,
      conversation_id: input.conversationId,
      user_id: input.userId,
      acted_by_user_id: input.actedByUserId,
    })
    .select(ESCALATION_SELECT_COLUMNS)
    .single();
  return escalationRowSchema.parse(assertSupabaseNoError(result));
}

/**
 * The escalation already logged for this workflow run, if any — the executor's "at most once per
 * turn" backstop: a second call in the same run returns the existing reference instead of a
 * duplicate row.
 */
export async function findEscalationByWorkflowRunId(
  workflowRunId: string,
): Promise<EscalationRow | null> {
  const supabase = getSupabaseServiceRoleClient();
  const result = await supabase
    .from('escalations')
    .select(ESCALATION_SELECT_COLUMNS)
    .eq('workflow_run_id', workflowRunId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const data = assertSupabaseNoError(result);
  return data ? escalationRowSchema.parse(data) : null;
}

/**
 * B0-1084 ownership of the conversation the tool ran in: `user_id` is the act-as-aware owner,
 * `acted_by_user_id` the true session user when an admin was acting-as. Harness conversations carry
 * null for both. Never throws — an unresolvable conversation simply yields nulls, because an
 * attribution lookup must not fail the escalation itself.
 */
export async function getConversationOwnership(
  conversationId: string,
): Promise<{ userId: string | null; actedByUserId: string | null }> {
  try {
    const supabase = getSupabaseServiceRoleClient();
    const { data, error } = await supabase
      .from('agent_conversations')
      .select('user_id, acted_by_user_id')
      .eq('id', conversationId)
      .maybeSingle();
    if (error || !data) {
      return { userId: null, actedByUserId: null };
    }
    return { userId: data.user_id ?? null, actedByUserId: data.acted_by_user_id ?? null };
  } catch {
    return { userId: null, actedByUserId: null };
  }
}

export type ListEscalationsFilters = {
  /** Omit for every status. */
  status?: EscalationStatus;
  limit: number;
  offset: number;
};

/**
 * Newest first, over-fetching one row to compute `hasMore` without a count query (same pattern as
 * `listWorkflowRuns`). `.range` keeps every page under PostgREST's 1000-row cap.
 */
export async function listEscalations(
  filters: ListEscalationsFilters,
): Promise<{ rows: EscalationRow[]; hasMore: boolean }> {
  const supabase = getSupabaseServiceRoleClient();
  let query = supabase
    .from('escalations')
    .select(ESCALATION_SELECT_COLUMNS)
    .order('created_at', { ascending: false });
  if (filters.status) {
    query = query.eq('status', filters.status);
  }
  const result = await query.range(filters.offset, filters.offset + filters.limit);
  const fetched = assertSupabaseNoError(result) ?? [];
  const hasMore = fetched.length > filters.limit;
  const page = hasMore ? fetched.slice(0, filters.limit) : fetched;
  return { rows: page.map((row) => escalationRowSchema.parse(row)), hasMore };
}

export type UpdateEscalationStatusInput = {
  id: string;
  status: EscalationStatus;
  /** Replaces the stored notes; `null` clears them. */
  resolutionNotes: string | null;
};

/**
 * Status change from the admin page. `resolved_at` is stamped when the row moves to a terminal
 * status (`resolved` / `dismissed`) and cleared when it is reopened, so the column always agrees
 * with `status`.
 */
export async function updateEscalationStatus(
  input: UpdateEscalationStatusInput,
): Promise<EscalationRow> {
  const supabase = getSupabaseServiceRoleClient();
  const terminal = input.status === 'resolved' || input.status === 'dismissed';
  const result = await supabase
    .from('escalations')
    .update({
      status: input.status,
      resolution_notes: input.resolutionNotes,
      resolved_at: terminal ? new Date().toISOString() : null,
    })
    .eq('id', input.id)
    .select(ESCALATION_SELECT_COLUMNS)
    .single();
  return escalationRowSchema.parse(assertSupabaseNoError(result));
}
