-- B0-249 (depends on B0-246, B0-248): tag product-specific documents with their resolved
-- active-product entity. Investigation phase found:
--   * rag.document has no product_key column, and the live retrieval RPC
--     (rag.match_product_chunks) only ever applies filter_product_key to
--     document_kind='product_line_profile' -- so nothing consumes a document-level product
--     link yet; this is prep work, not an active behavior change.
--   * SDS documents (2,958) carry a filename-derived metadata->>'product_code' that does NOT
--     reliably match legacy.products (0 exact matches; naive prefix matching produces false
--     positives against unrelated/inactive SKUs, e.g. code "2907" prefix-matching inactive SKU
--     "29070-00"). Left untouched -- do not guess on SDS identity, these are regulated
--     documents. Follow-up needed (e.g. via label metadata->>'sds_number' cross-reference) once
--     a verified join key exists.
--   * Label documents (789) carry a clean numeric metadata->>'sku'. Scoped to the 643 with no
--     existing entity_id (146 already point to an unrelated prior effort's product entities --
--     see B0-246/247/248 migration headers -- left untouched, not our call to override), 108
--     resolve to exactly one active product entity via rag.product_alias. The other 40 are
--     genuinely ambiguous (one label SKU code covers multiple package-size product variants)
--     and are left unmatched rather than picking one arbitrarily.
--
-- Idempotent: deterministic UPDATE, re-running yields the same result. Records match method +
-- confidence in metadata for traceability.

with label_skus as (
  select d.id as doc_id, d.metadata->>'sku' as sku_code
  from rag.document d
  where d.document_kind = 'label'
    and d.metadata->>'sku' is not null
    and d.entity_id is null
),
matches as (
  select ls.doc_id, pa.entity_id
  from label_skus ls
  join rag.product_alias pa
    on pa.alias_norm = lower(trim(ls.sku_code))
    or pa.alias_norm like lower(trim(ls.sku_code)) || '-%'
  join rag.entity e
    on e.id = pa.entity_id
   and e.entity_type = 'product'
   and e.metadata->>'source_table' = 'products'
),
unique_matches as (
  select doc_id, (array_agg(entity_id))[1] as entity_id
  from matches
  group by doc_id
  having count(distinct entity_id) = 1
)
update rag.document d
set entity_id = um.entity_id,
    metadata = d.metadata || jsonb_build_object(
      'product_entity_match', jsonb_build_object(
        'method', 'label_sku_alias',
        'confidence', 1.0,
        'ticket', 'B0-249'
      )
    )
from unique_matches um
where um.doc_id = d.id;
