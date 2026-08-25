-- B0-647/B0-650: semantic intent router settings for /admin/settings.
-- Defaults match the constants in src/lib/orchestrator/semantic-router-config.ts, so seeding these
-- rows changes no behavior; they exist so the thresholds can be tuned without a deploy.
--
-- SEMANTIC_ROUTER_EMBEDDING_MODEL is intentionally locked to text-embedding-3-large: the router
-- enforces a 3072-dimension invariant (same as createEmbedding in src/lib/rag/embeddings.ts), and
-- text-embedding-3-small returns 1536 dims, which would fail every call. See
-- src/docs/semantic-router-thresholds.md for the threshold tuning strategy.
--
-- NOTE: BEX_SEMANTIC_ROUTER_ENABLED / BEX_SEMANTIC_ROUTER_SHADOW_MODE are the rollout levers owned
-- by the B0-649 workflow integration and are seeded by that ticket's migration, not this one.

insert into public.settings (key, value, value_type, description, allowed_values) values
  ('SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD', '0.50', 'number', 'Minimum top-route cosine similarity (0-1) for the semantic intent router to trust a route; below this the turn falls back to ambiguous', null),
  ('SEMANTIC_ROUTER_MARGIN_THRESHOLD', '0.10', 'number', 'Minimum gap (0-1) between the top route and the runner-up for the semantic intent router to trust a route; below this the turn falls back to ambiguous', null),
  ('SEMANTIC_ROUTER_EMBEDDING_MODEL', 'text-embedding-3-large', 'string', 'Embedding model used for the semantic router example corpus and live messages; must be a 3072-dimension model', ARRAY['text-embedding-3-large'])
on conflict (key) do nothing;
