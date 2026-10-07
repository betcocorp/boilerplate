-- B0-908 — every LLM model selector offers the Anthropic tier-for-tier equivalents.
--
-- BEX_MODEL_TAGS (~/lib/constants/models.ts) now includes ANTHROPIC_MODEL_TAGS (claude-haiku-4-5,
-- claude-sonnet-4-6, claude-sonnet-5, claude-opus-4-8, claude-opus-5), and GRADING_MODEL_TAGS
-- collapsed onto the same list. This widens allowed_values on the four model-tag rows to match:
--   BEX_ROUTER_MODEL, BEX_VALIDATOR_MODEL, REPORT_GRADING_MODEL — the full list, `preview` first;
--   BEX_RESPONSES_MODEL — the same list minus `preview`, on purpose: it is what `preview` resolves to
--   (B0-831), so it must never be `preview` itself.
-- VALUES are untouched — applying this migration changes no behaviour. Same convention as B0-765 /
-- B0-806: allowed_values is advisory metadata POST /api/admin/settings validates writes against and
-- /admin/settings renders as a select — NOT a DB constraint; each reader re-validates against the
-- enum and falls back to its default on an unrecognised value.
--
-- A claude-* tag is the exact Claude API id. Every consumer routes on modelProviderFor: single-shot
-- call sites (router, validator, grader) go through ~/lib/llm/structured-completion (OpenAI Responses
-- vs Anthropic Messages) and the Bex chat AI SDK loop uses @ai-sdk/anthropic. All of them require
-- ANTHROPIC_API_KEY in env (a secret, so env not settings per B0-638) — there is no fallback
-- provider, so a claude-* tag without the key fails outright.

update public.settings
set allowed_values = array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    description = 'Model tag for the intent/signals classifier call (B0-786). Must be one of BEX_MODEL_TAGS (~/lib/constants/models.ts), resolved to a concrete model id via resolveResponsesModel (~/lib/openai/client.ts): a gpt-* tag is called on the OpenAI Responses API; a claude-* tag (B0-908: claude-haiku-4-5 ≈ gpt-4.1-mini, claude-sonnet-4-6 ≈ gpt-4o, claude-sonnet-5 ≈ gpt-4.1, claude-opus-4-8 ≈ gpt-5.5, claude-opus-5 ≈ gpt-5.6) is the exact Claude API id and is called on the Anthropic Messages API via ~/lib/llm/structured-completion, which requires ANTHROPIC_API_KEY in env. Moved off the BEX_ROUTER_MODEL env var per B0-638. Set to gpt-4.1 2026-09-01 — the previous env/code default was gpt-4o-mini.',
    updated_at = now()
where key = 'BEX_ROUTER_MODEL';

update public.settings
set allowed_values = array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    description = 'Model tag the validator pass (runValidatorPass, ~/lib/workflows/product-support/validator.ts) calls when a run does not pass an explicit modelTag override. Must be one of BEX_MODEL_TAGS (~/lib/constants/models.ts), resolved to a concrete model id via resolveResponsesModel: a gpt-* tag is called on the OpenAI Responses API; a claude-* tag (B0-908: claude-haiku-4-5 ≈ gpt-4.1-mini, claude-sonnet-4-6 ≈ gpt-4o, claude-sonnet-5 ≈ gpt-4.1, claude-opus-4-8 ≈ gpt-5.5, claude-opus-5 ≈ gpt-5.6) is the exact Claude API id and is called on the Anthropic Messages API via ~/lib/llm/structured-completion, which requires ANTHROPIC_API_KEY in env. Moved off the BEX_VALIDATOR_MODEL env var per B0-638/B0-603 — that env var was never actually set, so this seed value (preview -> the BEX_RESPONSES_MODEL row) preserves the real prior default exactly.',
    updated_at = now()
where key = 'BEX_VALIDATOR_MODEL';

update public.settings
set allowed_values = array['preview', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    description = 'Model tag used for LLM run-report grading (case scoring, case-scorer.ts) and Top-3 findings synthesis (synthesizer.ts) in orchestrator.ts (B0-765). Default claude-opus-5 per Tom Bird 2026-09-03 (B0-822), matching the desktop agent-evaluation grading flow; the code fallback DEFAULT_GRADING_MODEL_TAG (src/lib/tests/report/grading-model.ts) is the same tag, so a missing row behaves identically. Must be one of GRADING_MODEL_TAGS (= BEX_MODEL_TAGS since B0-908, ~/lib/constants/models.ts): a gpt-* tag resolves through resolveResponsesModel (preview, the BEX_MODEL_* pins and the BEX_RESPONSES_MODEL row still apply) and is called on the OpenAI Responses API; a claude-* tag (B0-908: claude-haiku-4-5 ≈ gpt-4.1-mini, claude-sonnet-4-6 ≈ gpt-4o, claude-sonnet-5 ≈ gpt-4.1, claude-opus-4-8 ≈ gpt-5.5, claude-opus-5 ≈ gpt-5.6) is the exact Claude API id, is called on the Anthropic Messages API (B0-806) and honours REPORT_GRADING_EFFORT. claude-* tags require ANTHROPIC_API_KEY in env and Anthropic account credits - there is no fallback provider, so grading fails outright without them. Switch back to gpt-5.6 (alias for gpt-5.6-sol; the default from 2026-08-31 to 2026-09-03) here in /admin/settings if needed. Read once per report and persisted on report_state, so a change affects new reports only.',
    updated_at = now()
where key = 'REPORT_GRADING_MODEL';

update public.settings
set allowed_values = array['gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    description = 'The BEX_MODEL_TAGS tag that the "preview" tag (and any missing/empty modelTag) resolves to via resolveResponsesModel (~/lib/openai/client.ts) — the fleet-wide default for live Bex chat, the validator''s preview default and the grader fallbacks. Must be one of BEX_MODEL_TAGS (~/lib/constants/models.ts) other than preview itself; resolved to a concrete model id the same way BEX_ROUTER_MODEL is, so the BEX_MODEL_* env pins apply (B0-831). A gpt-* tag is called on the OpenAI Responses API; a claude-* tag (B0-908: claude-haiku-4-5 ≈ gpt-4.1-mini, claude-sonnet-4-6 ≈ gpt-4o, claude-sonnet-5 ≈ gpt-4.1, claude-opus-4-8 ≈ gpt-5.5, claude-opus-5 ≈ gpt-5.6) is the exact Claude API id and is called on the Anthropic Messages API for single-shot calls and via the AI SDK Anthropic provider (@ai-sdk/anthropic) for chat — both require ANTHROPIC_API_KEY in env. Was free text under B0-757; moved off the BEX_RESPONSES_MODEL / OPENAI_BEX_MODEL env vars per B0-638/B0-757.',
    updated_at = now()
where key = 'BEX_RESPONSES_MODEL';
