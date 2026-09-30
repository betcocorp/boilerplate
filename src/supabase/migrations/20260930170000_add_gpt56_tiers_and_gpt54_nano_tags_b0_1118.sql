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
--      DROPPED from cost reporting, not zeroed. gpt-5.4-nano is deliberately NOT priced here (see
--      the TODO below).
--   2. allowed_values widened on every settings row that validates against BEX_MODEL_TAGS, with the
--      four tags inserted right after 'gpt-5.6'. VALUES and descriptions are untouched — applying
--      this migration changes no behaviour. allowed_values is advisory metadata POST
--      /api/admin/settings validates writes against and /admin/settings renders as a select, NOT a
--      DB constraint; each reader re-validates against the enum and falls back to its default.
--      `preview` stays present/absent exactly as each row has it today (BEX_RESPONSES_MODEL omits
--      it on purpose — it is what `preview` resolves to, B0-831), and TEST_ITEM_GRADING_MODEL keeps
--      'run' first (B0-902).

-- 1. Pricing. Rates are OpenAI's published STANDARD API pricing for the three gpt-5.6 tiers, as
-- recorded in the gpt-5.6 row notes of 20260820160000_model_pricing_gpt55_gpt56.sql (verified
-- 2026-08-20 from OpenAI's pricing page): sol $5.00 / $0.50 / $30.00 (same as the existing gpt-5.6
-- alias row), terra $2.00 / $0.20 / $12.00, luna $0.20 / $0.02 / $1.20 (input / cached input /
-- output per Mtok). Transcribed exactly; not estimated. B0-564 convention: if OpenAI changes a rate,
-- INSERT a new (model_id, effective_date) row — never edit a historical one.

insert into public.model_pricing
  (model_id, input_cost_per_mtok, cached_input_cost_per_mtok, output_cost_per_mtok, effective_date, updated_by, notes)
values
  ('gpt-5.6-sol',   5.00, 0.50, 30.00, '2026-09-30', 'seed_migration',
   'OpenAI published standard pricing as recorded in the gpt-5.6 row notes, verified 2026-08-20; live-verified servable 2026-09-30; B0-1118. Frontier gpt-5.6 tier; the id the gpt-5.6 alias resolves to, so same rate as that row.'),
  ('gpt-5.6-terra', 2.00, 0.20, 12.00, '2026-09-30', 'seed_migration',
   'OpenAI published standard pricing as recorded in the gpt-5.6 row notes, verified 2026-08-20; live-verified servable 2026-09-30; B0-1118. Balanced gpt-5.6 tier.'),
  ('gpt-5.6-luna',  0.20, 0.02,  1.20, '2026-09-30', 'seed_migration',
   'OpenAI published standard pricing as recorded in the gpt-5.6 row notes, verified 2026-08-20; live-verified servable 2026-09-30; B0-1118. Cost-optimized gpt-5.6 tier.')
on conflict (model_id, effective_date) do nothing;

-- TODO(B0-1118): gpt-5.4-nano pricing row deliberately OMITTED. OpenAI's pricing page could not be
-- fetched on 2026-09-30, and rates are never guessed or estimated. Before any gpt-5.4-nano run is
-- cost-reported, transcribe input / cached input / output $ per Mtok exactly as printed on
-- developers.openai.com/api/docs/pricing (standard tier) into a new migration:
--   insert into public.model_pricing (model_id, input_cost_per_mtok, cached_input_cost_per_mtok,
--     output_cost_per_mtok, effective_date, updated_by, notes)
--   values ('gpt-5.4-nano', <input>, <cached>, <output>, '<read date>', 'seed_migration', '<source + date>')
--   on conflict (model_id, effective_date) do nothing;
-- Until then the B0-565 cost views (INNER join on model_pricing) DROP gpt-5.4-nano steps from cost
-- reporting entirely — they are not priced at zero. The tag is still selectable and runs fine; only
-- /admin/cost is blind to it.

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
