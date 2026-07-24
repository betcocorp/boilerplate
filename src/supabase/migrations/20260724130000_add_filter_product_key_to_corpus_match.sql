-- B0-250 follow-up: rag.match_corpus_chunks / match_corpus_chunks_hybrid (the scope='all'/'sds'
-- RPC family) never accepted a filter_product_key parameter -- only match_product_chunks*
-- (scope='products') did. This was a real gap, not an intentional scope decision: the actual
-- product-support tool call path (src/lib/retrieval/product-knowledge.ts's `explicitKey` and
-- `skipProductLineResolution` branches -- exactly the "a query resolved to a specific product"
-- case B0-250 targets) calls searchProductChunks with scope='all', which routes to THIS RPC
-- family, not match_product_chunks. So B0-250's productKey threading was type-safe but
-- functionally inert on the real application path (confirmed via a Vitest eval added under
-- B0-251, which found the "Kling" product-scoped query surfacing a Canada label doc instead of
-- the specifically-resolved US one -- a live symptom of this gap).
--
-- IMPORTANT: this uses DROP + CREATE, not CREATE OR REPLACE. Adding a parameter changes the
-- function's argument signature; CREATE OR REPLACE with a different signature creates a NEW
-- overload alongside the old one rather than replacing it, reproducing the exact PostgREST
-- "function is not unique" ambiguity bug already found and fixed for match_product_chunks_hybrid
-- in this same epic. Confirmed live beforehand that only one overload of each function currently
-- exists (no pre-existing duplication to worry about), following the precedent already set in
-- 20260602120000_fix_match_corpus_chunks_overloads.sql for the same reason.
--
-- filter_product_key predicate mirrors the existing one in match_product_chunks exactly:
-- e.product_key = filter_product_key OR the document's metadata.variant_product_keys array
-- contains it (covers product_line_profile documents, whose entity_id points at the line, not
-- the product). Bodies are otherwise byte-for-byte identical to the live functions (confirmed via
-- pg_get_functiondef) -- only the new param + one added WHERE clause per function.

drop function if exists rag.match_corpus_chunks(halfvec, integer, text, text, text);
drop function if exists rag.match_corpus_chunks_hybrid(halfvec, text, integer, text, text, text);

create function rag.match_corpus_chunks(
  query_embedding halfvec,
  match_count integer default 10,
  filter_product_line_key text default null::text,
  filter_scope text default 'all'::text,
  filter_section_type text default null::text,
  filter_product_key text default null::text
)
returns table(chunk_id uuid, chunk_key text, chunk_index integer, heading text, chunk_text text, section_path text[], section_type text, token_count integer, document_id uuid, document_key text, document_title text, entity_id uuid, product_key text, sku text, product_line_key text, source_pk text, document_kind text, similarity double precision)
language plpgsql
set search_path to 'rag', 'extensions', 'public'
set statement_timeout to '60s'
as $function$
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
        WHEN lower(trim(coalesce(filter_scope, 'all'))) IN ('all', 'products', 'sds')
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
    AND (p.resolved_section_type IS NULL OR dc.section_type = p.resolved_section_type)
  ORDER BY ac.distance
  LIMIT (SELECT resolved_match_count FROM params);
END;
$function$;

create function rag.match_corpus_chunks_hybrid(
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
        WHEN lower(trim(coalesce(filter_scope, 'all'))) IN ('all', 'products', 'sds')
          THEN lower(trim(coalesce(filter_scope, 'all')))
        ELSE 'all'
      END AS resolved_scope,
      CASE
        WHEN nullif(trim(coalesce(query_text, '')), '') IS NOT NULL
          THEN websearch_to_tsquery('english', trim(query_text))
        ELSE NULL
      END AS query_tsq,
      least(300, greatest(greatest(coalesce(match_count, 10), 1) * 20, 200)) AS resolved_ann_limit
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

grant execute on function rag.match_corpus_chunks(halfvec, integer, text, text, text, text) to service_role;
grant execute on function rag.match_corpus_chunks_hybrid(halfvec, text, integer, text, text, text, text) to service_role;
