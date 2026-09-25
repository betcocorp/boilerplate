import type { OrphanDataType } from '~/types/orphans';

/**
 * B0-1094 — which columns of each `ORPHAN_RECORD_TABLE` target are safe to hand-edit from
 * `OrphanRecordDialog`, keyed by the bare `rag.<table>` name (not `OrphanDataType`, since
 * `products` and `product_lines` both resolve to `entity`).
 *
 * Universally excluded: the primary key and the two managed timestamps. Also excluded per table:
 * every FK-shaped uuid column (`entity_id`, `source_record_id`, `document.superseded_by_document_id`,
 * `document.cites_data_from_document_id`) — relinking a record to a different parent is a separate,
 * riskier feature with no picker backing it, unlike `rag.entity.product_line_key` which already has
 * one (`~/components/admin/ProductLinePicker.tsx`).
 */
export const ORPHAN_RECORD_READONLY_COLUMNS: Record<string, readonly string[]> = {
  // `entity_type` and `canonical_key` are the taxonomy/identity keys the rest of the app
  // routes and queries by (e.g. `entity_type='product'` everywhere in `~/lib/rag/**`) — as
  // risky to free-text as `id` itself, so treated the same way.
  entity: ['id', 'created_at', 'updated_at', 'entity_type', 'canonical_key'],
  document: [
    'id',
    'created_at',
    'updated_at',
    'source_record_id',
    'entity_id',
    'superseded_by_document_id',
    'cites_data_from_document_id',
    // Identity/routing keys, same reasoning as `entity.entity_type`/`canonical_key` above.
    'document_kind',
    'document_key',
  ],
  source_record: [
    'id',
    'created_at',
    'updated_at',
    'source_schema',
    'source_table',
    'source_pk',
  ],
  product_efficacy: ['id', 'updated_at', 'entity_id', 'source_record_id'],
};

/** The `rag`-schema table each orphan data type resolves to — mirrors `ORPHAN_RECORD_TABLE` in
 *  `~/lib/orphans/orphan-queue-actions.ts` (duplicated here so this module has no `'use server'`
 *  dependency and can be imported directly by client components). */
export const ORPHAN_EDIT_TABLE: Record<OrphanDataType, string> = {
  products: 'entity',
  product_lines: 'entity',
  labels: 'document',
  sds: 'document',
  documents: 'document',
  source_records: 'source_record',
  efficacy: 'product_efficacy',
};

export function isOrphanRecordFieldEditable(dataType: OrphanDataType, field: string): boolean {
  const table = ORPHAN_EDIT_TABLE[dataType];
  const readonly = ORPHAN_RECORD_READONLY_COLUMNS[table] ?? [];
  return !readonly.includes(field);
}
