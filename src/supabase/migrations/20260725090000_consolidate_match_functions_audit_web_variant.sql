-- ============================================================
-- 20260725090000_consolidate_match_functions_audit_web_variant.sql
-- B0-281: Consolidate match_* function overloads; audit & backfill has_web_available_variant
--
-- Actions:
-- 1. Audit for unintended overloads of match_* functions (expect 1 per function)
-- 2. Backfill has_web_available_variant metadata for document_chunk rows
--    (inherit from parent document's has_web_available_variant flag)
--
-- Note: match_corpus_chunks and match_corpus_chunks_hybrid already have
-- has_web_available_variant checks built into their WHERE clauses (via
-- d.metadata @> '{"has_web_available_variant": true}'::jsonb). This migration
-- ensures the metadata column itself is backfilled for retrieval and auditing.
-- ============================================================

-- Step 1: Drop unwanted overloads of match_product_chunks and match_product_chunks_hybrid
-- Diagnostic found 2 overloads each:
-- - match_product_chunks: 5-param (newer, with filter_section_type) vs 4-param (older, without)
-- - match_product_chunks_hybrid: 6-param (newer, with filter_section_type) vs 5-param (older, without)
-- Keep the ones WITH filter_section_type (5 and 6 params), drop the ones WITHOUT.

-- Drop 4-param overload of match_product_chunks (missing filter_section_type)
DROP FUNCTION IF EXISTS rag.match_product_chunks(
  extensions.halfvec,
  integer,
  text,
  text
) CASCADE;

-- Drop 5-param overload of match_product_chunks_hybrid (missing filter_section_type)
DROP FUNCTION IF EXISTS rag.match_product_chunks_hybrid(
  extensions.halfvec,
  text,
  integer,
  text,
  text
) CASCADE;

-- Step 2: Audit match_* function overloads after consolidation
-- Expected result: exactly one overload per function (verified via pg_proc count)
DO $$
DECLARE
  v_corpus_count INTEGER;
  v_corpus_hybrid_count INTEGER;
  v_product_count INTEGER;
  v_product_hybrid_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_corpus_count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'rag' AND p.proname = 'match_corpus_chunks';

  SELECT COUNT(*) INTO v_corpus_hybrid_count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'rag' AND p.proname = 'match_corpus_chunks_hybrid';

  SELECT COUNT(*) INTO v_product_count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'rag' AND p.proname = 'match_product_chunks';

  SELECT COUNT(*) INTO v_product_hybrid_count
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'rag' AND p.proname = 'match_product_chunks_hybrid';

  RAISE NOTICE 'B0-281 RPC Overload Audit: match_corpus_chunks=%/1, match_corpus_chunks_hybrid=%/1, match_product_chunks=%/1, match_product_chunks_hybrid=%/1',
    v_corpus_count, v_corpus_hybrid_count, v_product_count, v_product_hybrid_count;

  IF v_corpus_count != 1 OR v_corpus_hybrid_count != 1 OR v_product_count != 1 OR v_product_hybrid_count != 1 THEN
    RAISE EXCEPTION 'Overload ambiguity detected: consolidation incomplete. Counts: corpus=%, hybrid_corpus=%, product=%, hybrid_product=%',
      v_corpus_count, v_corpus_hybrid_count, v_product_count, v_product_hybrid_count;
  END IF;
END $$;

-- Step 2: Backfill has_web_available_variant for document_chunk
-- For product_line_profile documents: inherit from document.metadata
-- For label/sds documents: inherit from document.metadata
UPDATE rag.document_chunk dc
SET metadata = COALESCE(dc.metadata, '{}'::jsonb) || jsonb_build_object(
  'has_web_available_variant',
  COALESCE((d.metadata @> '{"has_web_available_variant": true}'::jsonb), false)
)
FROM rag.document d
WHERE d.id = dc.document_id
  AND (dc.metadata IS NULL OR NOT (dc.metadata ? 'has_web_available_variant'));

-- Step 3: Verify backfill coverage
-- Check that has_web_available_variant is now present on all document_chunks
-- from web-available documents
DO $$
DECLARE
  v_backfilled_count INTEGER;
  v_expected_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_backfilled_count
  FROM rag.document_chunk dc
  WHERE dc.metadata @> '{"has_web_available_variant": true}'::jsonb;

  SELECT COUNT(*) INTO v_expected_count
  FROM rag.document_chunk dc
  JOIN rag.document d ON d.id = dc.document_id
  WHERE d.metadata @> '{"has_web_available_variant": true}'::jsonb;

  IF v_backfilled_count = v_expected_count THEN
    RAISE NOTICE 'B0-281 consolidation complete: match_* functions audited (1 overload each), has_web_available_variant backfilled (% chunks)',
      v_backfilled_count;
  ELSE
    RAISE EXCEPTION 'B0-281 backfill incomplete: expected %, got % chunks with has_web_available_variant',
      v_expected_count, v_backfilled_count;
  END IF;
END $$;
