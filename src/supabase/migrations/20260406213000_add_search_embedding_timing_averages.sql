alter table rag.search_embedding
  add column if not exists timing_sample_count integer not null default 0,
  add column if not exists avg_total_search_ms double precision not null default 0,
  add column if not exists avg_query_embedding_ms double precision not null default 0,
  add column if not exists avg_query_rewrite_ms double precision not null default 0,
  add column if not exists avg_cache_lookup_ms double precision not null default 0,
  add column if not exists avg_embedding_create_ms double precision not null default 0,
  add column if not exists avg_cache_persist_ms double precision not null default 0,
  add column if not exists avg_similarity_search_ms double precision not null default 0;

alter table rag.search_embedding
  drop constraint if exists search_embedding_timing_sample_count_check;

alter table rag.search_embedding
  add constraint search_embedding_timing_sample_count_check
  check (timing_sample_count >= 0);

comment on column rag.search_embedding.timing_sample_count is
  'How many successful semantic searches have contributed to the rolling timing averages for this cached query embedding.';

comment on column rag.search_embedding.avg_total_search_ms is
  'Rolling average of end-to-end semantic search time in milliseconds for this cached query embedding.';

comment on column rag.search_embedding.avg_query_embedding_ms is
  'Rolling average of query embedding preparation time in milliseconds, including rewrite/cache/creation work.';

comment on column rag.search_embedding.avg_query_rewrite_ms is
  'Rolling average of query rewrite time in milliseconds for this cached query embedding.';

comment on column rag.search_embedding.avg_cache_lookup_ms is
  'Rolling average of search_embedding cache lookup time in milliseconds for this cached query embedding.';

comment on column rag.search_embedding.avg_embedding_create_ms is
  'Rolling average of OpenAI embedding creation time in milliseconds for this cached query embedding.';

comment on column rag.search_embedding.avg_cache_persist_ms is
  'Rolling average of search_embedding cache insert/update persistence time in milliseconds for this cached query embedding.';

comment on column rag.search_embedding.avg_similarity_search_ms is
  'Rolling average of rag.match_product_chunks similarity search time in milliseconds for this cached query embedding.';
