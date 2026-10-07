-- B0-975 — hybrid retrieval hygiene: OR-relaxed lexical fallback in rag.match_corpus_chunks_hybrid.
--
-- The FTS leg built `websearch_to_tsquery('english', query_text)`, which ANDs every lexeme. For a
-- question-shaped query that is effectively inert: measured 2026-09-14, the AND form matched ZERO
-- chunks corpus-wide for 8 of 12 golden query variants ("how soon can people walk on the VCT floor
-- after the last coat?" → 'soon' & 'peopl' & 'walk' & 'vct' & 'floor' & 'last' & 'coat' → 0 rows),
-- so RRF fusion degenerated to the ANN leg alone. The OR-relaxed form of the same question matches
-- 3,333 chunks, and ts_rank_cd over an OR query still ranks chunks matching MORE of the terms first.
--
-- Change (body only — the signature, return type and every parameter default are byte-identical,
-- so CREATE OR REPLACE is safe here; adding/removing a parameter would require DROP + CREATE, see
-- 20260826034509_add_surface_type_boost_to_match_rpcs_b0686.sql):
--   * `and_leg`  — the existing AND tsquery, top 200 by ts_rank_cd (unchanged semantics).
--   * `or_leg`   — `plainto_tsquery` over the same text with every `&` relaxed to `|`, top 200 by
--                  ts_rank_cd, evaluated ONLY when `and_leg` is empty (NOT EXISTS), so a query the
--                  AND form already answers keeps exactly today's lexical candidates.
--   * `fts_candidates` = and_leg ∪ or_leg, each row tagged with a `leg_weight`: 1.0 for the AND leg
--     (so RRF for every query the AND form already answers is arithmetically identical to before)
--     and 0.5 for the OR leg. An OR hit is weaker evidence: replayed unweighted, the OR leg put
--     StreetShoe label chunks (cosine 0.47, lexically dense on floor/coat/walk) at ranks 1-4 for
--     "how soon can people walk on the VCT floor after the last coat?" and pushed "VCT Reopening
--     to Traffic" (cosine 0.659, ANN rank 1) to rank 5. At 0.5 a lexical-only OR hit lands around
--     ANN rank 60 — inside the over-fetched candidate pool, never above the ANN leader.
--     The ANN leg, the eligibility predicate, the metadata boost and the ORDER BY are untouched.
--
-- SAFETY INVARIANTS (unchanged from B0-686):
--   1. `similarity` stays the raw cosine `1 - distance`, and is deliberately NULL for a chunk with
--      no embedding that only the lexical leg returned — the TypeScript side (`~/lib/rag/search.ts`,
--      `partitionLexicalOnlyMatches`) now excludes and COUNTS those instead of coercing NULL to 0.
--   2. The ANN CTE keeps ordering by raw distance; the boost only re-orders the fused pool.

CREATE OR REPLACE FUNCTION rag.match_corpus_chunks_hybrid(
  query_embedding halfvec,
  query_text text,
  match_count integer DEFAULT NULL::integer,
  filter_product_line_key text DEFAULT NULL::text,
  filter_scope text DEFAULT 'all'::text,
  filter_section_type text DEFAULT NULL::text,
  filter_product_key text DEFAULT NULL::text,
  filter_surface_type text DEFAULT NULL::text
)
RETURNS TABLE(
  chunk_id uuid, chunk_key text, chunk_index integer, heading text, chunk_text text,
  section_path text[], section_type text, token_count integer, document_id uuid,
  document_key text, document_title text, entity_id uuid, product_key text, sku text,
  product_line_key text, source_pk text, document_kind text, similarity double precision
)
LANGUAGE plpgsql
SET statement_timeout TO '60s'
SET search_path TO 'rag', 'extensions', 'public'
AS $function$
DECLARE
  v_match_count   integer := greatest(coalesce(match_count, 10), 1);
  v_line_key      text    := nullif(trim(filter_product_line_key), '');
  v_product_key   text    := nullif(trim(filter_product_key), '');
  v_section_type  text    := nullif(trim(filter_section_type), '');
  v_surface_type  text    := nullif(trim(filter_surface_type), '');
  v_boost_weights jsonb   := rag.resolve_boost_weights();
  v_scope         text;
  v_tsq           tsquery;
  v_tsq_or        tsquery;
  v_plain_tsq     tsquery;
  v_ann_limit     integer;
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

  -- B0-975 — OR-relaxed form of the same text. plainto_tsquery yields `'a' & 'b' & 'c'`
  -- (phrase operators `<->` for hyphenated words are kept); relaxing every top-level `&` to `|`
  -- turns it into "any of these lexemes", and ts_rank_cd then favours chunks hitting several.
  v_plain_tsq := CASE
    WHEN nullif(trim(coalesce(query_text, '')), '') IS NOT NULL
      THEN plainto_tsquery('english', trim(query_text))
    ELSE NULL
  END;
  v_tsq_or := CASE
    WHEN v_plain_tsq IS NOT NULL AND numnode(v_plain_tsq) > 0
      THEN replace(v_plain_tsq::text, ' & ', ' | ')::tsquery
    ELSE NULL
  END;

  v_ann_limit := least(300, greatest(v_match_count * 20, 200));

  IF v_scope = 'all' AND v_line_key IS NULL AND v_product_key IS NULL THEN
    RETURN QUERY
    WITH ann_candidates AS MATERIALIZED (
      SELECT dc_ann.id AS chunk_id,
             dc_ann.embedding_large <=> query_embedding AS distance
      FROM rag.document_chunk dc_ann
      WHERE dc_ann.embedding_large IS NOT NULL
        AND dc_ann.chunk_text NOT ILIKE '%not for English RAG ingestion%'
        AND (v_section_type IS NULL OR dc_ann.section_type = v_section_type)
      ORDER BY dc_ann.embedding_large <=> query_embedding
      LIMIT v_ann_limit
    ),
    ann_ranked AS (
      SELECT ac.chunk_id,
             row_number() OVER (ORDER BY ac.distance) AS ann_rank
      FROM ann_candidates ac
    ),
    and_leg AS MATERIALIZED (
      SELECT dc_fts.id AS chunk_id,
             row_number() OVER (ORDER BY ts_rank_cd(dc_fts.search_vector, v_tsq) DESC) AS fts_rank
      FROM rag.document_chunk dc_fts
      WHERE v_tsq IS NOT NULL AND numnode(v_tsq) > 0
        AND dc_fts.search_vector @@ v_tsq
        AND dc_fts.chunk_text NOT ILIKE '%not for English RAG ingestion%'
        AND (v_section_type IS NULL OR dc_fts.section_type = v_section_type)
      LIMIT 200
    ),
    or_leg AS MATERIALIZED (
      SELECT dc_or.id AS chunk_id,
             row_number() OVER (ORDER BY ts_rank_cd(dc_or.search_vector, v_tsq_or) DESC) AS fts_rank
      FROM rag.document_chunk dc_or
      WHERE NOT EXISTS (SELECT 1 FROM and_leg)
        AND v_tsq_or IS NOT NULL AND numnode(v_tsq_or) > 0
        AND dc_or.search_vector @@ v_tsq_or
        AND dc_or.chunk_text NOT ILIKE '%not for English RAG ingestion%'
        AND (v_section_type IS NULL OR dc_or.section_type = v_section_type)
      LIMIT 200
    ),
    fts_candidates AS MATERIALIZED (
      SELECT al.chunk_id, al.fts_rank, 1.0::numeric AS leg_weight FROM and_leg al
      UNION ALL
      SELECT ol.chunk_id, ol.fts_rank, 0.5::numeric AS leg_weight FROM or_leg ol
    ),
    fused AS (
      SELECT coalesce(ann.chunk_id, fts.chunk_id) AS chunk_id,
             1.0 / (60.0 + coalesce(ann.ann_rank, 1000)) +
             coalesce(fts.leg_weight, 1.0) / (60.0 + coalesce(fts.fts_rank, 1000)) AS rrf_score
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
    WHERE sr.is_active = true
      AND upper(coalesce(d.language_code, '')) = 'EN'
      AND (d.document_kind <> 'efficacy' OR d.lifecycle_status = 'active')
    ORDER BY (f.rrf_score + rag.chunk_metadata_boost(dc.metadata, v_surface_type, v_boost_weights)::numeric) DESC
    LIMIT v_match_count;

    RETURN;
  END IF;

  RETURN QUERY
  WITH params AS (
    SELECT
      v_match_count AS resolved_match_count,
      v_line_key AS resolved_product_line_key,
      v_section_type AS resolved_section_type,
      v_product_key AS resolved_product_key,
      v_scope AS resolved_scope,
      v_tsq AS query_tsq,
      v_tsq_or AS query_tsq_or,
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
      AND dc.chunk_text NOT ILIKE '%not for English RAG ingestion%'
      AND (p.resolved_section_type IS NULL OR dc.section_type = p.resolved_section_type)
    ORDER BY dc.embedding_large <=> query_embedding
    LIMIT (SELECT resolved_ann_limit FROM params)
  ),
  and_leg AS MATERIALIZED (
    SELECT dc.id AS chunk_id,
           row_number() OVER (ORDER BY ts_rank_cd(dc.search_vector, p.query_tsq) DESC) AS fts_rank
    FROM rag.document_chunk dc
    JOIN eligible_documents ed ON ed.document_id = dc.document_id
    CROSS JOIN params p
    WHERE p.query_tsq IS NOT NULL AND numnode(p.query_tsq) > 0
      AND dc.search_vector @@ p.query_tsq
      AND dc.chunk_text NOT ILIKE '%not for English RAG ingestion%'
      AND (p.resolved_section_type IS NULL OR dc.section_type = p.resolved_section_type)
    LIMIT 200
  ),
  or_leg AS MATERIALIZED (
    SELECT dc.id AS chunk_id,
           row_number() OVER (ORDER BY ts_rank_cd(dc.search_vector, p.query_tsq_or) DESC) AS fts_rank
    FROM rag.document_chunk dc
    JOIN eligible_documents ed ON ed.document_id = dc.document_id
    CROSS JOIN params p
    WHERE NOT EXISTS (SELECT 1 FROM and_leg)
      AND p.query_tsq_or IS NOT NULL AND numnode(p.query_tsq_or) > 0
      AND dc.search_vector @@ p.query_tsq_or
      AND dc.chunk_text NOT ILIKE '%not for English RAG ingestion%'
      AND (p.resolved_section_type IS NULL OR dc.section_type = p.resolved_section_type)
    LIMIT 200
  ),
  fts_candidates AS MATERIALIZED (
    SELECT al.chunk_id, al.fts_rank, 1.0::numeric AS leg_weight FROM and_leg al
    UNION ALL
    SELECT ol.chunk_id, ol.fts_rank, 0.5::numeric AS leg_weight FROM or_leg ol
  ),
  fused AS (
    SELECT coalesce(ann.chunk_id, fts.chunk_id) AS chunk_id,
           1.0 / (60.0 + coalesce(ann.ann_rank, 1000)) +
           coalesce(fts.leg_weight, 1.0) / (60.0 + coalesce(fts.fts_rank, 1000)) AS rrf_score
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
  ORDER BY (f.rrf_score + rag.chunk_metadata_boost(dc.metadata, v_surface_type, v_boost_weights)::numeric) DESC
  LIMIT (SELECT resolved_match_count FROM params);
END;
$function$;
