-- Backfill active products (legacy.products where Status = 'AC') into rag.entity as
-- entity_type = 'product' rows (B0-246). Idempotent: upsert on (entity_type, canonical_key)
-- via the existing entity_identity_key constraint, safe to re-run.
--
-- Scope: Status = 'AC' only (9,103 rows as of 2026-07-23). Excludes 13 active ProductsKeys
-- with a null/blank DSLProdLn in legacy.products -- these have no product line in the source
-- data at all and cannot resolve to a product-line parent (documented exclusion; all 13 also
-- have a null Title, consistent with placeholder/private-label records rather than catalog
-- products):
--   047B9BF0-9113-4F33-893B-BDD7747C7F5F, 3BEE58D4-6B4B-4210-8219-F6071119BB3F,
--   4D2C15B1-48F1-49B3-885A-413D52BC988B, 5DB39862-E877-4D54-A959-AC75CFACFC15,
--   65211CC5-CEE8-47BC-8C40-CFAFE311F96F, 694FF8FC-06CF-42C0-9F69-4CD1A2A436BA,
--   716999FC-FF02-4B9B-9D11-4AE77795CB42, 71DA6CB3-1FF4-4721-8310-B8E191B7240B,
--   AB1991B3-1832-48F9-9A7E-D9ABAED955D2, B1124D2F-40BB-48F2-9E34-B6184E8CD7D8,
--   BFA8C84F-0E93-4332-B090-29AF79D9B6F7, C74423F0-7D6E-479F-926C-83612FAF33FD,
--   E2F0369A-EFD6-487F-8258-03E704C38F59
--
-- product_line_key resolution: legacy.products."DSLProdLn" -> rag.entity.metadata->>'prod_line_id'
-- (case-/whitespace-insensitive), landing on the matched product_line entity's canonical_key.
-- Rows that still don't resolve are excluded via the final WHERE, not inserted with a null link,
-- so every inserted row satisfies the "0 orphans" acceptance criterion by construction.
--
-- Expected result: 9,090 upserted rows. Re-running produces 0 duplicates (unique on
-- (entity_type, canonical_key)); pre-existing entity_type='product' rows from an unrelated
-- source (different canonical_key scheme, 147 rows as of 2026-07-23) are untouched.

with active_products as (
  select
    p."ProductsKey" as products_key,
    p."SKU" as sku,
    p."InvtID" as invt_id,
    p."Title" as title,
    p."SLDescr" as sl_descr,
    p."H1" as h1,
    p."H2" as h2,
    p."DSLProdLn" as dsl_prod_ln,
    p."Status" as status,
    p."DilutionCode" as dilution_code,
    p."MSRP" as msrp,
    p."OnWeb" as on_web
  from legacy.products p
  where p."Status" = 'AC'
),
product_titles as (
  select distinct on (pd."ProductsKey")
    pd."ProductsKey" as products_key,
    nullif(trim(pd."ShortDescr"), '') as short_descr
  from legacy.products_descr pd
  where upper(coalesce(pd."LanguageCD", 'EN')) = 'EN'
  order by pd."ProductsKey", pd."ProductsDescrKey" nulls last
),
resolved as (
  select
    ap.*,
    pt.short_descr,
    pl.canonical_key as resolved_product_line_key
  from active_products ap
  left join product_titles pt
    on pt.products_key = ap.products_key
  left join rag.entity pl
    on pl.entity_type = 'product_line'
   and upper(trim(pl.metadata->>'prod_line_id')) = upper(trim(ap.dsl_prod_ln))
)
insert into rag.entity (
  entity_type,
  canonical_key,
  title,
  sku,
  product_key,
  product_line_key,
  metadata
)
select
  'product',
  r.products_key,
  coalesce(
    r.short_descr,
    nullif(trim(r.title), ''),
    nullif(trim(r.sl_descr), ''),
    nullif(trim(r.h1), ''),
    nullif(trim(r.h2), ''),
    nullif(trim(r.sku), ''),
    r.invt_id,
    'Untitled product'
  ),
  coalesce(nullif(trim(r.sku), ''), r.invt_id),
  r.products_key,
  r.resolved_product_line_key,
  jsonb_strip_nulls(jsonb_build_object(
    'InvtID', r.invt_id,
    'Status', r.status,
    'DilutionCode', r.dilution_code,
    'MSRP', r.msrp,
    'OnWeb', r.on_web,
    'source_table', 'products',
    'source_schema', 'legacy'
  ))
from resolved r
where r.resolved_product_line_key is not null
on conflict on constraint entity_identity_key
do update
  set title = excluded.title,
      sku = excluded.sku,
      product_key = excluded.product_key,
      product_line_key = excluded.product_line_key,
      metadata = excluded.metadata;
