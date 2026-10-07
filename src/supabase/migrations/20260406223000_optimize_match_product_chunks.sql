create or replace function rag.match_product_chunks(
  query_embedding extensions.vector(1536),
  match_count integer default 10,
  filter_product_key text default null,
  filter_product_line_key text default null
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
  similarity double precision
)
language sql
stable
set search_path = rag, extensions, public
set statement_timeout = '120s'
as $$
  with params as (
    select
      greatest(coalesce(match_count, 10), 1) as resolved_match_count,
      nullif(trim(filter_product_key), '') as resolved_product_key,
      nullif(trim(filter_product_line_key), '') as resolved_product_line_key,
      case
        when nullif(trim(filter_product_key), '') is not null
          or nullif(trim(filter_product_line_key), '') is not null
          then least(1500, greatest(50, greatest(coalesce(match_count, 10), 1) * 15))
        else least(8000, greatest(200, greatest(coalesce(match_count, 10), 1) * 50))
      end as resolved_candidate_limit
  ),
  eligible_documents as materialized (
    select
      d.id as document_id,
      d.document_key,
      d.title as document_title,
      e.id as entity_id,
      e.product_key,
      e.sku,
      e.product_line_key,
      sr.source_pk
    from rag.document d
    join rag.source_record sr
      on sr.id = d.source_record_id
    left join rag.entity e
      on e.id = d.entity_id
    cross join params p
    where d.document_kind = 'product_line_profile'
      and d.language_code = 'EN'
      and sr.is_active = true
      and d.metadata @> '{"has_web_available_variant": true}'::jsonb
      and (
        p.resolved_product_line_key is null
        or sr.source_pk = p.resolved_product_line_key
        or e.product_line_key = p.resolved_product_line_key
      )
      and (
        p.resolved_product_key is null
        or e.product_key = p.resolved_product_key
        or d.metadata @> jsonb_build_object(
          'variant_product_keys',
          jsonb_build_array(p.resolved_product_key)
        )
      )
  ),
  ann_candidates as materialized (
    select dc_ann.id as chunk_id
    from rag.document_chunk dc_ann
    join eligible_documents ed
      on ed.document_id = dc_ann.document_id
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
    ed.document_id,
    ed.document_key,
    ed.document_title,
    ed.entity_id,
    ed.product_key,
    ed.sku,
    ed.product_line_key,
    ed.source_pk,
    1 - (dc.embedding <=> query_embedding) as similarity
  from ann_candidates ac
  join rag.document_chunk dc
    on dc.id = ac.chunk_id
  join eligible_documents ed
    on ed.document_id = dc.document_id
  order by dc.embedding <=> query_embedding
  limit (select resolved_match_count from params);
$$;

comment on function rag.match_product_chunks(
  extensions.vector(1536),
  integer,
  text,
  text
) is
  'Optimized ANN-first product-line chunk search that pre-filters eligible documents using structured metadata, applies line/product filters before ANN, and uses a smaller dynamic candidate window.';

grant execute on function rag.match_product_chunks(
  extensions.vector(1536),
  integer,
  text,
  text
) to service_role;
