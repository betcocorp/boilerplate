-- B0-555: rag.entity.product_key is 0% populated (1,703 rows) for entity_type = 'product_line'.
--
-- Root cause: rag.legacy_product_line_profile_source (the view that feeds
-- rag.sync_legacy_product_profiles()) has always emitted `NULL::text AS product_key`
-- unconditionally for product_line rows -- verified against both the original
-- 20260406150000_rag_product_line_corpus.sql migration text AND the view's live
-- definition (they differ in other respects -- a later, simpler revision is what's
-- actually deployed -- but both hard-code product_key to NULL). This is a real,
-- ongoing bug: any future call to rag.sync_legacy_product_profiles() will keep
-- writing NULL back onto these rows if the view is left as-is, silently undoing
-- any backfill.
--
-- Fix, in two parts:
--   1) CREATE OR REPLACE the view so a product_line row gets `product_key`
--      populated ONLY when its legacy.products_attr (AttrTable='prodline')
--      linkage resolves to exactly ONE distinct legacy ProductsKey -- joined via
--      product_line_key (AttrKey), never by guessing off product_key directly.
--      Per B0-486 (documented formulation-variant aliasing rule for the pH7Q/HAN
--      family), a product line that maps to >=2 distinct formulations must NOT be
--      collapsed onto a single product_key -- those rows stay NULL, honestly
--      unresolvable to one canonical product, same as the rest of the codebase's
--      'line_only' semantics (src/lib/recommendations/candidate-retrieval.ts).
--   2) Backfill the 1,703 existing rows with the identical rule so the fix is not
--      only forward-looking.
--
-- Expected outcome (verified live against legacy.products_attr before writing this):
--   - 722 rows have no legacy.products_attr(AttrTable='prodline') linkage at all
--     (variant_count = 0 in their own stored metadata) -- genuinely no data to
--     derive from; stay NULL.
--   - 384 rows resolve to exactly one distinct ProductsKey -- backfilled.
--   - 597 rows resolve to 2+ distinct ProductsKeys (multi-formulation lines) --
--     stay NULL by design, not a bug.
--
-- NOTE: this migration was applied live via mcp__supabase__apply_migration on
-- 2026-08-16 (recorded in supabase_migrations.schema_migrations as version
-- 20260816065306) before this file existed. This file is the version-controlled
-- record of that already-applied change -- do not expect re-running it to do
-- anything (Part 2's UPDATE is a no-op once product_key is populated; Part 1's
-- CREATE OR REPLACE is idempotent).

-- Part 1: fix the view so future syncs don't regress the backfill.
CREATE OR REPLACE VIEW rag.legacy_product_line_profile_source AS
WITH product_line_variants AS (
  SELECT
    pa."AttrKey" AS prod_line_key,
    COUNT(DISTINCT p."ProductsKey") AS variant_count,
    (ARRAY_AGG(DISTINCT p."ProductsKey"))[1]::text AS sole_product_key
  FROM legacy.products_attr pa
  JOIN legacy.products p ON p."ProductsKey" = pa."ProductsKey"
  WHERE lower(coalesce(pa."AttrTable", '')) = 'prodline'
  GROUP BY pa."AttrKey"
)
SELECT
  'legacy'::text AS source_schema,
  'prod_line'::text AS source_table,
  pl."ProdLineKey" AS source_pk,
  'EN'::text AS language_code,
  'product_line_profile'::text AS source_type,
  concat('legacy:product_line:', pl."ProdLineKey", ':en') AS document_key,
  'product_line'::text AS entity_type,
  pl."ProdLineKey" AS entity_key,
  COALESCE(pl."Title", pl."ProdLineDescr", pl."ProdLineKey") AS title,
  NULL::text AS sku,
  pl."ProdLineKey" AS product_line_key,
  concat('Product line: ', COALESCE(pl."Title", pl."ProdLineDescr", pl."ProdLineKey")) AS body_text,
  jsonb_build_object(
    'source_schema', 'legacy',
    'source_table', 'prod_line',
    'product_line_key', pl."ProdLineKey"
  ) AS metadata,
  -- B0-555: derive product_key through product_line_key (AttrKey), only when unambiguous.
  (CASE WHEN plv.variant_count = 1 THEN plv.sole_product_key ELSE NULL END)::text AS product_key
FROM legacy.prod_line pl
LEFT JOIN product_line_variants plv ON plv.prod_line_key = pl."ProdLineKey"
WHERE pl."ProdLineKey" IS NOT NULL;

-- Part 2: backfill existing rag.entity product_line rows with the same rule.
WITH product_line_variants AS (
  SELECT
    pa."AttrKey" AS prod_line_key,
    COUNT(DISTINCT p."ProductsKey") AS variant_count,
    (ARRAY_AGG(DISTINCT p."ProductsKey"))[1]::text AS sole_product_key
  FROM legacy.products_attr pa
  JOIN legacy.products p ON p."ProductsKey" = pa."ProductsKey"
  WHERE lower(coalesce(pa."AttrTable", '')) = 'prodline'
  GROUP BY pa."AttrKey"
)
UPDATE rag.entity e
SET product_key = plv.sole_product_key
FROM product_line_variants plv
WHERE e.entity_type = 'product_line'
  AND e.product_key IS NULL
  AND plv.prod_line_key = e.product_line_key
  AND plv.variant_count = 1;
