-- B0-1092: link orphan Betco label documents to their product LINE by ERP line id.
--
-- Follow-on to B0-249 (20260724090000_link_unambiguous_label_docs_to_active_products.sql) and
-- its follow-up (20260822220000_link_remaining_label_docs_to_product_lines.sql), which matched at
-- SKU tier via rag.product_alias and assumed 3-digit line ids. 438 label docs still had
-- entity_id IS NULL (Betco 241, EnviroZyme 114, Basic Coatings 70, 1950 13). Only Betco is in
-- scope: the other brands' SKU namespaces are absent from the ERP master (see 20260822220000).
--
-- ERP grammar (system deep dive, 2026-09-25): a product line id is 3 OR 4 digits (1,032 of the
-- 1,703 lines are not 3-digit) and an item SKU is <line id><two-digit size code>:
-- 11705 -> line 117, 211904 -> line 2119. Every legacy line has exactly one rag.entity
-- product_line row carrying metadata->>'prod_line_id'. Two independent label metadata fields
-- reach that id:
--
--   Key A  metadata->>'sds_number' with trailing letters stripped ('425G' -> '425'). A value
--          that is not purely digits after stripping ('SP244') does not match.
--   Key B  metadata->>'sku' with its trailing two-digit size code removed ('211904' -> '2119').
--          Only 5- or 6-digit SKUs qualify (3-digit line + size, or 4-digit line + size).
--
-- Measured live 2026-09-25 on the 241 Betco orphans: A resolves 209, B resolves 192, both agree
-- on 174, exactly one resolves for 51, they conflict for 1, neither for 15 (kits F09..., SP...
-- aerosols). Only the AGREE set is linked, and only where the label was text-extracted and not
-- flagged for review (173 of the 174; the remaining one is OCR / needs_review). The single-key
-- and conflict docs go to rag.document_link_review with every candidate, regardless of
-- extraction method, and keep entity_id IS NULL.
--
-- Metadata only: never reads label body text (regulated-data rule). Grain is product_line, and
-- metadata.product_entity_match has the same shape as 20260822220000 plus a 'keys' array naming
-- the metadata fields that agreed.
--
-- Idempotent: the UPDATE is scoped to entity_id IS NULL and the review INSERT is
-- ON CONFLICT DO NOTHING. Reversible: every linked row carries
-- metadata->'product_entity_match'->>'ticket' = 'B0-1092' and method 'label_line_id'.

WITH untied AS (
  SELECT d.id,
         d.metadata->>'extraction_method' AS extraction_method,
         coalesce((d.metadata->>'needs_review')::boolean, false) AS needs_review,
         CASE WHEN regexp_replace(coalesce(d.metadata->>'sds_number', ''), '[A-Za-z]+$', '') ~ '^\d+$'
              THEN regexp_replace(d.metadata->>'sds_number', '[A-Za-z]+$', '') END AS key_a,
         CASE WHEN d.metadata->>'sku' ~ '^\d{5,6}$'
              THEN left(d.metadata->>'sku', length(d.metadata->>'sku') - 2) END AS key_b
  FROM rag.document d
  WHERE d.document_kind = 'label'
    AND d.entity_id IS NULL
    AND d.metadata->>'brand' = 'Betco'
),
keyed AS (
  SELECT u.*,
         ea.id AS entity_a, ea.metadata->>'prod_line_id' AS line_a, ea.product_line_key AS plk_a,
         eb.id AS entity_b, eb.metadata->>'prod_line_id' AS line_b, eb.product_line_key AS plk_b
  FROM untied u
  LEFT JOIN rag.entity ea
    ON ea.entity_type = 'product_line' AND ea.metadata->>'prod_line_id' = u.key_a
  LEFT JOIN rag.entity eb
    ON eb.entity_type = 'product_line' AND eb.metadata->>'prod_line_id' = u.key_b
),
linked AS (
  UPDATE rag.document d
  SET entity_id = k.entity_a,
      metadata = d.metadata || jsonb_build_object(
        'product_entity_match', jsonb_build_object(
          'method', 'label_line_id',
          'keys', jsonb_build_array('sds_number', 'sku'),
          'confidence', 1.0,
          'grain', 'product_line',
          'product_line_key', k.plk_a,
          'ticket', 'B0-1092'
        )
      ),
      updated_at = timezone('utc', now())
  FROM keyed k
  WHERE k.id = d.id
    AND d.entity_id IS NULL
    AND k.line_a IS NOT NULL
    AND k.line_b IS NOT NULL
    AND k.line_a = k.line_b
    AND k.extraction_method = 'text'
    AND k.needs_review = false
  RETURNING d.id
)
INSERT INTO rag.document_link_review (document_id, document_kind, candidate_lines, reason, ticket)
SELECT k.id,
       'label',
       jsonb_build_array(
         jsonb_build_object('key', 'sds_number', 'value', k.key_a, 'prod_line_id', k.line_a, 'product_line_key', k.plk_a),
         jsonb_build_object('key', 'sku',        'value', k.key_b, 'prod_line_id', k.line_b, 'product_line_key', k.plk_b)
       ),
       CASE WHEN k.line_a IS NOT NULL AND k.line_b IS NOT NULL THEN 'key_conflict' ELSE 'single_key' END,
       'B0-1092'
FROM keyed k
WHERE (k.line_a IS NOT NULL OR k.line_b IS NOT NULL)
  AND (k.line_a IS NULL OR k.line_b IS NULL OR k.line_a <> k.line_b)
ON CONFLICT (document_id, ticket) DO NOTHING;
