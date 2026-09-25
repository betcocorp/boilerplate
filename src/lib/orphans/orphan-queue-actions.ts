'use server';

import { getServerSession } from 'next-auth';
import { revalidatePath } from 'next/cache';

import { authOptions } from '~/lib/auth';
import { writeAuditLog } from '~/lib/audit/audit-log';
import { newCorrelationId } from '~/lib/observability/correlation-id';
import { isOrphanRecordFieldEditable } from '~/lib/orphans/orphan-record-editing';
import { getSupabaseServiceRoleClient } from '~/supabase/clients/service-role';
import {
  acknowledgeOrphanInputSchema,
  confirmEntityLinkInputSchema,
  createOrphanProductAliasInputSchema,
  orphanQueueRowSchema,
  orphanRecordInputSchema,
  orphanSummaryRowSchema,
  updateOrphanRecordFieldInputSchema,
  type AcknowledgeOrphanInput,
  type ConfirmEntityLinkInput,
  type CreateOrphanProductAliasInput,
  type OrphanDataType,
  type OrphanQueueRow,
  type OrphanRecordInput,
  type OrphanRecordResult,
  type OrphanSummaryRow,
  type UpdateOrphanRecordFieldInput,
} from '~/types/orphans';

const DEFAULT_PAGE_SIZE = 50;

/**
 * B0-1094 — every mutation below requires an authenticated reviewer, mirroring
 * `requireReviewer` in `~/lib/rag/product-alias-review-actions.ts`. `acknowledgeOrphan` above
 * predates this convention and has no session check; new mutations should not repeat that gap.
 */
async function requireReviewer(): Promise<string> {
  const session = await getServerSession(authOptions);
  if (!session?.user) {
    throw new Error('Unauthorized');
  }
  return session.user.email ?? session.user.name ?? 'admin';
}

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

/** Loosely-typed update builder — mirrors `LooseSelect` above, `table` is dynamic. */
type LooseUpdate = {
  update: (patch: Record<string, unknown>) => {
    eq: (col: string, val: string) => Promise<{ error: { message: string } | null }>;
  };
  select: (columns: string) => {
    eq: (
      col: string,
      val: string,
    ) => {
      maybeSingle: () => Promise<{
        data: Record<string, unknown> | null;
        error: { message: string } | null;
      }>;
    };
  };
};

function ragTable(table: string): LooseUpdate {
  return getSupabaseServiceRoleClient().schema('rag').from(table as never) as unknown as LooseUpdate;
}

/**
 * B0-1094 — a single real fix from `OrphanRecordDialog`: writes one field of the underlying
 * record (e.g. `rag.entity.product_line_key` for a `product_no_line` row), instead of only
 * ever hiding the row via `acknowledgeOrphan`. `field` is checked against
 * `isOrphanRecordFieldEditable` so the PK/timestamps/FK columns denylisted in
 * `~/lib/orphans/orphan-record-editing.ts` can't be written even if a caller bypasses the UI.
 */
export async function updateOrphanRecordField(input: UpdateOrphanRecordFieldInput): Promise<void> {
  const reviewer = await requireReviewer();
  const { dataType, refId, field, value } = updateOrphanRecordFieldInputSchema.parse(input);

  if (!isOrphanRecordFieldEditable(dataType, field)) {
    throw new Error(`Field "${field}" is not editable.`);
  }

  const table = ORPHAN_RECORD_TABLE[dataType];
  const { error } = await ragTable(table).update({ [field]: value }).eq('id', refId);
  if (error) throw new Error(`updateOrphanRecordField failed: ${error.message}`);

  await writeAuditLog(
    'orphan_record_field_updated',
    { data_type: dataType, ref_id: refId, table: `rag.${table}`, field, reviewed_by: reviewer },
    { traceId: newCorrelationId() },
  );
  revalidatePath('/admin/products/orphans', 'layout');
}

/**
 * B0-1094 — real "confirm this link" action for `product_link_unverified` rows, distinct from
 * Acknowledge (which stays the "I choose to ignore this" escape hatch and never touches the
 * record). Clears `rag.entity.metadata->>'link_needs_review'`, the only key the
 * `product_link_unverified` check (`public.orphan_checks_v`) reads — merged in rather than
 * overwriting the whole `metadata` blob, since that column also carries unrelated keys
 * (`link_method`, `sds_number`, etc. — see B0-203).
 */
export async function confirmEntityLink(input: ConfirmEntityLinkInput): Promise<void> {
  const reviewer = await requireReviewer();
  const { refId } = confirmEntityLinkInputSchema.parse(input);

  const entity = ragTable('entity');
  const { data: existing, error: fetchError } = await entity
    .select('metadata')
    .eq('id', refId)
    .maybeSingle();
  if (fetchError) throw new Error(`confirmEntityLink failed: ${fetchError.message}`);
  if (!existing) throw new Error('Entity not found.');

  const metadata = { ...(existing.metadata as Record<string, unknown>), link_needs_review: false };
  const { error } = await entity.update({ metadata }).eq('id', refId);
  if (error) throw new Error(`confirmEntityLink failed: ${error.message}`);

  await writeAuditLog(
    'orphan_entity_link_confirmed',
    { ref_id: refId, reviewed_by: reviewer },
    { traceId: newCorrelationId() },
  );
  revalidatePath('/admin/products/orphans', 'layout');
}

/**
 * B0-1094 — real "add alias" action for `product_no_alias` rows: inserts a genuinely new,
 * human-verified `rag.product_alias` row (mirrors `approveProductAlias` in
 * `~/lib/rag/product-alias-review-repository.ts` — `verified: true`, `reviewed_by`/`reviewed_at`
 * stamped immediately, since a human is creating this row on purpose rather than a corpus-scan
 * seeding an unverified candidate). `alias_norm` is computed the same way every other writer
 * computes it — duplicated locally rather than imported, matching the existing convention (see
 * `~/lib/rag/index-table-alias-capture.ts`: "duplicated because that function isn't exported").
 *
 * This does not attempt to clear the `product_no_alias` backlog — most of those ~9,200 rows are
 * products that legitimately have no synonym/acronym to add (see B0-1094 description). It only
 * gives a real path for the genuine cases.
 */
function normalizeAlias(value: string): string {
  return value
    .replace(/[®™]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export async function createOrphanProductAlias(input: CreateOrphanProductAliasInput): Promise<void> {
  const reviewer = await requireReviewer();
  const parsed = createOrphanProductAliasInputSchema.parse(input);

  const supabase = getSupabaseServiceRoleClient();
  const { error } = await supabase
    .schema('rag')
    .from('product_alias' as never)
    .insert({
      alias: parsed.alias,
      alias_norm: normalizeAlias(parsed.alias),
      entity_id: parsed.entityId,
      product_line_key: parsed.productLineKey,
      alias_type: parsed.aliasType,
      source: 'manual_admin',
      confidence: 1.0,
      verified: true,
      reviewed_by: reviewer,
      reviewed_at: new Date().toISOString(),
    } as never);
  if (error) throw new Error(`createOrphanProductAlias failed: ${error.message}`);

  await writeAuditLog(
    'orphan_product_alias_created',
    {
      entity_id: parsed.entityId,
      product_line_key: parsed.productLineKey,
      alias: parsed.alias,
      alias_type: parsed.aliasType,
      reviewed_by: reviewer,
    },
    { traceId: newCorrelationId() },
  );
  revalidatePath('/admin/products/orphans', 'layout');
}
