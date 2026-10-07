-- B0-649: semantic-router rollout flags for /admin/settings.
--
-- Mirrors the BEX_LLM_ROUTER_ENABLED / BEX_LLM_ROUTER_SHADOW_MODE pair the B0-497/B0-511 cutover
-- used. Both default to 'false' so an environment nobody configures keeps today's LLM-classifier
-- routing byte-for-byte; B0-653 documents the flag states for each rollout stage and the rollback
-- (src/docs/semantic-router-cutover.md).
--
-- The router's own thresholds (SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD,
-- SEMANTIC_ROUTER_MARGIN_THRESHOLD, SEMANTIC_ROUTER_EMBEDDING_MODEL) are seeded separately by the
-- semantic router itself (B0-647/B0-648) and are deliberately NOT touched here.

insert into public.settings (key, value, value_type, description, allowed_values) values
  ('BEX_SEMANTIC_ROUTER_ENABLED', 'false', 'boolean', 'Enable the embedding-similarity semantic router for Bex orchestrator routing (B0-649). Off = today''s LLM intent classifier decides.', null),
  ('BEX_SEMANTIC_ROUTER_SHADOW_MODE', 'false', 'boolean', 'Semantic router shadow mode (B0-649): run and log the semantic router on every orchestrator turn, but let the LLM classifier / keyword router keep deciding. Requires BEX_SEMANTIC_ROUTER_ENABLED.', null)
on conflict (key) do nothing;
