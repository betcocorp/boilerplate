-- B0-283: Add corpus_scope to rag.document for policy-based SDS scoping
--
-- Scope values:
--   - 'betco_us' → Betco brand, US-only, finished goods
--   - 'betco_ca' → Betco brand, Canada-only, finished goods
--   - 'betco_uaca' → Betco brand, US & Canada, finished goods
--   - 'other' → Non-Betco, non-finished, or out of scope
--
-- Backfill logic:
--   1. Infer region from EPA registration number (US) vs DIN (Canada)
--   2. Filter for Betco brands only
--   3. Mark document_kind='sds' only if EPA or DIN present
--   4. Default to 'other' for unknown/out-of-scope

BEGIN;

-- Add corpus_scope column to rag.document
ALTER TABLE rag.document
ADD COLUMN corpus_scope TEXT DEFAULT 'other' CHECK (corpus_scope IN ('betco_us', 'betco_ca', 'betco_uaca', 'other'));

CREATE INDEX idx_document_corpus_scope ON rag.document(corpus_scope);

-- Backfill corpus_scope based on:
-- 1. Brand in metadata (must be 'betco')
-- 2. EPA registration number (US) or DIN (Canada)
-- 3. Document kind must be 'sds' or 'label'

UPDATE rag.document d
SET corpus_scope = CASE
  -- Betco brand + has EPA reg (US-only)
  WHEN (d.metadata->>'brand' = 'betco' OR d.metadata->>'brand' IS NULL)
    AND d.document_kind IN ('sds', 'label')
    AND d.metadata->>'epa_reg_no' IS NOT NULL
    AND d.metadata->>'din_no' IS NULL
  THEN 'betco_us'

  -- Betco brand + has DIN (Canada-only)
  WHEN (d.metadata->>'brand' = 'betco' OR d.metadata->>'brand' IS NULL)
    AND d.document_kind IN ('sds', 'label')
    AND d.metadata->>'din_no' IS NOT NULL
    AND d.metadata->>'epa_reg_no' IS NULL
  THEN 'betco_ca'

  -- Betco brand + has both EPA and DIN (US & Canada)
  WHEN (d.metadata->>'brand' = 'betco' OR d.metadata->>'brand' IS NULL)
    AND d.document_kind IN ('sds', 'label')
    AND d.metadata->>'epa_reg_no' IS NOT NULL
    AND d.metadata->>'din_no' IS NOT NULL
  THEN 'betco_uaca'

  -- Out of scope: non-Betco brands, non-SDS/label, or missing registration
  ELSE 'other'
END,
updated_at = now()
WHERE corpus_scope = 'other'
  AND (d.metadata->>'brand' IS NOT NULL OR d.document_kind IN ('sds', 'label'));

-- Update corpus_scope for documents with Betco brand (even without EPA/DIN) to betco_us as default
UPDATE rag.document d
SET corpus_scope = 'betco_us',
    updated_at = now()
WHERE corpus_scope = 'other'
  AND d.metadata->>'brand' = 'betco'
  AND d.document_kind IN ('sds', 'label')
  AND d.language_code IN ('en', 'EN', 'eng')
  AND d.metadata->>'epa_reg_no' IS NULL
  AND d.metadata->>'din_no' IS NULL;

-- Create view to identify out-of-scope documents for review/deletion
CREATE OR REPLACE VIEW rag.out_of_scope_documents AS
SELECT
  d.id,
  d.document_key,
  d.document_kind,
  d.title,
  d.language_code,
  d.metadata->>'brand' AS brand,
  d.metadata->>'epa_reg_no' AS epa_reg_no,
  d.metadata->>'din_no' AS din_no,
  d.corpus_scope,
  d.created_at,
  COUNT(dc.id) AS chunk_count
FROM rag.document d
LEFT JOIN rag.document_chunk dc ON d.id = dc.document_id
WHERE d.corpus_scope = 'other'
  AND d.document_kind IN ('sds', 'label')
GROUP BY d.id, d.document_key, d.document_kind, d.title, d.language_code, d.metadata, d.corpus_scope, d.created_at
ORDER BY d.created_at DESC;

GRANT SELECT ON rag.out_of_scope_documents TO authenticated;

COMMIT;
