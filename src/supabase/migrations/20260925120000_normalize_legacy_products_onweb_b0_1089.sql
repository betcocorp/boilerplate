-- B0-1089: normalize legacy.products."OnWeb" to '0' / '1' only.
--
-- "OnWeb" is the item-level "published on betco.com" flag ('1' = on web, '0' = not).
-- The January-2026 BetcoCatalog snapshot also carried 1,079 nulls and 27 rows of
-- column-shifted export text (JavaScript fragments on lines EP15/H632, a Safer Choice
-- disclaimer fragment on line 390). Every consumer (rag.product_line_web_url, the
-- product-profile views) already treats anything other than '1' as not-on-web, so
-- collapsing those values to '0' changes no derived result. Expected: 1,106 rows.
--
-- Deliberately no CHECK constraint: a snapshot refresh (B0-1078) may re-import the
-- same export artifact and should not fail on it; re-run this normalization there.

UPDATE legacy.products
SET "OnWeb" = '0'
WHERE "OnWeb" IS NULL
   OR "OnWeb" NOT IN ('0', '1');
