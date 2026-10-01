-- B0-908 — model_pricing rows for the three Anthropic tags that B0-806 did not seed.
--
-- ANTHROPIC_MODEL_TAGS (~/lib/constants/models.ts) now offers tier-for-tier Claude equivalents in
-- every model picker: gpt-4.1-mini→claude-haiku-4-5, gpt-4o→claude-sonnet-4-6, gpt-4.1→claude-sonnet-5,
-- gpt-5.5→claude-opus-4-8, gpt-5.6→claude-opus-5. claude-opus-5 and claude-sonnet-5 were priced by
-- the B0-806 migration (20260903210000) and are NOT touched here; this adds the other three.
--
-- Rows are keyed to the TAG string exactly like the gpt-5.x rows: B0-563 stamps our resolver's
-- return value into workflow_steps.output.model, and for an Anthropic tag that IS the Claude API id
-- (resolveResponsesModel returns it unchanged unless a BEX_MODEL_CLAUDE_* env pin is set — a pin
-- needs its own row, or the B0-565 cost views' INNER lateral join drops those steps entirely).
--
-- Rates are Anthropic first-party Claude API standard pricing as listed in the Anthropic model table
-- cached 2026-06-24 (input/output per MTok): Haiku 4.5 $1.00 / $5.00, Sonnet 4.6 $3.00 / $15.00,
-- Opus 4.8 $5.00 / $25.00. Cached rate = 10% of input (the documented prompt-cache READ price);
-- cache writes are not modelled by the B0-565 views. B0-564 convention: if Anthropic changes a
-- rate, INSERT a new (model_id, effective_date) row — never edit a historical one.

insert into public.model_pricing
  (model_id, input_cost_per_mtok, cached_input_cost_per_mtok, output_cost_per_mtok, effective_date, updated_by, notes)
values
  ('claude-haiku-4-5',  1.00, 0.10,  5.00, '2026-09-08', 'seed_migration',
   'Anthropic first-party Claude API standard pricing as listed in the Anthropic model table cached 2026-06-24 (input/output per MTok). Cached rate = 10% of input (documented prompt-cache READ price); cache writes not modelled. Anthropic equivalent of gpt-4.1-mini; B0-908.'),
  ('claude-sonnet-4-6', 3.00, 0.30, 15.00, '2026-09-08', 'seed_migration',
   'Anthropic first-party Claude API standard pricing as listed in the Anthropic model table cached 2026-06-24 (input/output per MTok). Cached rate = 10% of input (documented prompt-cache READ price); cache writes not modelled. Anthropic equivalent of gpt-4o; B0-908.'),
  ('claude-opus-4-8',   5.00, 0.50, 25.00, '2026-09-08', 'seed_migration',
   'Anthropic first-party Claude API standard pricing as listed in the Anthropic model table cached 2026-06-24 (input/output per MTok). Cached rate = 10% of input (documented prompt-cache READ price); cache writes not modelled. Anthropic equivalent of gpt-5.5; B0-908.')
on conflict (model_id, effective_date) do nothing;
