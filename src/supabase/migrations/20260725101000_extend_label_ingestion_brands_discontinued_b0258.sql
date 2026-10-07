-- B0-258: Extend label ingestion to all Betco brands, add discontinued flagging, photo metadata
--
-- Changes:
--   1. Backfill is_discontinued from legacy.products.Status for all brands
--   2. Add support for brands: Betco, 1950, Basic Coatings, EnviroZyme
--   3. Populate photo_urls in label metadata from product assets
--
-- Brand mapping:
--   - 'betco' → Betco brand
--   - '1950' → 1950 Brands
--   - 'basic_coatings' → Basic Coatings
--   - 'envirozyme' → EnviroZyme

BEGIN;

-- Backfill is_discontinued from legacy.products.Status
-- Status values: 'Active', 'Discontinued', 'Pending', etc.
UPDATE rag.label l
SET is_discontinued = CASE
  WHEN lp."Status" IN ('Discontinued', 'DISC', 'D') THEN true
  WHEN lp."Status" IN ('Active', 'ACT', 'A') THEN false
  ELSE NULL
END,
    updated_at = now()
FROM legacy.products lp
WHERE l.product_key = lp."ProductsKey"
  AND lp."Status" IS NOT NULL;

-- Populate photo_urls in label metadata
-- Note: This assumes photo URLs may be stored in User_Str_* fields or product metadata
UPDATE rag.label l
SET metadata = jsonb_set(
  metadata,
  '{photo_urls}',
  COALESCE(
    -- Try to extract photo URLs from product User_Str_00 (reserved for photo)
    CASE
      WHEN lp."User_Str_00" IS NOT NULL AND lp."User_Str_00" ~ '^https?://'
      THEN jsonb_build_array(lp."User_Str_00")
      ELSE NULL
    END,
    '[]'::jsonb
  )
),
    updated_at = now()
FROM legacy.products lp
WHERE l.product_key = lp."ProductsKey"
  AND lp."User_Str_00" IS NOT NULL;

-- Create view to find all Betco brand products needing label ingestion
-- This view helps identify which products from all 4 brands should have labels
CREATE OR REPLACE VIEW rag.betco_active_products_for_labels AS
SELECT
  p."ProductsKey" AS product_key,
  p."Title" AS product_title,
  p."SKU" AS sku,
  CASE
    WHEN p."DSLProdLn" LIKE '%1950%' THEN '1950'
    WHEN p."DSLProdLn" LIKE '%Basic Coatings%' OR p."DSLProdLn" LIKE '%BasicCoatings%' THEN 'basic_coatings'
    WHEN p."DSLProdLn" LIKE '%EnviroZyme%' OR p."DSLProdLn" LIKE '%Enzymatic%' THEN 'envirozyme'
    ELSE 'betco'
  END AS brand,
  CASE
    WHEN p."Status" IN ('Discontinued', 'DISC', 'D') THEN true
    ELSE false
  END AS is_discontinued,
  p."Status" AS status,
  p."User_Str_00" AS photo_url
FROM legacy.products p
WHERE p."Status" IN ('Active', 'ACT', 'A')
  AND p."OnWeb" IN ('Y', 'YES', 'TRUE', '1')
  AND p."ProductsKey" IS NOT NULL
ORDER BY p."ProductsKey";

-- Grant access to view
GRANT SELECT ON rag.betco_active_products_for_labels TO authenticated;

COMMIT;
