-- Populate rag.entity_link with product -> product_line edges (B0-247, depends on B0-246).
-- Idempotent: primary key (from_entity_id, to_entity_id, relation_type) makes re-runs a no-op.
--
-- relation_type = 'variant_of' from each B0-246-backfilled product entity to its product_line
-- parent, using the same product_line_key already resolved and stored on rag.entity by B0-246
-- (legacy.products."DSLProdLn" -> product_line entity's metadata->>'prod_line_id'). Scoped to
-- metadata->>'source_table' = 'products' so this only links B0-246's rows, not the 147
-- pre-existing entity_type='product' rows from an unrelated source (different canonical_key
-- scheme, e.g. 'betco:103') that already existed in rag.entity before B0-246.
--
-- Known data-quality note (not fixed here, just documented): 9 of the 9,090 active product
-- entities resolve to a different product-line parent under this DSLProdLn-based path than
-- under the older legacy.products_attr (AttrTable='prodline') path used to build each line's
-- metadata.variant_product_keys array. B0-246/B0-247 both use DSLProdLn per their tickets, so
-- these 9 edges are intentionally built via DSLProdLn; the products_attr-derived
-- variant_product_keys arrays were not changed. Affected ProductsKeys:
--   7C47E1C2-5C5F-4C2C-9B43-5895F67D4EEB, 54EB4080-CBF6-420E-B71C-4E7F5C161EF5,
--   20CE902E-E3C4-4E86-9533-8C645ABF7F5F, AD81BB05-20D8-41AC-9826-686663B0E592,
--   517AE3D9-669C-435B-B54E-4A6DD133DD44, 636087DE-1C1A-4395-B5D6-9A25FAC1C29D,
--   16008E24-75D6-4931-9D2B-6B2FD957881E, C51A10B7-ACDF-4105-8F0B-5F6123FA8DAD,
--   0060B892-A9C6-4860-A984-071A62010403
--
-- Expected result: 9,090 edges inserted (one per B0-246 product entity; each resolves to
-- exactly one product_line entity since rag.entity's (entity_type, canonical_key) is unique).

insert into rag.entity_link (from_entity_id, to_entity_id, relation_type)
select
  p.id,
  pl.id,
  'variant_of'
from rag.entity p
join rag.entity pl
  on pl.entity_type = 'product_line'
 and pl.canonical_key = p.product_line_key
where p.entity_type = 'product'
  and p.metadata->>'source_table' = 'products'
  and p.metadata->>'source_schema' = 'legacy'
on conflict (from_entity_id, to_entity_id, relation_type) do nothing;
