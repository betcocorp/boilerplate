import { z } from 'zod';

/**
 * Orphan monitor contracts.
 * Backed by public.orphan_queue_v / public.orphan_queue_summary_v and the
 * public.orphan_ignore table (see migration 20260721000000_orphan_monitor_queue).
 */

export const ORPHAN_DATA_TYPES = [
  'products',
  'product_lines',
  'labels',
  'sds',
  'documents',
  'source_records',
  'efficacy',
] as const;

export const orphanDataTypeSchema = z.enum(ORPHAN_DATA_TYPES);
export type OrphanDataType = z.infer<typeof orphanDataTypeSchema>;

export const orphanCheckKeySchema = z.enum([
  'product_no_line',
  'product_link_unverified',
  'product_no_alias',
  'product_line_no_documents',
  'label_no_entity',
  'sds_no_entity',
  'document_no_chunks',
  'source_record_not_materialized',
  'efficacy_no_entity',
]);
export type OrphanCheckKey = z.infer<typeof orphanCheckKeySchema>;

export const orphanQueueRowSchema = z.object({
  check_key: orphanCheckKeySchema,
  data_type: orphanDataTypeSchema,
  ref_id: z.string(),
  ref_label: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  /** Non-English source document (B0-804) — expected, never chunked or retrieved. */
  translated: z.boolean(),
  /**
   * Deactivated source record, or a record on an inactive/empty product line (B0-1093,
   * via B0-1091 `line_lifecycle`) — expected, not a defect.
   */
  inactive: z.boolean(),
  ignored: z.boolean(),
  ignore_reason: z.string().nullable(),
  ignored_by: z.string().nullable(),
  ignored_at: z.string().nullable(),
});
export type OrphanQueueRow = z.infer<typeof orphanQueueRowSchema>;

export const orphanSummaryRowSchema = z.object({
  data_type: orphanDataTypeSchema,
  check_key: orphanCheckKeySchema,
  total: z.number(),
  active: z.number(),
  ignored: z.number(),
  /** How many of `total` are non-English source documents (B0-804). */
  translated: z.number(),
  /**
   * How many of `active` are translated. The queue table's default view is
   * "not acknowledged AND not translated", so the visible count is
   * `active - active_translated` — subtracting `translated` would double-count any
   * translated row that was also acknowledged.
   */
  active_translated: z.number(),
  /** How many of `total` are inactive (B0-1093). */
  inactive: z.number(),
  /** How many of `active` are inactive. */
  active_inactive: z.number(),
  /**
   * How many of `active` are hidden by default — translated OR inactive, counted once.
   * A row can be both (a deactivated Spanish SDS), so `active - active_hidden` is the
   * count the queue table shows; subtracting the two flags separately would double-count.
   */
  active_hidden: z.number(),
});
export type OrphanSummaryRow = z.infer<typeof orphanSummaryRowSchema>;

export const acknowledgeOrphanInputSchema = z.object({
  checkKey: orphanCheckKeySchema,
  refId: z.string().min(1),
  reason: z.string().max(2000).optional(),
  isActive: z.boolean().default(true),
});
export type AcknowledgeOrphanInput = z.infer<typeof acknowledgeOrphanInputSchema>;

export const orphanRecordInputSchema = z.object({
  dataType: orphanDataTypeSchema,
  refId: z.string().min(1),
});
export type OrphanRecordInput = z.infer<typeof orphanRecordInputSchema>;

/**
 * B0-1094 — a single-field edit from `OrphanRecordDialog`. `value` is intentionally untyped: the
 * target column's own type (text/numeric/boolean/jsonb) is whatever the client sends, and the
 * server action only checks the field isn't on the read-only denylist
 * (`~/lib/orphans/orphan-record-editing.ts`) before writing it — there is no per-column schema to
 * validate against without hand-maintaining one for four tables' worth of columns.
 */
export const updateOrphanRecordFieldInputSchema = z.object({
  dataType: orphanDataTypeSchema,
  refId: z.string().min(1),
  field: z.string().min(1),
  value: z.unknown(),
});
export type UpdateOrphanRecordFieldInput = z.infer<typeof updateOrphanRecordFieldInputSchema>;

/** B0-1094 — clears `rag.entity.metadata->>'link_needs_review'` for a `product_link_unverified` row. */
export const confirmEntityLinkInputSchema = z.object({
  refId: z.string().min(1),
});
export type ConfirmEntityLinkInput = z.infer<typeof confirmEntityLinkInputSchema>;

/** B0-1094 — creates a real, human-verified `rag.product_alias` row for a `product_no_alias` row. */
export const createOrphanProductAliasInputSchema = z.object({
  entityId: z.string().min(1),
  productLineKey: z.string().trim().min(1, 'A product line is required.'),
  alias: z.string().trim().min(1, 'An alias is required.').max(200),
  aliasType: z.enum([
    'acronym',
    'common_name',
    'sku',
    'misspelling',
    'legacy_name',
    'synonym',
    'title',
  ]),
});
export type CreateOrphanProductAliasInput = z.infer<typeof createOrphanProductAliasInputSchema>;

export interface OrphanRecordResult {
  dataType: OrphanDataType;
  refId: string;
  /** Fully-qualified source table the record was read from, e.g. `rag.document`. */
  table: string;
  /** The full underlying row, or null if it no longer exists. */
  record: Record<string, unknown> | null;
}

/** Human-friendly labels for the UI. */
export const ORPHAN_DATA_TYPE_LABELS: Record<OrphanDataType, string> = {
  products: 'Products',
  product_lines: 'Product Lines',
  labels: 'Labels',
  sds: 'SDS',
  documents: 'Documents',
  source_records: 'Source Records',
  efficacy: 'Efficacy',
};

export const ORPHAN_CHECK_LABELS: Record<OrphanCheckKey, string> = {
  product_no_line: 'Not linked to a product line',
  product_link_unverified: 'Linked heuristically — needs review',
  product_no_alias: 'No lookup alias',
  product_line_no_documents: 'Product line has no documents',
  label_no_entity: 'Label not attached to an entity',
  sds_no_entity: 'SDS not attached to an entity',
  document_no_chunks: 'Document has no chunks (not retrievable)',
  source_record_not_materialized: 'Source record never materialized into a document',
  efficacy_no_entity: 'Efficacy row references a missing entity',
};
