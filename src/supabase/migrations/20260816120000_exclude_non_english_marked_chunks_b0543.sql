-- B0-543: Restore retrieval-side filter excluding non-English label text.
--
-- rag.document.language_code = 'EN' (checked in every match_* RPC below) only ever
-- protects at the WHOLE-DOCUMENT level. Real label documents are frequently bilingual
-- (Betco labels commonly carry an English section plus a French-Canadian and/or Spanish
-- section for the same product) and are correctly tagged language_code = 'EN' overall,
-- but individual rag.document_chunk rows within them are 100% non-English text.
--
-- The label-to-markdown conversion step already marks these blocks with a literal,
-- self-describing sentinel -- e.g.:
--   > French label text (not for English RAG ingestion):
--   > Spanish label text (not for English RAG ingestion):
-- (confirmed live: 1,317 of 5,817 label chunks / ~22.6% carry this marker, e.g. chunk
-- b78b0e39-d6e1-4989-8d47-10af2136f144 is entirely
-- "COMBUSTIBLE EN EL AIRE... MANTENGA ESTE PRODUCTO FUERA DEL ALCANCE DE LOS NINOS.").
-- No code in this repo (chunking, pipeline, or retrieval) currently reads that marker --
-- the string does not appear anywhere in src/ -- so nothing has ever honored it and these
-- chunks are fully eligible to win a similarity match today, surfacing untranslated
-- French/Spanish safety text (first aid, precautions, hazard warnings) in English-scoped
-- Bex answers.
--
-- Fix: exclude any chunk_text containing that marker from the ANN and FTS candidate sets
-- in every match_* RPC search.ts calls. Body-only change (no new parameters), so
-- CREATE OR REPLACE is safe here -- signatures are unchanged. Does not touch stored
-- chunk_text/label content in any way (no data mutation), per the regulated-data rule.

-- 1) rag.match_corpus_chunks (scope: all/products/sds/efficacy via search.ts callMatchRpc)
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
      AND dc_ann.chunk_text NOT ILIKE '%not for English RAG ingestion%'
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

-- 2) rag.match_corpus_chunks_hybrid (same scope set, RRF hybrid variant; has a fast-path
--    branch for scope='all' with no product/line filter, plus a general params branch --
--    both build their own ann_candidates/fts_candidates CTEs, so both need the filter)
CREATE OR REPLACE FUNCTION rag.match_corpus_chunks_hybrid(query_embedding halfvec, query_text text, match_count integer DEFAULT NULL::integer, filter_product_line_key text DEFAULT NULL::text, filter_scope text DEFAULT 'all'::text, filter_section_type text DEFAULT NULL::text, filter_product_key text DEFAULT NULL::text)
 RETURNS TABLE(chunk_id uuid, chunk_key text, chunk_index integer, heading text, chunk_text text, section_path text[], section_type text, token_count integer, document_id uuid, document_key text, document_title text, entity_id uuid, product_key text, sku text, product_line_key text, source_pk text, document_kind text, similarity double precision)
 LANGUAGE plpgsql
 SET statement_timeout TO '60s'
 SET search_path TO 'rag', 'extensions', 'public'
AS $function$
DECLARE
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
    fts_candidates AS MATERIALIZED (
      SELECT dc_fts.id AS chunk_id,
             row_number() OVER (ORDER BY ts_rank_cd(dc_fts.search_vector, v_tsq) DESC) AS fts_rank
      FROM rag.document_chunk dc_fts
      WHERE v_tsq IS NOT NULL AND numnode(v_tsq) > 0
        AND dc_fts.search_vector @@ v_tsq
        AND dc_fts.chunk_text NOT ILIKE '%not for English RAG ingestion%'
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
    WHERE sr.is_active = true
      AND upper(coalesce(d.language_code, '')) = 'EN'
      AND (d.document_kind <> 'efficacy' OR d.lifecycle_status = 'active')
    ORDER BY f.rrf_score DESC
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
  fts_candidates AS MATERIALIZED (
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

-- 3) rag.match_product_chunks (scope: 'products' via search.ts callMatchRpc)
CREATE OR REPLACE FUNCTION rag.match_product_chunks(query_embedding halfvec, match_count integer DEFAULT 10, filter_product_key text DEFAULT NULL::text, filter_product_line_key text DEFAULT NULL::text, filter_section_type text DEFAULT NULL::text)
 RETURNS TABLE(chunk_id uuid, chunk_key text, chunk_index integer, heading text, chunk_text text, section_path text[], section_type text, token_count integer, document_id uuid, document_key text, document_title text, entity_id uuid, product_key text, sku text, product_line_key text, source_pk text, document_kind text, similarity double precision)
 LANGUAGE sql
 STABLE
 SET search_path TO 'rag', 'extensions', 'public'
 SET statement_timeout TO '120s'
AS $function$
  WITH params AS (
    SELECT
      greatest(coalesce(match_count, 10), 1) AS resolved_match_count,
      nullif(trim(filter_product_key), '') AS resolved_product_key,
      nullif(trim(filter_product_line_key), '') AS resolved_product_line_key,
      nullif(trim(filter_section_type), '') AS resolved_section_type,
      CASE
        WHEN nullif(trim(filter_product_key), '') IS NOT NULL
          OR nullif(trim(filter_product_line_key), '') IS NOT NULL
          THEN least(1500, greatest(50, greatest(coalesce(match_count, 10), 1) * 15))
        ELSE least(8000, greatest(200, greatest(coalesce(match_count, 10), 1) * 50))
      END AS resolved_candidate_limit
  ),
  eligible_documents AS MATERIALIZED (
    SELECT d.id AS document_id, d.document_key, d.title AS document_title,
           e.id AS entity_id, e.product_key, e.sku, e.product_line_key,
           sr.source_pk, d.document_kind
    FROM rag.document d
    JOIN rag.source_record sr ON sr.id = d.source_record_id
    LEFT JOIN rag.entity e ON e.id = d.entity_id
    CROSS JOIN params p
    WHERE d.document_kind = 'product_line_profile'
      AND d.language_code = 'EN'
      AND sr.is_active = true
      AND d.metadata @> '{"has_web_available_variant": true}'::jsonb
      AND (p.resolved_product_line_key IS NULL
           OR sr.source_pk = p.resolved_product_line_key
           OR e.product_line_key = p.resolved_product_line_key)
      AND (p.resolved_product_key IS NULL
           OR e.product_key = p.resolved_product_key
           OR d.metadata @> jsonb_build_object(
                'variant_product_keys', jsonb_build_array(p.resolved_product_key)))
  ),
  ann_candidates AS MATERIALIZED (
    SELECT dc_ann.id AS chunk_id
    FROM rag.document_chunk dc_ann
    JOIN eligible_documents ed ON ed.document_id = dc_ann.document_id
    CROSS JOIN params p
    WHERE dc_ann.embedding_large IS NOT NULL
      AND dc_ann.chunk_text NOT ILIKE '%not for English RAG ingestion%'
      AND (p.resolved_section_type IS NULL OR dc_ann.section_type = p.resolved_section_type)
    ORDER BY dc_ann.embedding_large <=> query_embedding
    LIMIT (SELECT resolved_candidate_limit FROM params)
  )
  SELECT
    dc.id AS chunk_id, dc.chunk_key, dc.chunk_index, dc.heading,
    dc.chunk_text, dc.section_path, dc.section_type, dc.token_count,
    ed.document_id, ed.document_key, ed.document_title,
    ed.entity_id, ed.product_key, ed.sku, ed.product_line_key,
    ed.source_pk, ed.document_kind,
    1 - (dc.embedding_large <=> query_embedding) AS similarity
  FROM ann_candidates ac
  JOIN rag.document_chunk dc ON dc.id = ac.chunk_id
  JOIN eligible_documents ed ON ed.document_id = dc.document_id
  ORDER BY dc.embedding_large <=> query_embedding
  LIMIT (SELECT resolved_match_count FROM params);
$function$;

-- 4) rag.match_product_chunks_hybrid (scope: 'products', RRF hybrid variant)
CREATE OR REPLACE FUNCTION rag.match_product_chunks_hybrid(query_embedding halfvec, query_text text, match_count integer DEFAULT NULL::integer, filter_product_key text DEFAULT NULL::text, filter_product_line_key text DEFAULT NULL::text, filter_section_type text DEFAULT NULL::text)
 RETURNS TABLE(chunk_id uuid, chunk_key text, chunk_index integer, heading text, chunk_text text, section_path text[], section_type text, token_count integer, document_id uuid, document_key text, document_title text, entity_id uuid, product_key text, sku text, product_line_key text, source_pk text, document_kind text, similarity double precision)
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '60s'
 SET search_path TO 'rag', 'extensions', 'public'
AS $function$
  WITH params AS (
    SELECT
      greatest(coalesce(match_count, 10), 1) AS resolved_match_count,
      nullif(trim(filter_product_key), '') AS resolved_product_key,
      nullif(trim(filter_product_line_key), '') AS resolved_product_line_key,
      nullif(trim(filter_section_type), '') AS resolved_section_type,
      CASE
        WHEN nullif(trim(coalesce(query_text, '')), '') IS NOT NULL
          THEN websearch_to_tsquery('english', trim(query_text))
        ELSE NULL
      END AS query_tsq,
      CASE
        WHEN nullif(trim(filter_product_key), '') IS NOT NULL
          OR nullif(trim(filter_product_line_key), '') IS NOT NULL
          THEN least(1500, greatest(50, greatest(coalesce(match_count, 10), 1) * 15))
        ELSE least(8000, greatest(200, greatest(coalesce(match_count, 10), 1) * 50))
      END AS resolved_ann_limit
  ),
  eligible_documents AS MATERIALIZED (
    SELECT d.id AS document_id, d.document_key, d.title AS document_title,
           e.id AS entity_id, e.product_key, e.sku, e.product_line_key,
           sr.source_pk, d.document_kind
    FROM rag.document d
    JOIN rag.source_record sr ON sr.id = d.source_record_id
    LEFT JOIN rag.entity e ON e.id = d.entity_id
    CROSS JOIN params p
    WHERE d.document_kind = 'product_line_profile'
      AND d.language_code = 'EN'
      AND sr.is_active = true
      AND d.metadata @> '{"has_web_available_variant": true}'::jsonb
      AND (p.resolved_product_line_key IS NULL
           OR sr.source_pk = p.resolved_product_line_key
           OR e.product_line_key = p.resolved_product_line_key)
      AND (p.resolved_product_key IS NULL
           OR e.product_key = p.resolved_product_key
           OR d.metadata @> jsonb_build_object(
                'variant_product_keys', jsonb_build_array(p.resolved_product_key)))
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
  fts_candidates AS MATERIALIZED (
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
$function$;
