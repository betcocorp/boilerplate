-- B0-1089 (part 2): make legacy.products."OnWeb" an integer flag that accepts only 0 or 1.
--
-- Part 1 (20260925120000) collapsed nulls and export artifacts to '0', so every row is
-- '0' or '1' text and casts cleanly. Supersedes that file's "deliberately no CHECK
-- constraint" note: Tom wants the column typed and constrained. A future snapshot
-- refresh (B0-1078) must normalize to 0/1 before loading or the load fails here.
--
-- rag.product_line_web_url (B0-1074) is the only DB object that depends on the column;
-- Postgres refuses ALTER TYPE under a dependent view, so it is dropped and recreated
-- with the same body, comparing against integer 1.

DROP VIEW rag.product_line_web_url;

ALTER TABLE legacy.products
  ALTER COLUMN "OnWeb" TYPE integer USING ("OnWeb"::integer),
  ALTER COLUMN "OnWeb" SET NOT NULL,
  ALTER COLUMN "OnWeb" SET DEFAULT 0,
  ADD CONSTRAINT products_onweb_check CHECK ("OnWeb" IN (0, 1));

CREATE VIEW rag.product_line_web_url
WITH (security_invoker = true) AS
WITH web_lines AS (
  SELECT DISTINCT upper(pa."AttrKey") AS prod_line_key
  FROM legacy.products_attr pa
  JOIN legacy.products p ON p."ProductsKey" = pa."ProductsKey"
  WHERE lower(pa."AttrTable") = 'prodline'
    AND p."OnWeb" = 1
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
  'Source of truth is legacy.products."OnWeb" = 1 (integer, B0-1089) joined via legacy.products_attr '
  '(AttrTable=ProdLine/Prodline) to legacy.prod_line. Not verified for liveness -- see '
  'rag.product_line_web_url_check (B0-1077) for soft-404-aware verification state.';

GRANT SELECT ON rag.product_line_web_url TO authenticated, service_role;
