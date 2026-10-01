create or replace function rag.match_corpus_chunks(
  query_embedding extensions.vector(1536),
  match_count integer default 10,
  filter_product_line_key text default null,
  filter_scope text default 'all'
)
returns table (
  chunk_id uuid,
  chunk_key text,
  chunk_index integer,
  heading text,
  chunk_text text,
  section_path text[],
  token_count integer,
  document_id uuid,
  document_key text,
  document_title text,
  entity_id uuid,
  product_key text,
  sku text,
  product_line_key text,
  source_pk text,
  document_kind text,
  similarity double precision
)
language sql
stable
set search_path = rag, extensions, public
set statement_timeout = '60s'
as $$
  with params as (
    select
      greatest(coalesce(match_count, 10), 1) as resolved_match_count,
      nullif(trim(filter_product_line_key), '') as resolved_product_line_key,
      case
        when lower(trim(coalesce(filter_scope, 'all'))) in ('all', 'products', 'sds')
          then lower(trim(coalesce(filter_scope, 'all')))
        else 'all'
      end as resolved_scope,
      case
        when lower(trim(coalesce(filter_scope, 'all'))) = 'products'
          and nullif(trim(filter_product_line_key), '') is not null
          then least(3000, greatest(150, greatest(coalesce(match_count, 10), 1) * 40))
        when lower(trim(coalesce(filter_scope, 'all'))) = 'products'
          then least(7000, greatest(300, greatest(coalesce(match_count, 10), 1) * 80))
        when lower(trim(coalesce(filter_scope, 'all'))) = 'sds'
          then least(5000, greatest(250, greatest(coalesce(match_count, 10), 1) * 70))
        else least(9000, greatest(400, greatest(coalesce(match_count, 10), 1) * 100))
      end as resolved_candidate_limit
  ),
  ann_candidates as materialized (
    -- ANN-first: force the HNSW index on document_chunk before expensive joins.
    select
      dc_ann.id as chunk_id,
      dc_ann.document_id,
      dc_ann.embedding <=> query_embedding as distance
    from rag.document_chunk dc_ann
    cross join params p
    where dc_ann.embedding is not null
    order by dc_ann.embedding <=> query_embedding
    limit (select resolved_candidate_limit from params)
  )
  select
    dc.id as chunk_id,
    dc.chunk_key,
    dc.chunk_index,
    dc.heading,
    dc.chunk_text,
    dc.section_path,
    dc.token_count,
    d.id as document_id,
    d.document_key,
    d.title as document_title,
    e.id as entity_id,
    e.product_key,
    e.sku,
    e.product_line_key,
    sr.source_pk,
    d.document_kind,
    1 - ac.distance as similarity
  from ann_candidates ac
  join rag.document_chunk dc
    on dc.id = ac.chunk_id
  join rag.document d
    on d.id = ac.document_id
  join rag.source_record sr
    on sr.id = d.source_record_id
  left join rag.entity e
    on e.id = d.entity_id
  cross join params p
  where sr.is_active = true
    and upper(coalesce(d.language_code, '')) = 'EN'
    and (
      p.resolved_scope = 'all'
      or (
        p.resolved_scope = 'products'
        and d.document_kind = 'product_line_profile'
        and d.metadata @> '{"has_web_available_variant": true}'::jsonb
      )
      or (p.resolved_scope = 'sds' and d.document_kind = 'sds')
    )
    and (
      p.resolved_product_line_key is null
      or sr.source_pk = p.resolved_product_line_key
      or e.product_line_key = p.resolved_product_line_key
    )
  order by ac.distance
  limit (select resolved_match_count from params);
$$;

grant execute on function rag.match_corpus_chunks(
  extensions.vector(1536),
  integer,
  text,
  text
) to service_role;

comment on function rag.match_corpus_chunks(
  extensions.vector(1536),
  integer,
  text,
  text
) is
  'ANN-first corpus chunk search with English-only filtering and scope controls (all/products/sds), optimized to use HNSW before joins.';
