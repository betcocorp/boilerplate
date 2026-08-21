-- B0-618: ENABLE_RERANKER and COHERE_RERANK_MODEL settings for /admin/settings.
-- Defaults preserve current process.env-driven behavior (ENABLE_RERANKER unset -> false,
-- COHERE_RERANK_MODEL unset -> 'rerank-v3.5').

insert into public.settings (key, value, value_type, description, allowed_values) values
  ('ENABLE_RERANKER', 'false', 'boolean', 'Default useReranker for RAG product-chunk search when a caller does not pass it explicitly (searchProductChunks; requires COHERE_API_KEY to actually take effect)', null),
  ('COHERE_RERANK_MODEL', 'rerank-v3.5', 'string', 'Cohere model used for cross-encoder reranking when reranking is active', null)
on conflict (key) do nothing;
