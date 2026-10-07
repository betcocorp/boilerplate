-- ============================================================
-- 20260520170445_sds_document_audit_view.sql
--
-- View to identify SDS documents that lack standard SDS section
-- structure. These may be mislabeled, non-SDS content, or
-- documents with unusual formatting (e.g. purchase orders,
-- letters, non-English without Spanish section markers).
--
-- DO NOT auto-reclassify. Review via this view first.
-- Run: SELECT count(*) FROM rag.suspect_sds_documents;
-- ============================================================

CREATE OR REPLACE VIEW rag.suspect_sds_documents AS
SELECT
  d.id,
  d.document_key,
  d.title,
  d.language_code,
  sr.source_pk,
  length(d.body_text)                           AS body_text_length,
  coalesce(d.metadata->>'product_line_key', '') AS product_line_key,
  left(d.body_text, 500)                        AS body_text_preview
FROM rag.document d
JOIN rag.source_record sr ON sr.id = d.source_record_id
WHERE d.document_kind = 'sds'
  AND sr.is_active = true
  AND d.body_text IS NOT NULL
  AND length(trim(d.body_text)) > 0
  AND d.body_text NOT ILIKE '%Section%1%'
  AND d.body_text NOT ILIKE '%Identification%'
  AND d.body_text NOT ILIKE '%Hazard%'
  AND d.body_text NOT ILIKE '%SECCI%'
ORDER BY length(d.body_text) DESC;

COMMENT ON VIEW rag.suspect_sds_documents IS
  'SDS documents lacking standard section structure (Section 1, Identification, Hazard markers). Review before reclassifying document_kind.';

GRANT SELECT ON rag.suspect_sds_documents TO service_role;
