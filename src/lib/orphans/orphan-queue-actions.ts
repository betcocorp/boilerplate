'use server';

import { revalidatePath } from 'next/cache';

import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import {
  acknowledgeOrphanInputSchema,
  orphanQueueRowSchema,
  orphanRecordInputSchema,
  orphanSummaryRowSchema,
  type AcknowledgeOrphanInput,
  type OrphanDataType,
  type OrphanQueueRow,
  type OrphanRecordInput,
  type OrphanRecordResult,
  type OrphanSummaryRow,
} from '~/types/orphans';

const DEFAULT_PAGE_SIZE = 50;

export interface OrphanQueueQuery {
  dataType: OrphanDataType;
  includeIgnored?: boolean;
  /** B0-804 — non-English source documents are hidden unless this is true. */
  includeTranslated?: boolean;
  /** B0-1093 — deactivated documents / inactive product lines are hidden unless this is true. */
  includeInactive?: boolean;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface OrphanQueueResult {
  rows: OrphanQueueRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Loosely-typed builders for the orphan views. `translated` (B0-804) and `inactive`
 * (B0-1093) were added to the live views and hand-edited into `src/types/supabase.public.ts`
 * — those files are generated and the Supabase CLI is unauthenticated locally, so the cast
 * stays as insurance against a stale regeneration (same pattern as
 * `~/lib/rag/corpus-stats.ts`). The Zod schemas still validate every row.
 */
type LooseQueueFilter = {
  eq: (column: string, value: string | boolean) => LooseQueueFilter;
  ilike: (column: string, value: string) => LooseQueueFilter;
  order: (column: string, options: { ascending: boolean }) => LooseQueueFilter;
  range: (
    from: number,
    to: number,
  ) => Promise<{
    data: unknown[] | null;
    error: { message: string } | null;
    count: number | null;
  }>;
};

type LooseQueueClient = {
  select: (columns: string, options: { count: 'exact' }) => LooseQueueFilter;
};

type LooseSummaryClient = {
  select: (
    columns: string,
  ) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
};

/** Per-check counts across every data type (drives the dashboard + sidebar badges). */
export async function getOrphanSummary(): Promise<OrphanSummaryRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await (
    supabase.from('orphan_queue_summary_v') as unknown as LooseSummaryClient
  ).select(
    'data_type, check_key, total, active, ignored, translated, active_translated, inactive, active_inactive, active_hidden',
  );

  if (error) throw new Error(`getOrphanSummary failed: ${error.message}`);
  return orphanSummaryRowSchema.array().parse(data ?? []);
}

/**
 * Paginated orphan rows for a single data type. Hides acknowledged rows unless
 * includeIgnored, hides translated (non-English) documents unless includeTranslated, and
 * hides inactive (deactivated source / inactive product line) rows unless includeInactive.
 * The three filters compose independently.
 */
export async function getOrphanQueue(query: OrphanQueueQuery): Promise<OrphanQueueResult> {
  const {
    dataType,
    includeIgnored = false,
    includeTranslated = false,
    includeInactive = false,
    search,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  } = query;

  const supabase = getSupabaseServiceRoleClient();
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let q = (supabase.from('orphan_queue_v') as unknown as LooseQueueClient)
    .select(
      'check_key, data_type, ref_id, ref_label, detail, translated, inactive, ignored, ignore_reason, ignored_by, ignored_at',
      { count: 'exact' },
    )
    .eq('data_type', dataType);

  if (!includeIgnored) q = q.eq('ignored', false);
  if (!includeTranslated) q = q.eq('translated', false);
  if (!includeInactive) q = q.eq('inactive', false);
  if (search && search.trim()) q = q.ilike('ref_label', `%${search.trim()}%`);

  const { data, error, count } = await q
    .order('ignored', { ascending: true })
    .order('check_key', { ascending: true })
    .order('ref_label', { ascending: true })
    .range(from, to);

  if (error) throw new Error(`getOrphanQueue failed: ${error.message}`);

  return {
    rows: orphanQueueRowSchema.array().parse(data ?? []),
    total: count ?? 0,
    page,
    pageSize,
  };
}

/**
 * The `rag`-schema table each orphan data type resolves to. Every one of these
 * tables is keyed by an `id` column, which is what `orphan_queue_v.ref_id` holds.
 */
const ORPHAN_RECORD_TABLE: Record<OrphanDataType, string> = {
  products: 'entity',
  product_lines: 'entity',
  labels: 'document',
  sds: 'document',
  documents: 'document',
  source_records: 'source_record',
  efficacy: 'product_efficacy',
};

/** Loosely-typed query builder — `table` is dynamic, so we bypass the generated relation union. */
type LooseSelect = {
  select: (columns: string) => {
    eq: (col: string, val: string) => {
      maybeSingle: () => Promise<{
        data: Record<string, unknown> | null;
        error: { message: string } | null;
      }>;
    };
  };
};

/** Fetch the full underlying record behind an orphan queue row (drives the "view document" dialog). */
export async function getOrphanRecord(input: OrphanRecordInput): Promise<OrphanRecordResult> {
  const { dataType, refId } = orphanRecordInputSchema.parse(input);
  const table = ORPHAN_RECORD_TABLE[dataType];

  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await (
    supabase.schema('rag').from(table as never) as unknown as LooseSelect
  )
    .select('*')
    .eq('id', refId)
    .maybeSingle();

  if (error) throw new Error(`getOrphanRecord failed: ${error.message}`);

  return { dataType, refId, table: `rag.${table}`, record: data };
}

/** Acknowledge (ignore) or un-acknowledge an orphaned record. */
export async function acknowledgeOrphan(input: AcknowledgeOrphanInput): Promise<void> {
  const { checkKey, refId, reason, isActive } = acknowledgeOrphanInputSchema.parse(input);

  const supabase = getSupabaseServiceRoleClient();
  // created_by: wire to the session user once per-user auth is available. Omitted rather than
  // passed as null — the generated Args type no longer admits null, and both params carry
  // `DEFAULT NULL::text` in the function, so leaving the key out stores the same NULL.
  const { error } = await supabase.rpc('set_orphan_ignore', {
    p_check_key: checkKey,
    p_ref_id: refId,
    p_reason: reason ?? undefined,
    p_is_active: isActive,
  });

  if (error) throw new Error(`acknowledgeOrphan failed: ${error.message}`);

  // Revalidate the orphans section (dashboard + every data-type queue page).
  revalidatePath('/admin/products/orphans', 'layout');
}
