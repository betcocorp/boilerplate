-- B0-902 — TEST_ITEM_GRADING_MODEL / TEST_ITEM_GRADING_EFFORT: which model the PER-ITEM graders
-- of the eval harness use (semantic criteria grader — criteria-grader.ts; semantic decline grader —
-- decline-grader.ts; failure root-cause analyst — failure-root-cause.ts), and how hard an Anthropic
-- grader thinks. Read by `resolveItemGradingConfig` (~/lib/tests/item-grading-model.ts). Configured
-- in `public.settings` per B0-638 (never env) — the former BEX_GRADER_MODEL and
-- BEX_FAILURE_ROOT_CAUSE_MODEL env reads are deleted with this ticket.
--
-- Default 'run' preserves the pre-B0-902 behaviour exactly: each grader follows the run's own chat
-- model tag (`test_results.model`, `preview` when unset). Applying this migration changes nothing
-- until an admin picks a tag on /admin/settings.
--
-- allowed_values = 'run' + BEX_MODEL_TAGS (~/lib/constants/models.ts), same convention as
-- REPORT_GRADING_MODEL (B0-765/B0-908): advisory metadata the admin API validates writes against,
-- NOT a DB constraint — the reader re-validates and falls back to 'run' on anything unrecognised.
insert into public.settings (key, value, value_type, description, allowed_values) values
  (
    'TEST_ITEM_GRADING_MODEL',
    'run',
    'string',
    'Model tag for the per-item eval graders: semantic criteria grader, semantic decline grader and failure root-cause analyst (B0-902). ''run'' = follow the chat model the test run was started with (the pre-B0-902 behaviour). ''preview'' = the fleet default chosen by BEX_LLM_PROVIDER (BEX_RESPONSES_MODEL for openai, BEX_ANTHROPIC_MODEL for anthropic). A claude-* tag grades on the Anthropic Messages API and needs ANTHROPIC_API_KEY plus account credits — there is no fallback provider. OpenAI graders run at temperature 0 (root cause: 0.2); Claude Opus 5 / Sonnet 5 reject sampling controls, so no temperature is sent to Anthropic and TEST_ITEM_GRADING_EFFORT applies instead. Exact-match (regulated) criteria never reach any model. Resolved via resolveModel (~/lib/llm/resolve-model.ts); an unrecognised value is treated as ''run''.',
    array['run', 'preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5']
  ),
  (
    'TEST_ITEM_GRADING_EFFORT',
    'high',
    'string',
    'Anthropic output_config.effort for the per-item eval graders when TEST_ITEM_GRADING_MODEL (or the run''s own model, under ''run'') resolves to a claude-* model (B0-902). Anthropic-only: OpenAI models ignore it and nothing is recorded for them. Anthropic''s own default is high; xhigh/max buy depth for cost, low/medium the reverse. An unrecognised value is treated as ''high''.',
    array['low', 'medium', 'high', 'xhigh', 'max']
  )
on conflict (key) do nothing;
