-- B0-444 — Restore the B0-230/B0-235 efficacy lifecycle guard that
-- 20260724130000_add_filter_product_key_to_corpus_match.sql silently dropped.
--
-- WHAT REGRESSED
-- --------------
-- 20260722040000_extend_corpus_match_for_efficacy.sql (B0-230/235) added, to both
-- rag.match_corpus_chunks and rag.match_corpus_chunks_hybrid:
--   1) 'efficacy' to the resolved_scope allow-list (was 'all'/'products'/'sds' only),
--      plus a `resolved_scope = 'efficacy' AND d.document_kind = 'efficacy'` branch.
--   2) An unconditional `(d.document_kind <> 'efficacy' OR d.lifecycle_status = 'active')`
--      guard, applied regardless of scope, so a superseded/never_activated/unused
--      efficacy document never surfaces from default retrieval even under scope='all'.
-- 20260722060000_tune_match_corpus_ef_search_over_efficacy.sql preserved both.
-- 20260724130000_add_filter_product_key_to_corpus_match.sql (B0-250) then did a
-- DROP + CREATE to add `filter_product_key`, but rebuilt the body from a body that
-- predates 20260722040000 -- its allow-list reverted to ('all','products','sds') and
-- the lifecycle guard is entirely absent. Its own header claimed the bodies were
-- "byte-for-byte identical to the live functions (confirmed via pg_get_functiondef)"
-- outside the one added param -- that claim was false for this specific guard.
-- 20260808140000_fix_corpus_hybrid_ann_index_usage.sql rewrote match_corpus_chunks_hybrid
-- again for perf (split fast/filtered path) on top of the regressed body, and explicitly
-- flagged the dropped 'efficacy' allow-list entry in its SCOPE NOTES as a known gap
-- deferred to a follow-up ticket -- it did not know the lifecycle guard was also gone.
--
-- Verified live via pg_get_functiondef immediately before writing this migration:
-- neither function mentions lifecycle_status or 'efficacy' today. All 438 live
-- rag.document rows with document_kind='efficacy' currently have lifecycle_status
-- = 'active', so nothing has been served incorrectly yet -- but the control does
-- not exist, so the moment any efficacy document is marked non-active it would still
-- be retrievable. Only the guard/scope predicates are restored here; no regulated
-- value (log-reduction, contact time, dilution, EPA/DIN, etc.) is touched.
--
-- DECISION: 'efficacy' belongs in the resolved_scope/v_scope allow-list.
-- This is not a fresh judgment call -- it reverses an accidental drop, not a new
-- feature. Evidence:
--   * src/lib/rag/search.ts already declares `RpcScope = 'all' | 'products' | 'sds'
--     | 'efficacy'` and its `normalizeScope()` forwards 'efficacy' straight through
--     to the RPC's filter_scope argument -- application code already assumes the RPC
--     honors it (B0-230's comment: "mirrors sds").
--   * 20260808140000's own SCOPE NOTES call the missing allow-list entry a gap to
--     restore, not an intentional decision.
--   * rag.document.corpus_scope (betco_us/betco_ca/betco_uaca/other, B0-283) does not
--     exist on the live database at all (confirmed via information_schema.columns) --
--     the migration file for it is checked in but was never applied here, so there is
--     no live region-scoping concept to conflict with an efficacy-only retrieval scope.
--     Even where that migration's own logic runs, it only ever touches
--     document_kind IN ('sds','label'), so it is orthogonal to 'efficacy' regardless.
--
-- Both signatures are UNCHANGED from what's live today (confirmed via pg_get_functiondef
-- immediately before writing this file: match_corpus_chunks(halfvec, integer, text, text,
-- text, text); match_corpus_chunks_hybrid(halfvec, text, integer, text, text, text, text)),
-- so CREATE OR REPLACE is safe here -- no DROP + CREATE needed, no overload-drift risk.

CREATE OR REPLACE FUNCTION rag.match_corpus_chunks(query_embedding halfvec, match_count integer DEFAULT 10, filter_product_line_key text DEFAULT NULL::text, filter_scope text DEFAULT 'all'::text, filter_section_type text DEFAULT NULL::text, filter_product_key text DEFAULT NULL::text)
 RETURNS TABLE(chunk_id uuid, chunk_key text, chunk_index integer, heading text, chunk_text text, section_path text[], section_type text, token_count integer, document_id uuid, document_key text, document_title text, entity_id uuid, product_key text, sku text, product_line_key text, source_pk text, document_kind text, similarity double precision)
 LANGUAGE plpgsql
 SET search_path TO 'rag', 'extensions', 'public'
 SET statement_timeout TO '60s'
AS $function$
BEGIN
  SET LOCAL hnsw.ef_search = 300;
  RETURN QUERY
  WITH params AS (
    SELECT
      greatest(coalesce(match_count, 10), 1) AS resolved_match_count,
      nullif(trim(filter_product_line_key), '') AS resolved_product_line_key,
      nullif(trim(filter_section_type), '') AS resolved_section_type,
      nullif(trim(filter_product_key), '') AS resolved_product_key,
      CASE
        WHEN lower(trim(coalesce(filter_scope, 'all'))) IN ('all', 'products', 'sds', 'efficacy')
          THEN lower(trim(coalesce(filter_scope, 'all')))
        ELSE 'all'
      END AS resolved_scope,
      least(300, greatest(greatest(coalesce(match_count, 10), 1) * 20, 200)) AS resolved_candidate_limit
  ),
  ann_candidates AS MATERIALIZED (
    SELECT dc_ann.id AS chunk_id, dc_ann.document_id,
           dc_ann.embedding_large <=> query_embedding AS distance
    FROM rag.document_chunk dc_ann
    CROSS JOIN params p
    WHERE dc_ann.embedding_large IS NOT NULL
    ORDER BY dc_ann.embedding_large <=> query_embedding
    LIMIT (SELECT resolved_candidate_limit FROM params)
  )
  SELECT
    dc.id AS chunk_id, dc.chunk_key, dc.chunk_index, dc.heading,
    dc.chunk_text, dc.section_path, dc.section_type, dc.token_count,
    d.id AS document_id, d.document_key, d.title AS document_title,
    e.id AS entity_id, e.product_key, e.sku, e.product_line_key,
    sr.source_pk, d.document_kind,
    1 - ac.distance AS similarity
  FROM ann_candidates ac
  JOIN rag.document_chunk dc ON dc.id = ac.chunk_id
  JOIN rag.document d ON d.id = ac.document_id
  JOIN rag.source_record sr ON sr.id = d.source_record_id
  LEFT JOIN rag.entity e ON e.id = d.entity_id
  CROSS JOIN params p
  WHERE sr.is_active = true
    AND upper(coalesce(d.language_code, '')) = 'EN'
    AND (d.document_kind <> 'efficacy' OR d.lifecycle_status = 'active')
    AND (
      p.resolved_scope = 'all'
      OR (p.resolved_scope = 'products' AND d.document_kind = 'product_line_profile'
          AND d.metadata @> '{"has_web_available_variant": true}'::jsonb)
      OR (p.resolved_scope = 'sds' AND d.document_kind = 'sds')
      OR (p.resolved_scope = 'efficacy' AND d.document_kind = 'efficacy')
    )
    AND (p.resolved_product_line_key IS NULL
         OR sr.source_pk = p.resolved_product_line_key
         OR e.product_line_key = p.resolved_product_line_key)
    AND (p.resolved_product_key IS NULL
         OR e.product_key = p.resolved_product_key
         OR d.metadata @> jsonb_build_object('variant_product_keys', jsonb_build_array(p.resolved_product_key)))
    AND (p.resolved_section_type IS NULL OR dc.section_type = p.resolved_section_type)
  ORDER BY ac.distance
  LIMIT (SELECT resolved_match_count FROM params);
END;
$function$;

CREATE OR REPLACE FUNCTION rag.match_corpus_chunks_hybrid(
  query_embedding halfvec,
  query_text text,
  match_count integer DEFAULT NULL::integer,
  filter_product_line_key text DEFAULT NULL::text,
  filter_scope text DEFAULT 'all'::text,
  filter_section_type text DEFAULT NULL::text,
  filter_product_key text DEFAULT NULL::text
)
 RETURNS TABLE(chunk_id uuid, chunk_key text, chunk_index integer, heading text, chunk_text text, section_path text[], section_type text, token_count integer, document_id uuid, document_key text, document_title text, entity_id uuid, product_key text, sku text, product_line_key text, source_pk text, document_kind text, similarity double precision)
 LANGUAGE plpgsql
 SET statement_timeout TO '60s'
 SET search_path TO 'rag', 'extensions', 'public'
AS $function$
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
    WHEN lower(trim(coalesce(filter_scope, 'all'))) IN ('all', 'products', 'sds', 'efficacy')
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
  -- it is a filter on the index scan rather than a join above it. v_scope = 'all'
  -- is the only scope that reaches this branch (see v_scope CASE above), so the
  -- lifecycle guard here only ever excludes efficacy docs reachable via scope='all';
  -- scope='efficacy' always takes the filtered path below, where it's pre-filtered.
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
      AND (d.document_kind <> 'efficacy' OR d.lifecycle_status = 'active')
    ORDER BY f.rrf_score DESC
    LIMIT v_match_count;

    RETURN;
  END IF;

  -- ------------------------------------------------------------ filtered path
  -- A document-kind or entity restriction has to be applied BEFORE the ANN limit or
  -- the candidate pool is mostly non-matching rows (see the recall sampling in
  -- 20260808140000's header). These calls are already fast (129-691ms scoped) because
  -- `eligible_documents` is small. scope='efficacy' always lands here, pre-filtered
  -- to document_kind='efficacy' AND lifecycle_status='active' before the ANN scan.
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
      AND (d.document_kind <> 'efficacy' OR d.lifecycle_status = 'active')
      AND (
        p.resolved_scope = 'all'
        OR (p.resolved_scope = 'products' AND d.document_kind = 'product_line_profile'
            AND d.metadata @> '{"has_web_available_variant": true}'::jsonb)
        OR (p.resolved_scope = 'sds' AND d.document_kind = 'sds')
        OR (p.resolved_scope = 'efficacy' AND d.document_kind = 'efficacy')
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

-- Signatures are unchanged (CREATE OR REPLACE above genuinely replaces in place), but
-- grants are re-issued for idempotency/parity with prior migrations on these functions.
GRANT EXECUTE ON FUNCTION rag.match_corpus_chunks(halfvec, integer, text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION rag.match_corpus_chunks_hybrid(halfvec, text, integer, text, text, text, text) TO service_role;
