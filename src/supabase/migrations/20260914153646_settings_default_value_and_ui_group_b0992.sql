-- B0-992 — /admin/settings renders straight from this table instead of a code registry.
-- default_value: what the reader falls back to when value is null (and what "Reset to default"
-- restores). ui_group: which card a row renders in; 'hidden' keeps rows another admin page owns
-- (RAG chunking/boost, edited on the RAG admin page with bounds validation) off the generic page.
alter table public.settings
  add column if not exists default_value text null,
  add column if not exists ui_group text null;

alter table public.settings alter column value drop not null;

comment on column public.settings.default_value is
  'B0-992 — value the reader uses when value is null; mirrors the code fallback of the reader that owns the key. Null when the key has no reader (orphaned) or its fallback is not a literal.';
comment on column public.settings.ui_group is
  'B0-992 — card the row renders in on /admin/settings. ''hidden'' excludes it (owned by another admin page). Null renders under "Other".';

-- Defaults transcribed from each reader's code fallback (the second argument of
-- getBooleanSetting / getStringSetting / getNumberSetting or the DEFAULT_* constant it names).
update public.settings s set default_value = d.default_value
from (values
  ('ALERT_GOLDEN_GATE_MISS_ENABLED', 'true'),
  ('ALERT_GOLDEN_MIN_GRADED_ITEMS', '5'),
  ('ALERT_GOLDEN_PASS_RATE_DROP_CRITICAL', '0.2'),
  ('ALERT_GOLDEN_PASS_RATE_DROP_WARNING', '0.1'),
  ('ALERT_SENTRY_ENABLED', 'true'),
  ('ALERT_TOOL_FAILURE_LOOKBACK_DAYS', '7'),
  ('ALERT_TOOL_FAILURE_MIN_SETTLED_CALLS', '50'),
  ('ALERT_TOOL_FAILURE_RATE_CRITICAL', '0.3'),
  ('ALERT_TOOL_FAILURE_RATE_WARNING', '0.15'),
  ('ALERT_TOOL_FAILURE_SPIKE_DELTA', '0.1'),
  ('ALERT_TOOL_FAILURE_SPIKE_RATIO', '3'),
  ('BEX_AI_SDK_GENERATION_ENABLED', 'false'),
  ('BEX_ANTHROPIC_MODEL', 'claude-sonnet-5'),
  ('BEX_DISABLE_CONFIDENCE_GATING', 'false'),
  ('BEX_DISABLE_RECOMMENDATION_CONFIDENCE_GATING', 'true'),
  ('BEX_EARLY_DECLINE_GATE_ENABLED', 'false'),
  ('BEX_FACT_TOOL_ENFORCEMENT_ENABLED', 'true'),
  ('BEX_GENERATION_EFFORT', 'provider_default'),
  ('BEX_LLM_PROVIDER', 'openai'),
  ('BEX_LLM_ROUTER_ENABLED', 'true'),
  ('BEX_LLM_ROUTER_SHADOW_MODE', 'false'),
  ('BEX_PERMISSIONS_ENFORCED', 'false'),
  ('BEX_PRODUCT_LINE_LOCK_HIGH_CONFIDENCE', '0.64'),
  ('BEX_PRODUCT_LINE_LOCK_MARGIN', '0.06'),
  ('BEX_PRODUCT_LINE_LOCK_MIN_SIMILARITY', '0.5'),
  ('BEX_QUERY_REWRITE_MODEL', 'gpt-4.1-mini'),
  ('BEX_RESPONSES_MODEL', 'gpt-4.1-mini'),
  ('BEX_REVISION_SKIP_REGULATED_CLAIM_ONLY_ENABLED', 'false'),
  ('BEX_ROUTER_MODEL', 'gpt-4.1'),
  ('BEX_ROUTER_TIMEOUT_MS', '5000'),
  ('BEX_SEMANTIC_ROUTER_ENABLED', 'false'),
  ('BEX_SEMANTIC_ROUTER_SHADOW_MODE', 'false'),
  ('BEX_SIGNALS_ANALYSIS_ENABLED', 'false'),
  ('BEX_VALIDATOR_MODEL', 'preview'),
  ('CATEGORY_CLASSIFIER_MODEL', 'preview'),
  ('COHERE_RERANK_MODEL', 'rerank-v3.5'),
  ('ENABLE_RERANKER', 'false'),
  ('HARNESS_INSIGHTS_MODEL', 'gpt-4.1-mini'),
  ('RAG_BOOST_DILUTION_RATIO', '0.05'),
  ('RAG_BOOST_DWELL_TIME', '0.05'),
  ('RAG_BOOST_ENABLED', 'false'),
  ('RAG_BOOST_SURFACE_TYPE', '0.1'),
  ('RAG_CHUNK_MAX_TOKENS', '600'),
  ('RAG_CHUNK_MIN_TOKENS', '300'),
  ('RAG_CHUNK_OVERLAP_TOKENS', '50'),
  ('RAG_CHUNK_STRATEGY', 'naive'),
  ('REPORT_CONSISTENCY_SPREAD_THRESHOLD', '10'),
  ('REPORT_EXPECTED_COVERAGE_ENABLED', 'true'),
  ('REPORT_GRADING_EFFORT', 'high'),
  ('REPORT_GRADING_MODEL', 'claude-opus-5'),
  ('REPORT_GRADING_PASSES', '3'),
  ('REPORT_JUDGED_CORR_MIN_N', '5'),
  ('REPORT_JUDGED_HIGH_SIM_FAIL', '0.6'),
  ('REPORT_JUDGED_LOW_CONFIDENCE', '70'),
  ('REPORT_JUDGED_LOW_SIM_PASS', '0.5'),
  ('REPORT_JUDGED_SIM_HIGH', '0.75'),
  ('REPORT_JUDGED_SIM_LOW', '0.4'),
  ('REPORT_MINIMAL_CEILING_ENABLED', 'true'),
  ('REPORT_MINIMAL_CEILING_SCORE', '59'),
  ('REPORT_MINIMAL_FLOOR_ENABLED', 'true'),
  ('REPORT_MINIMAL_FLOOR_RESPECT_MATERIAL_ISSUE', 'true'),
  ('REPORT_MINIMAL_FLOOR_SCORE', '70'),
  ('REPORT_MINIMAL_GATE_ENABLED', 'true'),
  ('REPORT_PASS_MARK', '60'),
  ('ROUTER_TYPE', 'keyword'),
  ('SEMANTIC_ROUTER_CONFIDENCE_THRESHOLD', '0.5'),
  ('SEMANTIC_ROUTER_EMBEDDING_MODEL', 'text-embedding-3-large'),
  ('SEMANTIC_ROUTER_MARGIN_THRESHOLD', '0.1'),
  ('TEST_ITEM_GRADING_EFFORT', 'high'),
  ('TEST_ITEM_GRADING_MODEL', 'run'),
  ('WEBSEARCH_DB_CACHE_ENABLED', 'false'),
  ('WEBSEARCH_PROVIDER', 'tavily'),
  ('XREF_COMPETITOR_EXTRACT_MODEL', 'preview'),
  ('XREF_RECOMMENDATION_MIN_CONFIDENCE', '0.8'),
  ('XREF_RECOMMENDATION_TIMEOUT_MS', '20000'),
  ('XREF_SPEC_ENRICH_MODEL', 'preview')
) as d(key, default_value)
where s.key = d.key;
-- OPENAI_EMBEDDING_MODEL has no reader in code (orphaned row) — default_value stays null on purpose.

update public.settings set ui_group = case
  when key like 'RAG_BOOST_%' or key like 'RAG_CHUNK_%' then 'hidden'   -- owned by the RAG admin page (bounds-validated there)
  when key like 'ALERT_%' then 'Observability alerts'
  when key like 'REPORT_%' or key like 'TEST_ITEM_%' or key like 'HARNESS_%' then 'Eval reports and grading'
  when key like 'SEMANTIC_ROUTER_%' or key like 'BEX_SEMANTIC_ROUTER_%' or key like 'BEX_LLM_ROUTER_%' or key like 'BEX_ROUTER_%' or key = 'ROUTER_TYPE' or key = 'BEX_SIGNALS_ANALYSIS_ENABLED' then 'Routing'
  when key like 'XREF_%' or key like 'CATEGORY_%' or key like 'WEBSEARCH_%' then 'Cross-reference and web search'
  when key like '%_MODEL' or key like '%_EFFORT' or key = 'BEX_LLM_PROVIDER' then 'Models and providers'
  when key like 'BEX_PRODUCT_LINE_LOCK_%' or key like 'COHERE_%' or key = 'ENABLE_RERANKER' then 'Retrieval'
  when key like 'BEX_%' then 'Bex answer pipeline'
  else null
end
where ui_group is null;
