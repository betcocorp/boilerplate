-- B0-281 — Drop the dead rag.match_product_chunks_v2 function.
--
-- Verified unused (2026-07-22): no application caller (repo-wide grep finds it only in the
-- generated types file src/types/supabase.rag.ts, which lists every DB routine); the live
-- retrieval path uses match_product_chunks / match_product_chunks_hybrid / match_corpus_chunks*.
-- IF EXISTS + no CASCADE: the drop is a no-op if already removed and will fail loudly (rather
-- than silently cascade) if an unexpected dependency exists.
--
-- Consolidating the remaining match_product_chunks / _hybrid overloads is intentionally NOT
-- done here — those are live and PostgREST overload resolution is order-sensitive (see the
-- note in src/lib/rag/search.ts). Tracked separately in B0-281.

DROP FUNCTION IF EXISTS rag.match_product_chunks_v2(halfvec, integer, text, text);
