-- Pricing rows for the gpt-5.5 / gpt-5.6 tags added to `~/lib/constants/models`.
--
-- WHY THIS IS REQUIRED, not cosmetic: `cost_by_model_per_day` / `_per_month` (B0-565) join
-- workflow_steps to model_pricing with a CROSS JOIN LATERAL ... LIMIT 1. That is an INNER lateral,
-- so a step whose `output->>'model'` has no matching pricing row is DROPPED from the rollup
-- entirely — cost is silently understated rather than reported as zero or flagged. Without these
-- rows every run on the two new models would vanish from /admin/cost.
--
-- KEYED TO THE TAG, NOT THE RESOLVED VARIANT: B0-563 stamps `workflow_steps.output.model` from our
-- own resolver (`resolveResponsesModel(input.modelTag)` in run-product-support-workflow.ts), i.e.
-- the string WE send OpenAI — never the concrete model the API echoes back. `resolveResponsesModel`
-- has no branch for either tag, so its passthrough `return tag` puts the literal 'gpt-5.5' /
-- 'gpt-5.6' in that column. These model_id values must therefore match the tags verbatim; a row
-- keyed 'gpt-5.6-sol' would never join.
--
-- Rates are OpenAI's published STANDARD API pricing (the tier the synchronous Responses API bills
-- at — not batch, flex, or fast mode), read from developers.openai.com/api/docs/pricing on
-- 2026-08-20. Transcribed exactly as printed; not estimated or interpolated. Follow the B0-564
-- convention: if OpenAI changes a rate, INSERT a new (model_id, effective_date) row — never edit
-- or overwrite a historical one, or past runs get re-priced at today's rate.
--
-- 'gpt-5.6' is documented as an ALIAS for gpt-5.6-sol, so it is priced at sol's standard rate. If
-- OpenAI ever repoints that alias at gpt-5.6-terra ($2.00/$0.20/$12.00) or gpt-5.6-luna
-- ($0.20/$0.02/$1.20), this row goes silently wrong — the spread is up to 25x, so re-verify the
-- alias target before trusting cost for this tag over a long window. Pinning the dropdown to an
-- explicit variant id instead would remove that risk.

insert into public.model_pricing
  (model_id, input_cost_per_mtok, cached_input_cost_per_mtok, output_cost_per_mtok, effective_date, updated_by, notes)
values
  ('gpt-5.5', 5.00, 0.50, 30.00, '2026-08-20', 'seed_migration',
   'OpenAI published standard pricing, read 2026-08-20. NOTE: gpt-5.5 appears on the pricing page but was NOT found in the models catalog on the same date — verify it is still a servable model id before exposing it in the UI.'),
  ('gpt-5.6', 5.00, 0.50, 30.00, '2026-08-20', 'seed_migration',
   'OpenAI published standard pricing, read 2026-08-20. gpt-5.6 is an alias for gpt-5.6-sol; priced at sol standard rates. Re-verify if the alias target changes.')
on conflict (model_id, effective_date) do nothing;
