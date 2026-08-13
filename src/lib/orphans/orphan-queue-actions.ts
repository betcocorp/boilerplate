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

/** Per-check counts across every data type (drives the dashboard + sidebar badges). */
export async function getOrphanSummary(): Promise<OrphanSummaryRow[]> {
  const supabase = getSupabaseServiceRoleClient();
  const { data, error } = await supabase
    .from('orphan_queue_summary_v')
    .select('data_type, check_key, total, active, ignored');

  if (error) throw new Error(`getOrphanSummary failed: ${error.message}`);
  return orphanSummaryRowSchema.array().parse(data ?? []);
}

/** Paginated orphan rows for a single data type. Hides acknowledged rows unless includeIgnored. */
export async function getOrphanQueue(query: OrphanQueueQuery): Promise<OrphanQueueResult> {
  const {
    dataType,
    includeIgnored = false,
    search,
    page = 1,
    pageSize = DEFAULT_PAGE_SIZE,
  } = query;

  const supabase = getSupabaseServiceRoleClient();
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  let q = supabase
    .from('orphan_queue_v')
    .select(
      'check_key, data_type, ref_id, ref_label, detail, ignored, ignore_reason, ignored_by, ignored_at',
      { count: 'exact' },
    )
    .eq('data_type', dataType);

  if (!includeIgnored) q = q.eq('ignored', false);
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
