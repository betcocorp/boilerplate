-- ============================================================
-- 20260725100100_assign_section_type_to_chunks_b0287.sql
-- B0-287: Assign section_type to label & product-profile chunks
--
-- Backfill section_type column for document_chunk rows where
-- section_type IS NULL, based on the document_kind of the
-- parent document. This enables filtering and classification
-- of chunks by source document type.
--
-- Assignments:
-- - product_line_profile → section_type='profile'
-- - label → section_type='label'
-- - sds → section_type='sds'
-- - efficacy → section_type='efficacy'
-- - product_profile → section_type='profile'
-- ============================================================

-- Update product_line_profile chunks
UPDATE rag.document_chunk dc
SET section_type = 'profile',
    updated_at = timezone('utc', now())
FROM rag.document d
WHERE dc.document_id = d.id
  AND d.document_kind = 'product_line_profile'
  AND dc.section_type IS NULL;

-- Update label chunks
UPDATE rag.document_chunk dc
SET section_type = 'label',
    updated_at = timezone('utc', now())
FROM rag.document d
WHERE dc.document_id = d.id
  AND d.document_kind = 'label'
  AND dc.section_type IS NULL;

-- Update SDS chunks
UPDATE rag.document_chunk dc
SET section_type = 'sds',
    updated_at = timezone('utc', now())
FROM rag.document d
WHERE dc.document_id = d.id
  AND d.document_kind = 'sds'
  AND dc.section_type IS NULL;

-- Update efficacy chunks
UPDATE rag.document_chunk dc
SET section_type = 'efficacy',
    updated_at = timezone('utc', now())
FROM rag.document d
WHERE dc.document_id = d.id
  AND d.document_kind = 'efficacy'
  AND dc.section_type IS NULL;

-- Update product_profile chunks (if this kind exists)
UPDATE rag.document_chunk dc
SET section_type = 'profile',
    updated_at = timezone('utc', now())
FROM rag.document d
WHERE dc.document_id = d.id
  AND d.document_kind = 'product_profile'
  AND dc.section_type IS NULL;

-- Report results
DO $$
DECLARE
  v_total_chunks INTEGER;
  v_typed_chunks INTEGER;
  v_null_chunks INTEGER;
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE section_type IS NOT NULL), COUNT(*) FILTER (WHERE section_type IS NULL)
  INTO v_total_chunks, v_typed_chunks, v_null_chunks
  FROM rag.document_chunk;

  RAISE NOTICE 'B0-287 complete: Section type assignment: %/% chunks typed, % remaining NULL',
    v_typed_chunks, v_total_chunks, v_null_chunks;
END $$;

-- Create index for section_type filtering (improves query performance for scope='sds', scope='efficacy', etc.)
CREATE INDEX IF NOT EXISTS idx_document_chunk_section_type
ON rag.document_chunk(section_type)
WHERE section_type IS NOT NULL;
