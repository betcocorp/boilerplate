-- ============================================================
-- 20260602120000_fix_match_corpus_chunks_overloads.sql
--
-- Drops the 4-arg overload of match_corpus_chunks and the
-- 5-arg overload of match_corpus_chunks_hybrid (both lack the
-- filter_section_type parameter).
--
-- Root cause of the error:
--   All parameters on both overloads have DEFAULT values, so
--   when the Supabase JS client sends a named-parameter call
--   without filter_section_type, PostgreSQL finds two matching
--   candidates and throws:
--     "could not choose the best candidate function"
--
-- Fix: eliminate the old overloads. The remaining 5-arg /
-- 6-arg versions already declare filter_section_type DEFAULT
-- NULL, so callers that omit it get identical behaviour to the
-- old overloads — just a single candidate now.
-- ============================================================

-- Drop the overload WITHOUT filter_section_type
DROP FUNCTION IF EXISTS rag.match_corpus_chunks(
  extensions.halfvec,
  integer,
  text,
  text
);

DROP FUNCTION IF EXISTS rag.match_corpus_chunks_hybrid(
  extensions.halfvec,
  text,
  integer,
  text,
  text
);
