-- B0-899 follow-up — put the Anthropic tags back in BEX_RESPONSES_MODEL.
--
-- The first B0-899 migration (20260908231033) narrowed this row to the five OpenAI tags, on the
-- theory that the Anthropic default belonged solely in the new BEX_ANTHROPIC_MODEL row. That
-- removed a control that was in active use: setting BEX_RESPONSES_MODEL = claude-opus-5 was how the
-- fleet was put on Claude (B0-908 had widened it for exactly that), and narrowing it made the
-- Anthropic options disappear from the /admin/settings select while the value read gpt-4.1-mini.
-- Reverted here, per Tom 2026-09-08. Both controls now work.
--
-- PRECEDENCE for the `preview` tag, implemented in resolveModel (~/lib/llm/resolve-model.ts), which
-- is the single place it is defined:
--   1. BEX_RESPONSES_MODEL names a claude-* model -> that model. A named model is an explicit
--      choice and beats the vendor switch.
--   2. else BEX_LLM_PROVIDER = anthropic -> the BEX_ANTHROPIC_MODEL row (the vendor switch).
--   3. else -> BEX_RESPONSES_MODEL (OpenAI, unchanged).
-- So BEX_ANTHROPIC_MODEL answers "which Claude model when the switch is thrown", and is consulted
-- only while this row names an OpenAI model.
--
-- The VALUE is restored to claude-opus-5 as well: that is what this row held before 20260908231033
-- moved it into BEX_ANTHROPIC_MODEL, so `preview` resolves to the same id either way and this is a
-- no-op at runtime. It is restored so the row reads as the operator left it rather than as
-- gpt-4.1-mini, which looked like the fleet had reverted to OpenAI. Guarded so it only fires while
-- the row still holds the value that migration wrote.
--
-- allowed_values stays advisory metadata POST /api/admin/settings validates writes against and
-- /admin/settings renders as a select; it is NOT a DB constraint, and the reader
-- (resolveGenerationModelDefaultTag) re-validates against BEX_MODEL_TAGS and falls back to
-- gpt-4.1-mini on anything unrecognised. `preview` is excluded because it would resolve to itself.

update public.settings
set allowed_values = array['gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
    value = case when value = 'gpt-4.1-mini' then 'claude-opus-5' else value end,
    description = 'The BEX_MODEL_TAGS tag that the "preview" tag (and any missing/empty modelTag) resolves to — the fleet-wide default model for live Bex chat, the validator''s preview default and the grader fallbacks. Any explicit tag is allowed, OpenAI or claude-*; must not be "preview" itself, which would resolve to itself. A gpt-* tag is called on the OpenAI Responses API; a claude-* tag (B0-908: claude-haiku-4-5 = gpt-4.1-mini tier, claude-sonnet-4-6 = gpt-4o, claude-sonnet-5 = gpt-4.1, claude-opus-4-8 = gpt-5.5, claude-opus-5 = gpt-5.6) is the exact Claude API id, called on the Anthropic Messages API for single-shot calls and via @ai-sdk/anthropic for chat; both need ANTHROPIC_API_KEY in env and there is no fallback provider. PRECEDENCE for preview (resolveModel, ~/lib/llm/resolve-model.ts): a claude-* tag HERE wins outright, because naming a model is more specific than the BEX_LLM_PROVIDER vendor switch; only while this row names an OpenAI model does BEX_LLM_PROVIDER = anthropic redirect preview to the BEX_ANTHROPIC_MODEL row. Resolved via resolveResponsesModel, so the BEX_MODEL_* env pins apply (B0-831). Moved off the BEX_RESPONSES_MODEL / OPENAI_BEX_MODEL env vars per B0-638/B0-757. B0-899 briefly restricted this row to OpenAI tags; reverted 2026-09-08 per Tom because setting a Claude model here is an established way to move the fleet.',
    updated_at = now()
where key = 'BEX_RESPONSES_MODEL';

update public.settings
set description = 'The ANTHROPIC_MODEL_TAGS tag the "preview" tag resolves to when the BEX_LLM_PROVIDER vendor switch is set to anthropic AND BEX_RESPONSES_MODEL names an OpenAI model (B0-899). It answers "which Claude model do I use when the switch is thrown", so one row flips the whole fleet to Claude without retyping a model. It is NOT consulted when BEX_RESPONSES_MODEL already names a claude-* model — that is the more specific choice and wins; see the precedence rule in resolveModel (~/lib/llm/resolve-model.ts). Must be one of the five Anthropic tags; an unrecognised stored value falls back to claude-sonnet-5 rather than reaching the API as a non-existent model id. Requires ANTHROPIC_API_KEY in env (a secret, so env not settings per B0-638) plus funded Anthropic account credits — there is no fallback provider, so a claude-* default fails outright without them.',
    updated_at = now()
where key = 'BEX_ANTHROPIC_MODEL';

update public.settings
set description = 'Preferred LLM vendor for Bex: ''openai'' or ''anthropic'' — the vendor switch. Read by resolveModel (~/lib/llm/resolve-model.ts) when resolving the "preview" tag: set to ''anthropic'' it redirects preview to the BEX_ANTHROPIC_MODEL row, but ONLY while BEX_RESPONSES_MODEL names an OpenAI model. A claude-* tag in BEX_RESPONSES_MODEL is the more specific choice and wins over this row, and an explicit tag on the Bex picker or an /admin/tests run form bypasses both rows entirely (vendor is implied by the claude- prefix, never by this flag). An unrecognized value is treated as ''openai''. Seeded by B0-897; wired by B0-899.',
    updated_at = now()
where key = 'BEX_LLM_PROVIDER';
