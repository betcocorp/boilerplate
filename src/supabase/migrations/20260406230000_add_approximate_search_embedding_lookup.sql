create extension if not exists pg_trgm with schema extensions;

create index if not exists search_embedding_query_string_trgm_idx
  on rag.search_embedding
  using gin (lower(query_string) extensions.gin_trgm_ops)
  where deleted_at is null;

create index if not exists search_embedding_query_rewritten_trgm_idx
  on rag.search_embedding
  using gin (lower(query_rewritten) extensions.gin_trgm_ops)
  where deleted_at is null
    and query_rewritten is not null;

create or replace function rag.find_similar_search_embedding(
  p_query text,
  p_query_similarity_threshold double precision default 0.9,
  p_rewritten_similarity_threshold double precision default 0.88
)
returns table (
  id bigint,
  query_string text,
  query_rewritten text,
  embeddings extensions.vector(1536),
  query_count integer,
  timing_sample_count integer,
  avg_total_search_ms double precision,
  avg_query_embedding_ms double precision,
  avg_query_rewrite_ms double precision,
  avg_cache_lookup_ms double precision,
  avg_embedding_create_ms double precision,
  avg_cache_persist_ms double precision,
  avg_similarity_search_ms double precision,
  match_source text,
  matched_similarity double precision
)
language sql
stable
set search_path = rag, extensions, public
as $$
  with normalized as (
    select lower(regexp_replace(trim(coalesce(p_query, '')), '\s+', ' ', 'g')) as normalized_query
  ),
  candidates as (
    select
      se.id,
      se.query_string,
      se.query_rewritten,
      se.embeddings,
      se.query_count,
      se.timing_sample_count,
      se.avg_total_search_ms,
      se.avg_query_embedding_ms,
      se.avg_query_rewrite_ms,
      se.avg_cache_lookup_ms,
      se.avg_embedding_create_ms,
      se.avg_cache_persist_ms,
      se.avg_similarity_search_ms,
      'query_string'::text as match_source,
      similarity(lower(se.query_string), n.normalized_query) as matched_similarity,
      se.updated_at
    from rag.search_embedding se
    cross join normalized n
    where se.deleted_at is null
      and nullif(trim(n.normalized_query), '') is not null
      and similarity(lower(se.query_string), n.normalized_query) >= p_query_similarity_threshold

    union all

    select
      se.id,
      se.query_string,
      se.query_rewritten,
      se.embeddings,
      se.query_count,
      se.timing_sample_count,
      se.avg_total_search_ms,
      se.avg_query_embedding_ms,
      se.avg_query_rewrite_ms,
      se.avg_cache_lookup_ms,
      se.avg_embedding_create_ms,
      se.avg_cache_persist_ms,
      se.avg_similarity_search_ms,
      'query_rewritten'::text as match_source,
      similarity(lower(se.query_rewritten), n.normalized_query) as matched_similarity,
      se.updated_at
    from rag.search_embedding se
    cross join normalized n
    where se.deleted_at is null
      and se.query_rewritten is not null
      and nullif(trim(n.normalized_query), '') is not null
      and similarity(lower(se.query_rewritten), n.normalized_query) >= p_rewritten_similarity_threshold
  )
  select
    c.id,
    c.query_string,
    c.query_rewritten,
    c.embeddings,
    c.query_count,
    c.timing_sample_count,
    c.avg_total_search_ms,
    c.avg_query_embedding_ms,
    c.avg_query_rewrite_ms,
    c.avg_cache_lookup_ms,
    c.avg_embedding_create_ms,
    c.avg_cache_persist_ms,
    c.avg_similarity_search_ms,
    c.match_source,
    c.matched_similarity
  from candidates c
  order by
    c.matched_similarity desc,
    case when c.match_source = 'query_string' then 0 else 1 end,
    c.updated_at desc
  limit 1;
$$;

grant execute on function rag.find_similar_search_embedding(
  text,
  double precision,
  double precision
) to service_role;

comment on function rag.find_similar_search_embedding(
  text,
  double precision,
  double precision
) is
  'Finds the closest active cached search_embedding row using trigram similarity against query_string and query_rewritten, for approximate cache reuse before rewrite/embedding.';
