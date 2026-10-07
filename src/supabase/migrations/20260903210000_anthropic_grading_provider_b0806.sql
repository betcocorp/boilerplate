-- B0-806 (B0-819–B0-821) — Anthropic as a run-report grading provider.
--
-- 1. REPORT_GRADING_MODEL may now name a Claude model. allowed_values widens to GRADING_MODEL_TAGS
--    (~/lib/constants/models.ts) = BEX_MODEL_TAGS + the two Anthropic grading tags. The VALUE is
--    deliberately left at gpt-5.6: the default flips to claude-opus-5 only after the parity
--    measurement (B0-822 / epic B0-807), not here. Applying this migration changes no behaviour.
--    Same convention as B0-765: allowed_values is advisory metadata the admin API validates writes
--    against and /admin/settings renders as a select — NOT a DB constraint. The Anthropic tags are
--    NOT added to BEX_VALIDATOR_MODEL / BEX_ROUTER_MODEL — those rows feed the OpenAI Responses
--    runtime, which cannot call a Claude id.
--
-- 2. REPORT_GRADING_EFFORT — Anthropic output_config.effort for grading (default 'high', Anthropic's
--    own default). Ignored by OpenAI models. Read once per report (loadGradingEffort,
--    src/lib/tests/report/grading-model.ts) and persisted on report_state.gradingEffort so a report
--    states the effort it was graded at; null there means the grading model had no such knob.
--
-- 3. model_pricing rows for the two tags, keyed to the TAG string exactly like the gpt-5.x rows
--    (B0-563 stamps our resolver's return value, and for an Anthropic tag that IS the Claude API id).
--    Rates are Anthropic's published Claude API standard pricing, read from
--    platform.claude.com/docs/en/about-claude/models/overview on 2026-09-03 and transcribed as
--    printed: Opus 5 $5 in / $25 out per MTok, Sonnet 5 $2 in / $10 out per MTok; prompt-cache
--    READS are documented as 10% of the base input price ($0.50 / $0.20). Cache WRITES (1.25x for
--    the 5-minute cache) are not modelled by the B0-565 views. Report grading calls are not
--    workflow_steps today, so these rows are forward-looking rather than load-bearing for /admin/cost;
--    per-call usage is logged as `llm_structured_completion`. B0-564 convention: if Anthropic changes
--    a rate, INSERT a new (model_id, effective_date) row — never edit a historical one.

update public.settings
set allowed_values = array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'claude-opus-5', 'claude-sonnet-5'],
    description = 'Model tag used for LLM run-report grading (case scoring, case-scorer.ts) and Top-3 findings synthesis (synthesizer.ts) in orchestrator.ts (B0-765). Must be one of GRADING_MODEL_TAGS (~/lib/constants/models.ts): an OpenAI tag resolves through resolveResponsesModel; a claude-* tag is called on the Anthropic Messages API as-is (B0-806) and honours REPORT_GRADING_EFFORT. Requires ANTHROPIC_API_KEY in env for the claude-* tags. Seeded gpt-5.6 (alias for gpt-5.6-sol) 2026-08-31; the default moves to claude-opus-5 after the parity measurement (B0-822).',
    updated_at = now()
where key = 'REPORT_GRADING_MODEL';

insert into public.settings (key, value, value_type, description, allowed_values)
values (
  'REPORT_GRADING_EFFORT',
  'high',
  'string',
  'Anthropic output_config.effort for run-report grading and synthesis when REPORT_GRADING_MODEL is a claude-* tag (B0-806): how much the model thinks before it answers. Ignored by OpenAI models. Default high (Anthropic''s own default); xhigh/max buy depth for cost and wall clock, low/medium the reverse. Read once per report and persisted on report_state.gradingEffort, so a report always states the effort it was graded at.',
  array['low', 'medium', 'high', 'xhigh', 'max']
)
on conflict (key) do nothing;

insert into public.model_pricing
  (model_id, input_cost_per_mtok, cached_input_cost_per_mtok, output_cost_per_mtok, effective_date, updated_by, notes)
values
  ('claude-opus-5',   5.00, 0.50, 25.00, '2026-09-03', 'seed_migration',
   'Anthropic published Claude API standard pricing, read 2026-09-03 from platform.claude.com/docs/en/about-claude/models/overview. Cached rate = documented prompt-cache READ price (10% of base input); cache writes not modelled. Run-report grading candidate (B0-806/B0-822).'),
  ('claude-sonnet-5', 2.00, 0.20, 10.00, '2026-09-03', 'seed_migration',
   'Anthropic published Claude API standard pricing, read 2026-09-03 from platform.claude.com/docs/en/about-claude/models/overview. Cached rate = documented prompt-cache READ price (10% of base input); cache writes not modelled. Run-report grading option (B0-806).')
on conflict (model_id, effective_date) do nothing;
