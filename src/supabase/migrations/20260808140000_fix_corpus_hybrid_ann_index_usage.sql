-- ============================================================================
-- 20260808140000_fix_corpus_hybrid_ann_index_usage.sql
--
-- Perf: make the ANN half of rag.match_corpus_chunks_hybrid use the HNSW index
-- on the unscoped (scope='all', no entity anchor) path.
--
-- PROBLEM
-- -------
-- The body created in 20260724130000_add_filter_product_key_to_corpus_match.sql
-- builds its ANN candidate pool like this:
--
--   ann_candidates AS MATERIALIZED (
--     SELECT dc.id, row_number() OVER (ORDER BY dc.embedding_large <=> query_embedding)
--     FROM rag.document_chunk dc
--     JOIN eligible_documents ed ON ed.document_id = dc.document_id   -- <-- here
--     ...
--     ORDER BY dc.embedding_large <=> query_embedding
--     LIMIT ...
--   )
--
-- An HNSW index scan has to be the node that produces the ordering, on the base
-- relation. Joining `document_chunk` to the materialized `eligible_documents`
-- CTE before the ORDER BY puts a join above it, so the index is unusable and
-- Postgres full-scans every embedded chunk, computing a 3072-dim halfvec cosine
-- distance per row, then top-N sorts.
--
-- Measured on the live corpus (28,937 embedded chunks, 5,954 documents), same
-- query embedding, match_count=50:
--
--   rag.match_corpus_chunks        (ANN CTE on the bare table)   128 / 135 ms
--   rag.match_corpus_chunks_hybrid (unscoped)          19,213 / 16,842 / 13,970 ms
--   rag.match_corpus_chunks_hybrid (product-line scoped)     691 / 129 ms
--   rag.match_corpus_chunks_hybrid (empty query_text)          13,595 ms
--
-- The empty-query_text run rules out BM25: the FTS half costs ~0.4-5s, the ANN
-- half costs the rest. The product-line-scoped run is fast only because
-- `eligible_documents` collapses to a handful of rows, so the full scan is over
-- a tiny set.
--
-- This is the dominant term in real traffic. `rag.search_embedding`'s persisted
-- averages show unscoped queries at 40-70s under concurrent load (e.g.
-- 'PUSH SDS': avg_similarity_search_ms = 70,805 over 6 samples -- above this
-- function's own 60s statement_timeout), while entity-anchored ones sit at
-- 90-400ms. 20260715200000 already noted the ~8.7s runtime and deferred it as
-- "tuning work"; this is that work.
--
-- FIX
-- ---
-- Split into two plans, chosen by whether a DOCUMENT-level restriction is active:
--
--   * No restriction (scope='all', no filter_product_line_key, no
--     filter_product_key) -- the fast path. Take the ANN top-K from the bare
--     `rag.document_chunk` (index scan), then apply eligibility in the final
--     join. This mirrors rag.match_corpus_chunks, which is already live and
--     measures 128ms with the identical candidate limit.
--
--   * Restriction active -- unchanged. Body kept byte-for-byte from
--     20260724130000 so nothing about the already-fast scoped plan moves.
--
-- WHY POST-FILTER IS SAFE ON THE FAST PATH, AND ONLY THERE
-- -------------------------------------------------------
-- Post-filtering a global top-K only preserves recall when the filter drops
-- (almost) nothing. Verified against the live corpus:
--
--   * Eligibility (sr.is_active AND language_code='EN') currently excludes
--     ZERO embedded chunks: all 28,937 sit on EN documents with an active
--     source_record. The 1,718 documents on inactive source records have no
--     chunks at all. So on the fast path the join was pure overhead.
--   * A document-kind or product-line filter is NOT safe to post-filter, and
--     that is why those keep the pre-filtering plan. Sampling the global ANN
--     top-300 for five representative queries: SDS chunks appeared 0-10 times
--     out of 300, and the single best-matching product line appeared 3-25 times
--     across 28-81 distinct lines. Post-filtering those would return a handful
--     of rows instead of the requested 50.
--
-- Headroom on the fast path: the candidate pool stays at
-- least(300, greatest(match_count*20, 200)), i.e. 300 for the app's
-- match_count=50, so eligibility would have to start excluding >83% of the
-- corpus before a full page of results could not be filled.
--
-- SCOPE NOTES
-- -----------
--   * Every production caller of this function uses scope='all' (see
--     src/lib/retrieval/product-knowledge.ts and src/lib/tests/search-run-executor.ts;
--     scope='products' routes to match_product_chunks_hybrid instead, measured
--     273-977ms, untouched here). scope='sds' has no production caller today and
--     keeps the pre-filtering plan (measured 7.5-10.9s) -- fixing it needs
--     document_kind denormalized onto document_chunk plus per-kind partial HNSW
--     indexes, which is a separate, larger change.
--   * Ranking semantics are deliberately unchanged: same candidate limits, same
--     RRF constants (k=60, absent rank = 1000), same `fts_candidates` LIMIT 200
--     without a correlated ORDER BY. That last one is a pre-existing quirk (which
--     200 rows survive is arbitrary when more than 200 match the tsquery); it is
--     left alone here because changing it would move retrieval results and needs
--     its own eval run.
--   * Also unchanged, and worth a follow-up ticket: `resolved_scope` still
--     whitelists only ('all','products','sds'), so filter_scope='efficacy' --
--     added by 20260722040000 -- is silently clamped to 'all'. Restoring it
--     changes retrieval behaviour, so it is not folded into a perf migration.
--
-- Signature is identical to the live function, so CREATE OR REPLACE genuinely
-- replaces it (no new overload, and the existing grant is preserved). The grant
-- is re-issued below anyway for idempotency.
-- ============================================================================

create or replace function rag.match_corpus_chunks_hybrid(
  query_embedding halfvec,
  query_text text,
  match_count integer default null::integer,
  filter_product_line_key text default null::text,
  filter_scope text default 'all'::text,
  filter_section_type text default null::text,
  filter_product_key text default null::text
)
returns table(chunk_id uuid, chunk_key text, chunk_index integer, heading text, chunk_text text, section_path text[], section_type text, token_count integer, document_id uuid, document_key text, document_title text, entity_id uuid, product_key text, sku text, product_line_key text, source_pk text, document_kind text, similarity double precision)
language plpgsql
set statement_timeout to '60s'
set search_path to 'rag', 'extensions', 'public'
as $function$
DECLARE
  -- v_ prefix throughout: `chunk_id`, `section_type`, `product_key`, ... are OUT
  -- parameter names, and an unprefixed local would make every reference ambiguous.
  v_match_count  integer := greatest(coalesce(match_count, 10), 1);
  v_line_key     text    := nullif(trim(filter_product_line_key), '');
  v_product_key  text    := nullif(trim(filter_product_key), '');
  v_section_type text    := nullif(trim(filter_section_type), '');
  v_scope        text;
  v_tsq          tsquery;
  v_ann_limit    integer;
BEGIN
  SET LOCAL hnsw.ef_search = 300;

  v_scope := CASE
    WHEN lower(trim(coalesce(filter_scope, 'all'))) IN ('all', 'products', 'sds')
      THEN lower(trim(coalesce(filter_scope, 'all')))
    ELSE 'all'
  END;

  v_tsq := CASE
    WHEN nullif(trim(coalesce(query_text, '')), '') IS NOT NULL
      THEN websearch_to_tsquery('english', trim(query_text))
    ELSE NULL
  END;

  -- Candidate pool size, identical to the previous body. Kept at or below
  -- hnsw.ef_search: asking the index for more rows than ef_search degrades recall.
  v_ann_limit := least(300, greatest(v_match_count * 20, 200));

  -- ---------------------------------------------------------------- fast path
  -- No document-level restriction, so eligibility can be applied after the ANN
  -- top-K instead of before it, which is what lets the HNSW index do the ordering.
  -- `filter_section_type` stays in the ANN scan: it is a document_chunk column, so
  -- it is a filter on the index scan rather than a join above it.
  IF v_scope = 'all' AND v_line_key IS NULL AND v_product_key IS NULL THEN
    RETURN QUERY
    WITH ann_candidates AS MATERIALIZED (
      SELECT dc_ann.id AS chunk_id,
             dc_ann.embedding_large <=> query_embedding AS distance
      FROM rag.document_chunk dc_ann
      WHERE dc_ann.embedding_large IS NOT NULL
        AND (v_section_type IS NULL OR dc_ann.section_type = v_section_type)
      ORDER BY dc_ann.embedding_large <=> query_embedding
      LIMIT v_ann_limit
    ),
    -- Ranked in a second step, over the (at most 300) materialized candidates,
    -- so no window function sits between the index scan and its LIMIT.
    ann_ranked AS (
      SELECT ac.chunk_id,
             row_number() OVER (ORDER BY ac.distance) AS ann_rank
      FROM ann_candidates ac
    ),
    fts_candidates AS MATERIALIZED (
      SELECT dc_fts.id AS chunk_id,
             row_number() OVER (ORDER BY ts_rank_cd(dc_fts.search_vector, v_tsq) DESC) AS fts_rank
      FROM rag.document_chunk dc_fts
      WHERE v_tsq IS NOT NULL AND numnode(v_tsq) > 0
        AND dc_fts.search_vector @@ v_tsq
        AND (v_section_type IS NULL OR dc_fts.section_type = v_section_type)
      LIMIT 200
    ),
    fused AS (
      SELECT coalesce(ann.chunk_id, fts.chunk_id) AS chunk_id,
             1.0 / (60.0 + coalesce(ann.ann_rank, 1000)) +
             1.0 / (60.0 + coalesce(fts.fts_rank, 1000)) AS rrf_score
      FROM ann_ranked ann
      FULL OUTER JOIN fts_candidates fts ON fts.chunk_id = ann.chunk_id
    )
    SELECT
      dc.id AS chunk_id, dc.chunk_key, dc.chunk_index, dc.heading,
      dc.chunk_text, dc.section_path, dc.section_type, dc.token_count,
      d.id AS document_id, d.document_key, d.title AS document_title,
      e.id AS entity_id, e.product_key, e.sku, e.product_line_key,
      sr.source_pk, d.document_kind,
      (1.0 - (dc.embedding_large <=> query_embedding))::float AS similarity
    FROM fused f
    JOIN rag.document_chunk dc ON dc.id = f.chunk_id
    JOIN rag.document d ON d.id = dc.document_id
    JOIN rag.source_record sr ON sr.id = d.source_record_id
    LEFT JOIN rag.entity e ON e.id = d.entity_id
    -- Same eligibility predicate the pre-filtering plan applies, just applied last.
    WHERE sr.is_active = true
      AND upper(coalesce(d.language_code, '')) = 'EN'
    ORDER BY f.rrf_score DESC
    LIMIT v_match_count;

    RETURN;
  END IF;

  -- ------------------------------------------------------------ filtered path
  -- Query shape below `params` is unchanged from 20260724130000 -- only the source
  -- of the params row moved to the locals above, which resolve identically. A
  -- document-kind or entity restriction has to be applied BEFORE the ANN limit or
  -- the candidate pool is mostly non-matching rows (see the recall sampling in the
  -- header). These calls are already fast (129-691ms scoped) because
  -- `eligible_documents` is small.
  RETURN QUERY
  WITH params AS (
    SELECT
      v_match_count AS resolved_match_count,
      v_line_key AS resolved_product_line_key,
      v_section_type AS resolved_section_type,
      v_product_key AS resolved_product_key,
      v_scope AS resolved_scope,
      v_tsq AS query_tsq,
      v_ann_limit AS resolved_ann_limit
  ),
  eligible_documents AS MATERIALIZED (
    SELECT d.id AS document_id, d.document_key, d.title AS document_title,
           e.id AS entity_id, e.product_key, e.sku, e.product_line_key,
           sr.source_pk, d.document_kind
    FROM rag.document d
    JOIN rag.source_record sr ON sr.id = d.source_record_id
    LEFT JOIN rag.entity e ON e.id = d.entity_id
    CROSS JOIN params p
    WHERE sr.is_active = true
      AND upper(coalesce(d.language_code, '')) = 'EN'
      AND (
        p.resolved_scope = 'all'
        OR (p.resolved_scope = 'products' AND d.document_kind = 'product_line_profile'
            AND d.metadata @> '{"has_web_available_variant": true}'::jsonb)
        OR (p.resolved_scope = 'sds' AND d.document_kind = 'sds')
      )
      AND (p.resolved_product_line_key IS NULL
           OR sr.source_pk = p.resolved_product_line_key
           OR e.product_line_key = p.resolved_product_line_key)
      AND (p.resolved_product_key IS NULL
           OR e.product_key = p.resolved_product_key
           OR d.metadata @> jsonb_build_object('variant_product_keys', jsonb_build_array(p.resolved_product_key)))
  ),
  ann_candidates AS MATERIALIZED (
    SELECT dc.id AS chunk_id,
           row_number() OVER (ORDER BY dc.embedding_large <=> query_embedding) AS ann_rank
    FROM rag.document_chunk dc
    JOIN eligible_documents ed ON ed.document_id = dc.document_id
    CROSS JOIN params p
    WHERE dc.embedding_large IS NOT NULL
      AND (p.resolved_section_type IS NULL OR dc.section_type = p.resolved_section_type)
    ORDER BY dc.embedding_large <=> query_embedding
    LIMIT (SELECT resolved_ann_limit FROM params)
  ),
  fts_candidates AS MATERIALIZED (
    SELECT dc.id AS chunk_id,
           row_number() OVER (ORDER BY ts_rank_cd(dc.search_vector, p.query_tsq) DESC) AS fts_rank
    FROM rag.document_chunk dc
    JOIN eligible_documents ed ON ed.document_id = dc.document_id
    CROSS JOIN params p
    WHERE p.query_tsq IS NOT NULL AND numnode(p.query_tsq) > 0
      AND dc.search_vector @@ p.query_tsq
      AND (p.resolved_section_type IS NULL OR dc.section_type = p.resolved_section_type)
    LIMIT 200
  ),
  fused AS (
    SELECT coalesce(ann.chunk_id, fts.chunk_id) AS chunk_id,
           1.0 / (60.0 + coalesce(ann.ann_rank, 1000)) +
           1.0 / (60.0 + coalesce(fts.fts_rank, 1000)) AS rrf_score
    FROM ann_candidates ann
    FULL OUTER JOIN fts_candidates fts ON fts.chunk_id = ann.chunk_id
  )
  SELECT
    dc.id AS chunk_id, dc.chunk_key, dc.chunk_index, dc.heading,
    dc.chunk_text, dc.section_path, dc.section_type, dc.token_count,
    ed.document_id, ed.document_key, ed.document_title,
    ed.entity_id, ed.product_key, ed.sku, ed.product_line_key,
    ed.source_pk, ed.document_kind,
    (1.0 - (dc.embedding_large <=> query_embedding))::float AS similarity
  FROM fused f
  JOIN rag.document_chunk dc ON dc.id = f.chunk_id
  JOIN eligible_documents ed ON ed.document_id = dc.document_id
  ORDER BY f.rrf_score DESC
  LIMIT (SELECT resolved_match_count FROM params);
END;
$function$;

grant execute on function rag.match_corpus_chunks_hybrid(halfvec, text, integer, text, text, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- Verification: exactly one overload survives (same guard as 20260725090000),
-- then a live smoke test of both plans using a real embedding off the corpus.
-- Fails the migration if the rewrite returns nothing; otherwise reports latency.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_overloads integer;
  v_emb extensions.halfvec;
  v_line text;
  v_rows integer;
  v_started timestamptz;
  v_unscoped_ms numeric;
  v_scoped_ms numeric;
BEGIN
  SELECT count(*) INTO v_overloads
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'rag' AND p.proname = 'match_corpus_chunks_hybrid';

  IF v_overloads <> 1 THEN
    RAISE EXCEPTION 'Expected exactly 1 rag.match_corpus_chunks_hybrid overload, found %', v_overloads;
  END IF;

  SELECT dc.embedding_large INTO v_emb
  FROM rag.document_chunk dc
  WHERE dc.embedding_large IS NOT NULL
  LIMIT 1;

  IF v_emb IS NULL THEN
    RAISE NOTICE 'No embedded chunks present; skipping the smoke test.';
    RETURN;
  END IF;

  -- Fast path (scope='all', no entity anchor) -- the plan this migration changes.
  v_started := clock_timestamp();
  SELECT count(*) INTO v_rows
  FROM rag.match_corpus_chunks_hybrid(v_emb, 'disinfectant contact time', 50, NULL, 'all', NULL, NULL);
  v_unscoped_ms := round(extract(epoch FROM (clock_timestamp() - v_started)) * 1000);

  IF v_rows = 0 THEN
    RAISE EXCEPTION 'Unscoped match_corpus_chunks_hybrid returned 0 rows after the rewrite';
  END IF;
  RAISE NOTICE 'Unscoped hybrid: % rows in % ms (was 14,000-19,000 ms)', v_rows, v_unscoped_ms;

  -- Filtered path -- untouched body, asserted here so a regression is visible.
  SELECT e.product_line_key INTO v_line
  FROM rag.entity e
  WHERE e.product_line_key IS NOT NULL
  LIMIT 1;

  IF v_line IS NOT NULL THEN
    v_started := clock_timestamp();
    SELECT count(*) INTO v_rows
    FROM rag.match_corpus_chunks_hybrid(v_emb, 'disinfectant contact time', 50, v_line, 'all', NULL, NULL);
    v_scoped_ms := round(extract(epoch FROM (clock_timestamp() - v_started)) * 1000);
    RAISE NOTICE 'Line-scoped hybrid: % rows in % ms (unchanged plan)', v_rows, v_scoped_ms;
  END IF;
END $$;
