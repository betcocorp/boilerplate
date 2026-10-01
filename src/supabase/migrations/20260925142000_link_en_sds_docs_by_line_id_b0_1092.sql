-- B0-1092: link orphan English SDS documents to their product LINE by ERP line id.
--
-- 766 EN SDS had entity_id IS NULL on 2026-09-25, by S3 top folder: Basic 231, EnviroZyme 229,
-- Private label 112, Betco 108, Intermediate (premix) 56, 1950 13, Battery 11, other 6. Two keys
-- reach a rag.entity product_line row (metadata->>'prod_line_id'), both from metadata only:
--
--   Key C  sds_filename_stem (confidence 1.0): the numeric stem of metadata->>'product_code'
--          (the S3 filename stem) -- optional leading 'SP', leading zeros and trailing language
--          letters removed: '4020CAN' -> '4020', 'SP0715CAN' -> '715'. Re-validated against the
--          1,597 EN SDS already linked: 1,595 agree or have a stem that is not a line id, 0
--          resolve to a DIFFERENT line, 2 have no numeric stem.
--   Key D  sds_products_attr (confidence 0.9): product_code || '.pdf' = legacy.documents.FileName
--          -> DocumentsKey -> legacy.products_attr (AttrTable = 'Documents') -> ProductsKey ->
--          legacy.products.DSLProdLn -> line. Applied only to docs Key C did not resolve, and only
--          when every reachable item rolls up to ONE line.
--
-- Paths deliberately left unlinked, whichever key would resolve them: archive copies ('Archive'
-- anywhere in s3_key), intermediates / premixes, battery SDS, Chemtrec transfer copies ('... SDS
-- files ready to transfer'), purchased components and kits (F0xxxx). A '(Chemtrec affiliate)'
-- folder is a private-label customer's folder, not a transfer copy, and is NOT excluded.
--
-- Measured live 2026-09-25 with those exclusions: Key C resolves 28 (26 Betco SDS + 2 private
-- label), Key D resolves 1. The 71 other Key D candidates (Amazon-ASIN filenames under
-- 'Amazon Commercial AM1320 Archive', 'Bioda (NuSource) AM6100 Archive' and 'Chemtrec SDS files
-- ready to transfer') are all archive / transfer copies and are left with entity_id IS NULL.
--
-- Metadata only: never reads SDS body text (regulated-data rule). Grain is product_line, same
-- metadata.product_entity_match shape as the label migrations.
--
-- Idempotent: UPDATE scoped to entity_id IS NULL. Reversible: every linked row carries
-- metadata->'product_entity_match'->>'ticket' = 'B0-1092'.

WITH untied AS (
  SELECT d.id,
         d.metadata->>'product_code' AS product_code,
         substring(d.metadata->>'product_code' FROM '^(?:SP)?0*(\d+)[A-Za-z]*$') AS stem
  FROM rag.document d
  WHERE d.document_kind = 'sds'
    AND d.entity_id IS NULL
    AND upper(d.language_code) = 'EN'
    AND d.metadata->>'s3_key' !~* '(archive|intermediate|battery|ready to transfer|purchased|/F0[0-9])'
),
-- Key C: filename stem -> exactly one line.
stem_candidates AS (
  SELECT DISTINCT u.id, e.id AS entity_id, e.product_line_key
  FROM untied u
  JOIN rag.entity e
    ON e.entity_type = 'product_line' AND e.metadata->>'prod_line_id' = u.stem
),
by_stem AS (
  SELECT id, entity_id, product_line_key
  FROM (SELECT s.*, count(*) OVER (PARTITION BY s.id) AS n FROM stem_candidates s) x
  WHERE n = 1
),
-- Key D: legacy.documents -> products_attr -> products -> DSLProdLn -> exactly one line.
attr_candidates AS (
  SELECT DISTINCT u.id, e.id AS entity_id, e.product_line_key
  FROM untied u
  JOIN legacy.documents ld
    ON lower(ld."FileName") = lower(u.product_code || '.pdf')
  JOIN legacy.products_attr pa
    ON lower(pa."AttrTable") = 'documents' AND pa."AttrKey" = ld."DocumentsKey"
  JOIN legacy.products p
    ON p."ProductsKey" = pa."ProductsKey"
  JOIN rag.entity e
    ON e.entity_type = 'product_line' AND e.metadata->>'prod_line_id' = p."DSLProdLn"
  WHERE NOT EXISTS (SELECT 1 FROM by_stem s WHERE s.id = u.id)
),
by_attr AS (
  SELECT id, entity_id, product_line_key
  FROM (SELECT a.*, count(*) OVER (PARTITION BY a.id) AS n FROM attr_candidates a) x
  WHERE n = 1
),
resolved AS (
  SELECT id, entity_id, product_line_key,
         'sds_filename_stem' AS method, 1.0 AS confidence,
         jsonb_build_array('product_code') AS keys
  FROM by_stem
  UNION ALL
  SELECT id, entity_id, product_line_key,
         'sds_products_attr', 0.9,
         jsonb_build_array('product_code', 'legacy.documents', 'legacy.products_attr', 'legacy.products.DSLProdLn')
  FROM by_attr
)
UPDATE rag.document d
SET entity_id = r.entity_id,
    metadata = d.metadata || jsonb_build_object(
      'product_entity_match', jsonb_build_object(
        'method', r.method,
        'keys', r.keys,
        'confidence', r.confidence,
        'grain', 'product_line',
        'product_line_key', r.product_line_key,
        'ticket', 'B0-1092'
      )
    ),
    updated_at = timezone('utc', now())
FROM resolved r
WHERE r.id = d.id
  AND d.entity_id IS NULL;
