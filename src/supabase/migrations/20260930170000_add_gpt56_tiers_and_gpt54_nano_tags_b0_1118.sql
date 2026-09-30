-- B0-1118 — gpt-5.6-sol / gpt-5.6-terra / gpt-5.6-luna and gpt-5.4-nano as first-class model tags.
--
-- OPENAI_MODEL_TAGS (~/lib/constants/models.ts) now lists the three explicit gpt-5.6 tiers and
-- gpt-5.4-nano directly after 'gpt-5.6', which is KEPT (this is additive; the alias still resolves
-- to sol). Each tag has its own branch in resolveResponsesModel (~/lib/openai/client.ts) with an env
-- pin (BEX_MODEL_GPT56_SOL / _TERRA / _LUNA, BEX_MODEL_GPT54_NANO) and returns the literal tag id,
-- so the tag string is what B0-563 stamps into workflow_steps.output.model. All four were
-- live-verified servable on 2026-09-30: each is a distinct id in GET /v1/models and each completed
-- a Responses API call (sol/terra/luna echoed verbatim; gpt-5.4-nano echoed its dated snapshot
-- gpt-5.4-nano-2026-03-17).
--
-- Two parts:
--   1. model_pricing rows for the three gpt-5.6 tiers, keyed to the TAG string — the B0-565 cost
--      views join workflow_steps to model_pricing with an INNER lateral, so an unpriced model is
--      DROPPED from cost reporting, not zeroed. All four new tags are priced, plus a re-priced row
--      for the gpt-5.6 alias (see part 1).
--   2. allowed_values widened on every settings row that validates against BEX_MODEL_TAGS, with the
--      four tags inserted right after 'gpt-5.6'. VALUES and descriptions are untouched — applying
--      this migration changes no behaviour. allowed_values is advisory metadata POST
--      /api/admin/settings validates writes against and /admin/settings renders as a select, NOT a
--      DB constraint; each reader re-validates against the enum and falls back to its default.
--      `preview` stays present/absent exactly as each row has it today (BEX_RESPONSES_MODEL omits
--      it on purpose — it is what `preview` resolves to, B0-831), and TEST_ITEM_GRADING_MODEL keeps
--      'run' first (B0-902).

-- 1. Pricing. Rates transcribed 2026-09-30 from the STANDARD tier table on
-- developers.openai.com/api/docs/pricing (the page's own table data, columns Input / Cached input /
-- Cache writes / Output per 1M tokens; the cache-writes column has no home in model_pricing and is
-- not recorded). As printed: gpt-5.6-sol $4.00 / $0.40 / $20.00, gpt-5.6-terra $2.00 / $0.20 /
-- $12.00, gpt-5.6-luna $0.20 / $0.02 / $1.20, gpt-5.4-nano $0.20 / $0.02 / $1.25 (input / cached
-- input / output). The page notes "GPT-5.6 Sol's promotional pricing is available at least through
-- November 21, 2026", so the sol rate is NOT the $5.00 / $0.50 / $30.00 the 2026-08-20 gpt-5.6 row
-- recorded; per the B0-564 convention a new (model_id, effective_date) row is inserted for the
-- gpt-5.6 alias too — it resolves to sol — and the historical row is left untouched. Transcribed
-- exactly; not estimated. If OpenAI changes a rate, INSERT a new row — never edit a historical one.

insert into public.model_pricing
  (model_id, input_cost_per_mtok, cached_input_cost_per_mtok, output_cost_per_mtok, effective_date, updated_by, notes)
values
  ('gpt-5.6-sol',   4.00, 0.40, 20.00, '2026-09-30', 'seed_migration',
   'OpenAI published standard pricing, read 2026-09-30 from developers.openai.com/api/docs/pricing (promotional through at least 2026-11-21 per the page); live-verified servable 2026-09-30; B0-1118. Frontier gpt-5.6 tier; the id the gpt-5.6 alias resolves to.'),
  ('gpt-5.6',       4.00, 0.40, 20.00, '2026-09-30', 'seed_migration',
   'Alias for gpt-5.6-sol; re-priced to the sol standard rate as read 2026-09-30 from developers.openai.com/api/docs/pricing (promotional through at least 2026-11-21). Supersedes the 2026-08-20 row from this date forward; B0-1118.'),
  ('gpt-5.6-terra', 2.00, 0.20, 12.00, '2026-09-30', 'seed_migration',
   'OpenAI published standard pricing, read 2026-09-30 from developers.openai.com/api/docs/pricing; live-verified servable 2026-09-30; B0-1118. Balanced gpt-5.6 tier.'),
  ('gpt-5.6-luna',  0.20, 0.02,  1.20, '2026-09-30', 'seed_migration',
   'OpenAI published standard pricing, read 2026-09-30 from developers.openai.com/api/docs/pricing; live-verified servable 2026-09-30; B0-1118. Cost-optimized gpt-5.6 tier.'),
  ('gpt-5.4-nano',  0.20, 0.02,  1.25, '2026-09-30', 'seed_migration',
   'OpenAI published standard pricing, read 2026-09-30 from developers.openai.com/api/docs/pricing; live-verified servable 2026-09-30 (Responses call echoed gpt-5.4-nano-2026-03-17); B0-1118. Cheapest OpenAI tier.')
on conflict (model_id, effective_date) do nothing;

-- 2. Settings allowed_values. Rows with `preview` first (full BEX_MODEL_TAGS list).

update public.settings
set allowed_values = array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-nano', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    updated_at = now()
where key = 'REPORT_GRADING_MODEL';

update public.settings
set allowed_values = array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-nano', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    updated_at = now()
where key = 'BEX_ROUTER_MODEL';

update public.settings
set allowed_values = array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-nano', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    updated_at = now()
where key = 'BEX_VALIDATOR_MODEL';

update public.settings
set allowed_values = array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-nano', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    updated_at = now()
where key = 'BEX_QUERY_REWRITE_MODEL';

update public.settings
set allowed_values = array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-nano', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    updated_at = now()
where key = 'CATEGORY_CLASSIFIER_MODEL';

update public.settings
set allowed_values = array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-nano', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    updated_at = now()
where key = 'XREF_COMPETITOR_EXTRACT_MODEL';

update public.settings
set allowed_values = array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-nano', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    updated_at = now()
where key = 'XREF_SPEC_ENRICH_MODEL';

update public.settings
set allowed_values = array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-nano', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    updated_at = now()
where key = 'HARNESS_INSIGHTS_MODEL';

-- TEST_ITEM_GRADING_MODEL — 'run' first (B0-902: "same model as the run"), then the full list.

update public.settings
set allowed_values = array['run', 'preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-nano', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    updated_at = now()
where key = 'TEST_ITEM_GRADING_MODEL';

-- BEX_RESPONSES_MODEL — no `preview`, on purpose (B0-831): it is what `preview` resolves to.

update public.settings
set allowed_values = array['gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.4-nano', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    updated_at = now()
where key = 'BEX_RESPONSES_MODEL';
