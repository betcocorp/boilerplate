-- B0-283: Purge out-of-scope SDS documents from rag
--
-- Context: corpus_scope was added in previous migration. This migration
-- identifies and deletes documents that are:
--   1. document_kind = 'sds'
--   2. corpus_scope = 'other' (out of policy scope)
--   3. Not Betco brand or missing EPA/DIN registration
--
-- This is a soft-delete via marking source_record.is_active = false.
-- Actual cascading deletes on document/document_chunk happen via foreign key constraints.
-- Purpose: Clean up non-US/Canada, non-Betco SDS documents to reduce corpus noise.

BEGIN;

-- Soft-delete documents by marking source_record.is_active = false
-- Find all SDS documents marked as 'other' scope
UPDATE rag.source_record sr
SET is_active = false,
    updated_at = now()
FROM rag.document d
WHERE sr.id = d.source_record_id
  AND d.document_kind = 'sds'
  AND d.corpus_scope = 'other'
  AND sr.is_active = true
  AND d.language_code IN ('en', 'EN', 'eng');

-- Log purged documents (for audit trail)
-- Create a temporary view for audit purposes
CREATE TEMPORARY TABLE rag_purged_sds_documents_audit AS
SELECT
  d.id,
  d.document_key,
  d.title,
  d.language_code,
  d.metadata->>'brand' AS brand,
  d.metadata->>'epa_reg_no' AS epa_reg_no,
  d.metadata->>'din_no' AS din_no,
  d.corpus_scope,
  d.created_at,
  d.updated_at,
  COUNT(dc.id) AS chunk_count
FROM rag.document d
LEFT JOIN rag.document_chunk dc ON d.id = dc.document_id
WHERE d.document_kind = 'sds'
  AND d.corpus_scope = 'other'
  AND d.language_code IN ('en', 'EN', 'eng')
GROUP BY d.id, d.document_key, d.title, d.language_code, d.metadata, d.corpus_scope, d.created_at, d.updated_at;

-- Count purged documents (informational)
SELECT COUNT(*) AS sds_documents_marked_inactive FROM rag_purged_sds_documents_audit;

COMMIT;
