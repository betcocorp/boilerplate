-- Planner was seq-scanning ~all embedded chunks, computing distance for each (~56s).
-- Run ANN on document_chunk alone first so HNSW is used; then join and apply filters.
-- Oversample: filtered rows can drop candidates—raise multiplier if selective filters return empty.
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
  with ann_candidates as materialized (
    select dc_ann.id as chunk_id
    from rag.document_chunk dc_ann
    where dc_ann.embedding is not null
    order by dc_ann.embedding <=> query_embedding
    limit least(
      20000,
      greatest(
        400,
        greatest(coalesce(match_count, 10), 1) * 120
      )
    )
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
    1 - (dc.embedding <=> query_embedding) as similarity
  from ann_candidates ac
  join rag.document_chunk dc
    on dc.id = ac.chunk_id
  join rag.document d
    on d.id = dc.document_id
  join rag.source_record sr
    on sr.id = d.source_record_id
  left join rag.entity e
    on e.id = d.entity_id
  where d.document_kind = 'product_profile'
    and d.language_code = 'EN'
    and sr.is_active = true
    and (
      filter_product_key is null
      or e.product_key = filter_product_key
      or sr.source_pk = filter_product_key
    )
    and (
      filter_product_line_key is null
      or e.product_line_key = filter_product_line_key
    )
  order by dc.embedding <=> query_embedding
  limit greatest(coalesce(match_count, 10), 1);
$$;

comment on function rag.match_product_chunks(
  extensions.vector(1536),
  integer,
  text,
  text
) is
  'ANN-first similarity search: HNSW on document_chunk, then join/filter. Oversamples candidates before filters; increase multiplier in SQL if selective product filters often miss matches.';
