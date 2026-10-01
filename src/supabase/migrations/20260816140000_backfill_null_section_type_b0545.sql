-- B0-545: Backfill section_type on rag.document_chunk (37% null).
--
-- Note on the ticket's table name: rag.label_chunk / rag.label do not exist in the live
-- schema. The migration that would have created them
-- (src/supabase/migrations/20260725100000_create_rag_label_schema_b0256.sql) was never
-- applied -- confirmed via mcp__supabase__list_tables/list_migrations. Label chunks live
-- in rag.document_chunk (document_kind = 'label') like every other document kind, and
-- that document_kind is already 0% null on section_type. The real 37.1% null figure
-- (10,730 / 28,942 rows, confirmed live) is concentrated entirely in:
--   sds        9,207 / 15,371 null (59.9%)
--   knowledge  1,279 / 1,279  null (100%)
--   efficacy     244 / 438    null (55.7%)
--
-- Reusing the SAME derivation logic already used in this codebase
-- (src/supabase/migrations/20260725094000_assign_section_type_to_chunks_b0287.sql):
-- a coarse per-document_kind bucket, applied only where section_type IS NULL (never
-- overwrites the finer-grained GHS section types like 'toxicology'/'regulatory' that a
-- separate, untracked one-off classification already assigned to ~40% of SDS chunks).
-- B0-287 assigned product_line_profile->'profile', label->'label', sds->'sds',
-- efficacy->'efficacy', product_profile->'profile', but never covered 'knowledge' --
-- despite the coarse 'knowledge' bucket being the documented assumption elsewhere in
-- this codebase (see src/lib/retrieval/b0272-section-type-filter-regression.test.ts:
-- "label/knowledge chunks are always the coarse label/knowledge bucket"). This
-- migration re-runs the same B0-287 statements (covering any sds/efficacy chunks
-- ingested since B0-287 ran) and adds the missing 'knowledge' bucket.

UPDATE rag.document_chunk dc
SET section_type = 'profile',
    updated_at = timezone('utc', now())
FROM rag.document d
WHERE dc.document_id = d.id
  AND d.document_kind = 'product_line_profile'
  AND dc.section_type IS NULL;

UPDATE rag.document_chunk dc
SET section_type = 'label',
    updated_at = timezone('utc', now())
FROM rag.document d
WHERE dc.document_id = d.id
  AND d.document_kind = 'label'
  AND dc.section_type IS NULL;

UPDATE rag.document_chunk dc
SET section_type = 'sds',
    updated_at = timezone('utc', now())
FROM rag.document d
WHERE dc.document_id = d.id
  AND d.document_kind = 'sds'
  AND dc.section_type IS NULL;

UPDATE rag.document_chunk dc
SET section_type = 'efficacy',
    updated_at = timezone('utc', now())
FROM rag.document d
WHERE dc.document_id = d.id
  AND d.document_kind = 'efficacy'
  AND dc.section_type IS NULL;

-- New in this migration: B0-287 never covered 'knowledge'.
UPDATE rag.document_chunk dc
SET section_type = 'knowledge',
    updated_at = timezone('utc', now())
FROM rag.document d
WHERE dc.document_id = d.id
  AND d.document_kind = 'knowledge'
  AND dc.section_type IS NULL;

UPDATE rag.document_chunk dc
SET section_type = 'profile',
    updated_at = timezone('utc', now())
FROM rag.document d
WHERE dc.document_id = d.id
  AND d.document_kind = 'product_profile'
  AND dc.section_type IS NULL;

DO $$
DECLARE
  v_total_chunks INTEGER;
  v_typed_chunks INTEGER;
  v_null_chunks INTEGER;
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (WHERE section_type IS NOT NULL), COUNT(*) FILTER (WHERE section_type IS NULL)
  INTO v_total_chunks, v_typed_chunks, v_null_chunks
  FROM rag.document_chunk;

  RAISE NOTICE 'B0-545 complete: section_type assignment: %/% chunks typed, % remaining NULL',
    v_typed_chunks, v_total_chunks, v_null_chunks;
END $$;
