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
as $$
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
  from rag.document_chunk dc
  join rag.document d
    on d.id = dc.document_id
  join rag.source_record sr
    on sr.id = d.source_record_id
  left join rag.entity e
    on e.id = d.entity_id
  where dc.embedding is not null
    and d.document_kind = 'product_profile'
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

grant execute on function rag.match_product_chunks(
  extensions.vector(1536),
  integer,
  text,
  text
) to service_role;

comment on function rag.match_product_chunks(
  extensions.vector(1536),
  integer,
  text,
  text
) is
  'Returns the most similar active product-profile chunks from rag.document_chunk using cosine similarity, with optional product and product-line filters.';
