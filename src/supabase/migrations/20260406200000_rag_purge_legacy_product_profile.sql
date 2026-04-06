-- Hard-delete the old per-SKU RAG corpus (legacy.products → product_profile).
-- Leaves product_line_profile sources, documents, entities, and chunks untouched.
-- Run after product-line sync is deployed, or before a full re-sync from prod_line.

-- 1. Source rows: CASCADE deletes dependent rag.document and rag.document_chunk.
delete from rag.source_record sr
where sr.source_schema = 'legacy'
  and sr.source_table = 'products';

-- 2. Any product_profile documents not removed by CASCADE (orphans / bad links).
delete from rag.document d
where d.document_kind = 'product_profile';

-- 3. Canonical entities created only for the old product sync (ProductsKey as canonical_key).
delete from rag.entity e
where e.entity_type = 'product';
