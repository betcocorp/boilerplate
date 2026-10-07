-- B0-230 / B0-235 — Add a native 'efficacy' scope to the corpus match RPCs, and
-- exclude non-active-lifecycle efficacy documents (never_activated / unused /
-- superseded — see B0-233's rag.document.lifecycle_status) from DEFAULT retrieval
-- (every scope, not just 'efficacy' — a broad scope='all' Bex query must not surface
-- a dead-end formulation either).
--
-- Per the convention documented in 20260722000000_corpus_scope_knowledge_label_followup.sql,
-- the live bodies of these two functions have drifted from their original migrations
-- (dumped via pg_get_functiondef immediately before this edit), so this file
-- reproduces the full live body with only the two targeted additions below, rather
-- than recreating from a stale checked-in version:
--   1) 'efficacy' added to the resolved_scope allow-list + document_kind predicate.
--   2) a document_kind <> 'efficacy' OR lifecycle_status = 'active' guard, applied
--      unconditionally (independent of resolved_scope).
-- History remains addressable: this only changes the *default* similarity-search
-- path. Direct by-id lookups (e.g. src/app/api/rag/document-chunk/route.ts) and any
-- future explicit "what changed between versions" admin path are untouched.
--
-- After applying, regenerate types: pnpm run types:supabase:rag (no signature change,
-- so this is optional, but kept for parity with the project convention).

CREATE OR REPLACE FUNCTION rag.match_corpus_chunks(query_embedding halfvec, match_count integer DEFAULT 10, filter_product_line_key text DEFAULT NULL::text, filter_scope text DEFAULT 'all'::text, filter_section_type text DEFAULT NULL::text)
 RETURNS TABLE(chunk_id uuid, chunk_key text, chunk_index integer, heading text, chunk_text text, section_path text[], section_type text, token_count integer, document_id uuid, document_key text, document_title text, entity_id uuid, product_key text, sku text, product_line_key text, source_pk text, document_kind text, similarity double precision)
 LANGUAGE sql
 STABLE
 SET search_path TO 'rag', 'extensions', 'public'
 SET statement_timeout TO '60s'
AS $function$
  WITH params AS (
    SELECT
      greatest(coalesce(match_count, 10), 1) AS resolved_match_count,
      nullif(trim(filter_product_line_key), '') AS resolved_product_line_key,
      nullif(trim(filter_section_type), '') AS resolved_section_type,
      CASE
        WHEN lower(trim(coalesce(filter_scope, 'all'))) IN ('all', 'products', 'sds', 'efficacy')
          THEN lower(trim(coalesce(filter_scope, 'all')))
        ELSE 'all'
      END AS resolved_scope,
      CASE
        WHEN lower(trim(coalesce(filter_scope, 'all'))) = 'products'
          AND nullif(trim(filter_product_line_key), '') IS NOT NULL
          THEN least(3000, greatest(150, greatest(coalesce(match_count, 10), 1) * 40))
        WHEN lower(trim(coalesce(filter_scope, 'all'))) = 'products'
          THEN least(7000, greatest(300, greatest(coalesce(match_count, 10), 1) * 80))
        WHEN lower(trim(coalesce(filter_scope, 'all'))) = 'sds'
          THEN least(5000, greatest(250, greatest(coalesce(match_count, 10), 1) * 70))
        WHEN lower(trim(coalesce(filter_scope, 'all'))) = 'efficacy'
          THEN least(5000, greatest(250, greatest(coalesce(match_count, 10), 1) * 70))
        ELSE least(9000, greatest(400, greatest(coalesce(match_count, 10), 1) * 100))
      END AS resolved_candidate_limit
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
    AND (p.resolved_section_type IS NULL OR dc.section_type = p.resolved_section_type)
  ORDER BY ac.distance
  LIMIT (SELECT resolved_match_count FROM params);
$function$;

CREATE OR REPLACE FUNCTION rag.match_corpus_chunks_hybrid(query_embedding halfvec, query_text text, match_count integer DEFAULT NULL::integer, filter_product_line_key text DEFAULT NULL::text, filter_scope text DEFAULT 'all'::text, filter_section_type text DEFAULT NULL::text)
 RETURNS TABLE(chunk_id uuid, chunk_key text, chunk_index integer, heading text, chunk_text text, section_path text[], section_type text, token_count integer, document_id uuid, document_key text, document_title text, entity_id uuid, product_key text, sku text, product_line_key text, source_pk text, document_kind text, similarity double precision)
 LANGUAGE sql
 STABLE
 SET statement_timeout TO '60s'
 SET search_path TO 'rag', 'extensions', 'public'
AS $function$
  WITH params AS (
    SELECT
      greatest(coalesce(match_count, 10), 1) AS resolved_match_count,
      nullif(trim(filter_product_line_key), '') AS resolved_product_line_key,
      nullif(trim(filter_section_type), '') AS resolved_section_type,
      CASE
        WHEN lower(trim(coalesce(filter_scope, 'all'))) IN ('all', 'products', 'sds', 'efficacy')
          THEN lower(trim(coalesce(filter_scope, 'all')))
        ELSE 'all'
      END AS resolved_scope,
      CASE
        WHEN nullif(trim(coalesce(query_text, '')), '') IS NOT NULL
          THEN websearch_to_tsquery('english', trim(query_text))
        ELSE NULL
      END AS query_tsq,
      CASE
        WHEN lower(trim(coalesce(filter_scope, 'all'))) = 'products'
          AND nullif(trim(filter_product_line_key), '') IS NOT NULL
          THEN least(3000, greatest(150, greatest(coalesce(match_count, 10), 1) * 40))
        WHEN lower(trim(coalesce(filter_scope, 'all'))) = 'products'
          THEN least(7000, greatest(300, greatest(coalesce(match_count, 10), 1) * 80))
        WHEN lower(trim(coalesce(filter_scope, 'all'))) = 'sds'
          THEN least(5000, greatest(250, greatest(coalesce(match_count, 10), 1) * 70))
        WHEN lower(trim(coalesce(filter_scope, 'all'))) = 'efficacy'
          THEN least(5000, greatest(250, greatest(coalesce(match_count, 10), 1) * 70))
        ELSE least(9000, greatest(400, greatest(coalesce(match_count, 10), 1) * 100))
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
$function$;

ALTER FUNCTION rag.match_corpus_chunks_hybrid(halfvec, text, integer, text, text, text)
  SET statement_timeout = '60s'
  SET search_path TO 'rag', 'extensions', 'public';
