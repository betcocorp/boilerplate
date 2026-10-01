-- B0-1092: verifier for document -> product-line links.
--
-- Recomputes the ERP line id from each linked document's own metadata and reports every row
-- where that disagrees with the line the document is actually linked to. Expected to be empty;
-- a row here is a link to investigate by hand, not something to auto-fix.
--
--   (i)  linked EN SDS whose product_code stem (Key C, see 20260925142000) resolves to a
--        product_line row DIFFERENT from the linked entity's line. key_used = 'product_code'.
--   (ii) linked labels whose sds_number (Key A) and sku (Key B) both resolve to a product_line
--        row but to DIFFERENT lines. One row per key (key_used = 'sds_number' / 'sku'), each
--        carrying that key's computed line, so both candidates are visible next to the linked one.
--
-- The linked line is resolved through product_line_key, so documents linked at product tier are
-- checked against their product's line. Metadata only: never reads document body text.

CREATE OR REPLACE VIEW rag.document_line_link_check
WITH (security_invoker = true) AS
WITH line_of_entity AS (
  SELECT e.id AS entity_id,
         ple.metadata->>'prod_line_id' AS prod_line_id
  FROM rag.entity e
  JOIN rag.entity ple
    ON ple.entity_type = 'product_line'
   AND ple.product_line_key = e.product_line_key
),
sds AS (
  SELECT d.id AS document_id,
         d.document_kind,
         d.document_key,
         loe.prod_line_id AS linked_prod_line_id,
         substring(d.metadata->>'product_code' FROM '^(?:SP)?0*(\d+)[A-Za-z]*$') AS stem,
         d.metadata->>'s3_key' AS s3_key_or_sku
  FROM rag.document d
  JOIN line_of_entity loe ON loe.entity_id = d.entity_id
  WHERE d.document_kind = 'sds'
    AND upper(d.language_code) = 'EN'
),
labels AS (
  SELECT d.id AS document_id,
         d.document_kind,
         d.document_key,
         loe.prod_line_id AS linked_prod_line_id,
         CASE WHEN regexp_replace(coalesce(d.metadata->>'sds_number', ''), '[A-Za-z]+$', '') ~ '^\d+$'
              THEN regexp_replace(d.metadata->>'sds_number', '[A-Za-z]+$', '') END AS key_a,
         CASE WHEN d.metadata->>'sku' ~ '^\d{5,6}$'
              THEN left(d.metadata->>'sku', length(d.metadata->>'sku') - 2) END AS key_b,
         d.metadata->>'sku' AS s3_key_or_sku
  FROM rag.document d
  JOIN line_of_entity loe ON loe.entity_id = d.entity_id
  WHERE d.document_kind = 'label'
),
label_conflicts AS (
  SELECT l.*,
         ea.metadata->>'prod_line_id' AS line_a,
         eb.metadata->>'prod_line_id' AS line_b
  FROM labels l
  JOIN rag.entity ea ON ea.entity_type = 'product_line' AND ea.metadata->>'prod_line_id' = l.key_a
  JOIN rag.entity eb ON eb.entity_type = 'product_line' AND eb.metadata->>'prod_line_id' = l.key_b
  WHERE ea.id <> eb.id
)
SELECT s.document_id,
       s.document_kind,
       s.document_key,
       s.linked_prod_line_id,
       e.metadata->>'prod_line_id' AS computed_prod_line_id,
       'product_code'::text AS key_used,
       s.s3_key_or_sku
FROM sds s
JOIN rag.entity e
  ON e.entity_type = 'product_line' AND e.metadata->>'prod_line_id' = s.stem
WHERE e.metadata->>'prod_line_id' IS DISTINCT FROM s.linked_prod_line_id
UNION ALL
SELECT lc.document_id, lc.document_kind, lc.document_key, lc.linked_prod_line_id,
       lc.line_a, 'sds_number'::text, lc.s3_key_or_sku
FROM label_conflicts lc
UNION ALL
SELECT lc.document_id, lc.document_kind, lc.document_key, lc.linked_prod_line_id,
       lc.line_b, 'sku'::text, lc.s3_key_or_sku
FROM label_conflicts lc;

COMMENT ON VIEW rag.document_line_link_check IS
  'B0-1092: verifier for rag.document -> product_line links. Recomputes the ERP line id from '
  'document metadata (SDS: product_code stem; label: sds_number and sku) and lists every linked '
  'document where the computed line differs from the linked line, or where a label''s two keys '
  'disagree with each other (one row per key). Expected empty; rows are for manual review.';

GRANT SELECT ON rag.document_line_link_check TO authenticated, service_role;
