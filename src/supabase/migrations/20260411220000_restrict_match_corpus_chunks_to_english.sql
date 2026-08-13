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
set statement_timeout = '120s'
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
      least(8000, greatest(200, greatest(coalesce(match_count, 10), 1) * 50)) as resolved_candidate_limit
  ),
  eligible_documents as materialized (
    select
      d.id as document_id,
      d.document_key,
      d.title as document_title,
      d.document_kind,
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
    ed.document_kind,
    1 - (dc.embedding <=> query_embedding) as similarity
  from ann_candidates ac
  join rag.document_chunk dc
    on dc.id = ac.chunk_id
  join eligible_documents ed
    on ed.document_id = dc.document_id
  order by dc.embedding <=> query_embedding
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
  'ANN-first chunk search across RAG document kinds with optional scope filtering (all/products/sds), restricted to English documents.';
