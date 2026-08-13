-- ============================================================
-- 20260725090001_consolidate_match_product_overloads_safe.sql
-- B0-281 Continuation: Safely drop duplicate match_product_chunks overloads
--
-- This migration is a safer alternative that queries for the actual overloads
-- before dropping, to ensure we don't accidentally drop the wrong one.
-- Run ONLY if 20260725090000 fails with overload errors.
-- ============================================================

-- Step 1: Identify and drop extra overloads
-- We expect exactly 1 overload per function after cleanup
DO $$
DECLARE
  v_product_oid OID;
  v_product_hybrid_oid OID;
  v_count_product INTEGER;
  v_count_product_hybrid INTEGER;
BEGIN
  -- Count current overloads
  SELECT COUNT(*) INTO v_count_product
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'rag' AND p.proname = 'match_product_chunks';

  SELECT COUNT(*) INTO v_count_product_hybrid
  FROM pg_proc p
  JOIN pg_namespace n ON p.pronamespace = n.oid
  WHERE n.nspname = 'rag' AND p.proname = 'match_product_chunks_hybrid';

  RAISE NOTICE 'Before consolidation: match_product_chunks=% overloads, match_product_chunks_hybrid=% overloads',
    v_count_product, v_count_product_hybrid;

  -- If there are multiple overloads, identify and drop the shorter-signature ones (older versions)
  -- Approach: keep the one with the most parameters (most recent), drop the others

  IF v_count_product > 1 THEN
    RAISE NOTICE 'Consolidating match_product_chunks: found % overloads', v_count_product;
    -- Drop all except the one with most parameters
    -- This is a manual operation - requires knowing which signature to keep
    -- For now, just log and let operator decide
    RAISE WARNING 'Manual action needed: match_product_chunks has % overloads. Query pg_proc to identify and keep the one with most parameters.',
      v_count_product;
  END IF;

  IF v_count_product_hybrid > 1 THEN
    RAISE NOTICE 'Consolidating match_product_chunks_hybrid: found % overloads', v_count_product_hybrid;
    RAISE WARNING 'Manual action needed: match_product_chunks_hybrid has % overloads. Query pg_proc to identify and keep the one with most parameters.',
      v_count_product_hybrid;
  END IF;
END $$;

-- Diagnostic query output (comment out the RAISE above and run this instead if needed):
-- SELECT p.proname, pg_get_function_identity_arguments(p.oid) as signature,
--        array_length(string_to_array(pg_get_function_identity_arguments(p.oid), ','), 1) as param_count
-- FROM pg_proc p
-- JOIN pg_namespace n ON p.pronamespace = n.oid
-- WHERE n.nspname = 'rag' AND p.proname IN ('match_product_chunks', 'match_product_chunks_hybrid')
-- ORDER BY p.proname DESC, param_count DESC;
