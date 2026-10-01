create index if not exists search_embedding_query_string_active_updated_idx
  on rag.search_embedding (query_string, updated_at desc)
  where deleted_at is null;

comment on index rag.search_embedding_query_string_active_updated_idx is
  'Speeds exact query_string cache lookups for active semantic-search embedding rows.';
