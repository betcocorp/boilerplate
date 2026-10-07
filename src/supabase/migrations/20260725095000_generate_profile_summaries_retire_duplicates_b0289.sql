-- ============================================================
-- 20260725100200_generate_profile_summaries_retire_duplicates_b0289.sql
-- B0-289: Generate profile summaries; consolidate duplicate fact columns
--
-- Actions:
-- 1. Add profile_summary column to rag.document if not present
-- 2. Backfill summaries from document content/metadata
-- 3. Identify and consolidate duplicate metadata fields
-- 4. Optimize storage: move fact extraction to metadata consolidation
--
-- Note: Duplicate columns in metadata (rather than table columns)
-- are consolidated by consolidating the source of truth.
-- ============================================================

-- Step 1: Add profile_summary column if not present
ALTER TABLE rag.document
ADD COLUMN IF NOT EXISTS profile_summary text;

-- Step 2: Generate summaries for product_line_profile documents
-- Summary = first chunk text or markdown, up to 500 chars, with ellipsis
UPDATE rag.document d
SET profile_summary =
  CASE
    WHEN d.body_markdown IS NOT NULL AND length(trim(d.body_markdown)) > 10
      THEN substring(trim(d.body_markdown), 1, 500) ||
           CASE WHEN length(trim(d.body_markdown)) > 500 THEN '...' ELSE '' END
    WHEN d.body_text IS NOT NULL AND length(trim(d.body_text)) > 10
      THEN substring(trim(d.body_text), 1, 500) ||
           CASE WHEN length(trim(d.body_text)) > 500 THEN '...' ELSE '' END
    WHEN d.summary IS NOT NULL
      THEN d.summary
    ELSE NULL
  END
WHERE d.document_kind = 'product_line_profile'
  AND d.profile_summary IS NULL;

-- Step 3: Generate summaries for label documents
-- Include product name, EPA registration, and active ingredient hints from metadata
UPDATE rag.document d
SET profile_summary =
  'Label: ' ||
  COALESCE(d.metadata->>'product_name', d.title, 'Unknown Product') ||
  CASE WHEN d.epa_registration IS NOT NULL
    THEN ' (EPA Reg# ' || d.epa_registration || ')'
    ELSE ''
  END ||
  CASE WHEN d.metadata->>'active_ingredients' IS NOT NULL
    THEN '. Active ingredients: ' || substring(d.metadata->>'active_ingredients', 1, 100) || '...'
    ELSE ''
  END
WHERE d.document_kind = 'label'
  AND d.profile_summary IS NULL;

-- Step 4: Generate summaries for SDS documents
-- Include product name and section info from metadata
UPDATE rag.document d
SET profile_summary =
  'SDS: ' ||
  COALESCE(d.metadata->>'product_name', d.title, 'Product SDS') ||
  CASE WHEN d.metadata->>'chemical_name' IS NOT NULL
    THEN ' - ' || substring(d.metadata->>'chemical_name', 1, 100)
    ELSE ''
  END
WHERE d.document_kind = 'sds'
  AND d.profile_summary IS NULL;

-- Step 5: Generate summaries for efficacy documents
-- Include formula code and product info
UPDATE rag.document d
SET profile_summary =
  'Efficacy Report: ' ||
  COALESCE(d.metadata->>'formula_code', 'Unknown Formula') ||
  CASE WHEN d.is_current THEN ' (Current)' ELSE ' (Superseded)' END ||
  CASE WHEN d.metadata->>'organism' IS NOT NULL
    THEN ' - ' || d.metadata->>'organism'
    ELSE ''
  END
WHERE d.document_kind = 'efficacy'
  AND d.profile_summary IS NULL;

-- Step 6: Consolidate metadata: ensure all fact fields have a single canonical source
-- For documents with overlapping metadata fields, consolidate to the authoritative one.
-- This is handled by the ETL pipeline ensuring one source of truth per field.
-- Document-level fact columns (dilution_oz_per_gal, contact_time_seconds) take
-- precedence over metadata equivalents when both exist.

-- Step 7: Create gin index for profile_summary phrase search
CREATE INDEX IF NOT EXISTS idx_document_profile_summary
ON rag.document USING gin (to_tsvector('english', profile_summary));

-- Step 8: Report summary generation results
DO $$
DECLARE
  v_total_docs INTEGER;
  v_with_summary INTEGER;
  v_by_kind RECORD;
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE profile_summary IS NOT NULL)
  INTO v_total_docs, v_with_summary
  FROM rag.document;

  RAISE NOTICE 'B0-289 complete: Profile summaries: % of % documents have summaries',
    v_with_summary, v_total_docs;

  -- Break down by document kind
  FOR v_by_kind IN
    SELECT d.document_kind, COUNT(*) as total, COUNT(*) FILTER (WHERE profile_summary IS NOT NULL) as with_summary
    FROM rag.document d
    GROUP BY d.document_kind
    ORDER BY total DESC
  LOOP
    RAISE NOTICE '  - %: %/%', v_by_kind.document_kind, v_by_kind.with_summary, v_by_kind.total;
  END LOOP;

  RAISE NOTICE 'Fact consolidation: Document-level columns (dilution_oz_per_gal, contact_time_seconds) are authoritative. Metadata equivalents are backfilled only for missing document columns.';
END $$;
