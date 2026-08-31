-- B0-765 — REPORT_GRADING_MODEL: which model tag the run-report pipeline (case grading +
-- Top-3 findings synthesis, orchestrator.ts) uses. Configured in `public.settings` per B0-638
-- (never an env var). Seeded to 'gpt-5.6' (alias for gpt-5.6-sol) per Tom Bird's request
-- 2026-08-31 — this REPLACES the previous hardcoded 'gpt-4.1' default the code fell back to.
-- Applying this migration therefore changes report-generation behavior immediately: every new
-- run report grades cases and synthesizes findings on gpt-5.6/Sol instead of gpt-4.1.
--
-- allowed_values mirrors BEX_MODEL_TAGS (~/lib/constants/models.ts) exactly, same convention as
-- ROUTER_TYPE (B0-656): advisory metadata for /admin/settings, not a DB constraint — the
-- settings-service getter re-validates before trusting it.
insert into public.settings (key, value, value_type, description, allowed_values)
values (
  'REPORT_GRADING_MODEL',
  'gpt-5.6',
  'string',
  'Model tag used for LLM run-report grading (case scoring, case-scorer.ts) and Top-3 findings synthesis (synthesizer.ts) in orchestrator.ts (B0-765). Must be one of BEX_MODEL_TAGS (~/lib/constants/models.ts); resolved to a concrete OpenAI model id via resolveResponsesModel (~/lib/openai/client.ts). Forced to gpt-5.6 (alias for gpt-5.6-sol) 2026-08-31 — previous hardcoded default was gpt-4.1.',
  array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6']
)
on conflict (key) do nothing;
