-- B0-904 — the three single-shot cross-reference / taxonomy model overrides move from env vars to
-- `settings` rows, per B0-638 (env is for secrets only; flags, models and thresholds live here).
--
-- Each row holds a BEX_MODEL_TAGS tag (~/lib/constants/models.ts). The reader re-validates the
-- stored value against that enum and falls back to `preview` on anything unrecognised —
-- `allowed_values` is advisory metadata POST /api/admin/settings validates writes against and
-- /admin/settings renders as a select, NOT a DB constraint. The tag is resolved to a concrete model
-- id via resolveModel (~/lib/llm/resolve-model.ts): `preview` follows the BEX_LLM_PROVIDER row's
-- per-vendor default (openai → BEX_RESPONSES_MODEL, anthropic → BEX_ANTHROPIC_MODEL); an explicit
-- gpt-* tag is called on the OpenAI Responses API; an explicit claude-* tag is the exact Claude API
-- id and is called on the Anthropic Messages API via ~/lib/llm/structured-completion, which requires
-- ANTHROPIC_API_KEY in env (a secret, so env not settings). There is no fallback provider.
--
-- Seed value `preview` is behaviour-preserving: none of the three env vars was set in any
-- environment, so every call already fell through to whatever `preview` resolved to.
insert into public.settings (key, value, value_type, description, allowed_values) values
  (
    'XREF_COMPETITOR_EXTRACT_MODEL',
    'preview',
    'string',
    'Model tag for the competitor brand/product extraction call (extractCompetitorProduct, src/lib/recommendations/extract-competitor-product.ts) that turns a free-text cross-reference ask into a clean competitor query. Must be one of BEX_MODEL_TAGS (~/lib/constants/models.ts); an unrecognised value is treated as preview. preview follows the BEX_LLM_PROVIDER row''s per-vendor default (openai -> BEX_RESPONSES_MODEL, anthropic -> BEX_ANTHROPIC_MODEL). A gpt-* tag is called on the OpenAI Responses API; a claude-* tag is the exact Claude API id, called on the Anthropic Messages API via ~/lib/llm/structured-completion, and requires ANTHROPIC_API_KEY in env. This row replaces the former XREF_COMPETITOR_EXTRACT_MODEL env var of the same name per B0-638 (B0-904).',
    array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5']
  ),
  (
    'XREF_SPEC_ENRICH_MODEL',
    'preview',
    'string',
    'Model tag for the competitor-spec enrichment call (enrichCompetitorSpec, src/lib/websearch/enrich-competitor-spec.ts) that fills the fields the deterministic spec extractor left null from web-search content during a cross-reference recommendation. Must be one of BEX_MODEL_TAGS (~/lib/constants/models.ts); an unrecognised value is treated as preview. preview follows the BEX_LLM_PROVIDER row''s per-vendor default (openai -> BEX_RESPONSES_MODEL, anthropic -> BEX_ANTHROPIC_MODEL). A gpt-* tag is called on the OpenAI Responses API; a claude-* tag is the exact Claude API id, called on the Anthropic Messages API via ~/lib/llm/structured-completion, and requires ANTHROPIC_API_KEY in env. This row replaces the former XREF_SPEC_ENRICH_MODEL env var of the same name per B0-638 (B0-904).',
    array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5']
  ),
  (
    'CATEGORY_CLASSIFIER_MODEL',
    'preview',
    'string',
    'Model tag for the product-taxonomy classifier call (defaultClassify, src/lib/category/product-classifier.ts) that places prod-lines the deterministic linker could not into a taxonomy node (B0-35). Must be one of BEX_MODEL_TAGS (~/lib/constants/models.ts); an unrecognised value is treated as preview. preview follows the BEX_LLM_PROVIDER row''s per-vendor default (openai -> BEX_RESPONSES_MODEL, anthropic -> BEX_ANTHROPIC_MODEL). A gpt-* tag is called on the OpenAI Responses API; a claude-* tag is the exact Claude API id, called on the Anthropic Messages API via ~/lib/llm/structured-completion, and requires ANTHROPIC_API_KEY in env. This row replaces the former CATEGORY_CLASSIFIER_MODEL env var of the same name per B0-638 (B0-904). The confidence floor stays on the CATEGORY_CLASSIFIER_MIN_CONFIDENCE env var (out of scope here).',
    array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5']
  )
on conflict (key) do nothing;
