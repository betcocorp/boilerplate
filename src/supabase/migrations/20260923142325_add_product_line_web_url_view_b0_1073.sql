-- B0-1074 (epic B0-1073): derive betco.com product-page URLs from legacy OnWeb items.
--
-- Bex has no queryable source of truth for "does this product line have a page on
-- betco.com, and what is its URL?". `legacy.products."OnWeb"` ('1' = web-visible,
-- '0'/null/garbage = not) is item-level; the line-level URL grammar is
-- https://www.betco.com/ProductsDetail?productID=<uppercase ProdLineKey GUID>.
--
-- Item -> line link: lower("AttrTable") = 'prodline' (both 'ProdLine' and 'Prodline'
-- spellings exist in legacy.products_attr). legacy.prod_line has duplicate ProdLineKey
-- rows (observed 3x) -- distinct on dedupes, preferring the row with a non-null
-- ProdLineID.
--
-- Verified live 2026-09-23: 288 rows; prod_line_id = '311' (Fight Bac RTU) resolves to
-- https://www.betco.com/ProductsDetail?productID=CA352FDA-543F-4D28-BB61-371247F351D4;
-- lines 9145 and 4020 (no OnWeb='1' items) are absent.

CREATE OR REPLACE VIEW rag.product_line_web_url
WITH (security_invoker = true) AS
WITH web_lines AS (
  SELECT DISTINCT upper(pa."AttrKey") AS prod_line_key
  FROM legacy.products_attr pa
  JOIN legacy.products p ON p."ProductsKey" = pa."ProductsKey"
  WHERE lower(pa."AttrTable") = 'prodline'
    AND p."OnWeb" = '1'
)
SELECT DISTINCT ON (upper(pl."ProdLineKey"))
       upper(pl."ProdLineKey") AS product_line_key,
       pl."ProdLineID"         AS prod_line_id,
       'https://www.betco.com/ProductsDetail?productID=' || upper(pl."ProdLineKey") AS web_url
FROM legacy.prod_line pl
JOIN web_lines w ON w.prod_line_key = upper(pl."ProdLineKey")
ORDER BY upper(pl."ProdLineKey"), pl."ProdLineID" NULLS LAST;

COMMENT ON VIEW rag.product_line_web_url IS
  'B0-1074: derived (read-only) betco.com product-page URL per web-visible product line. '
  'Source of truth is legacy.products."OnWeb" = ''1'' joined via legacy.products_attr '
  '(AttrTable=ProdLine/Prodline) to legacy.prod_line. Not verified for liveness -- see '
  'rag.product_line_web_url_check (B0-1077) for soft-404-aware verification state.';

GRANT SELECT ON rag.product_line_web_url TO authenticated, service_role;
