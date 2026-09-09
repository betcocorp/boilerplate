-- B0-899 — BEX_ANTHROPIC_MODEL: the Anthropic default row that `preview` resolves to, and the split
-- of the two per-vendor default rows that makes BEX_LLM_PROVIDER (B0-897) actually do something.
--
-- Before this migration `preview` had exactly one default row, BEX_RESPONSES_MODEL, and B0-908
-- widened its allowed_values to include the claude-* tags — so the fleet default vendor was implied
-- by whichever tag happened to be stored there, and the BEX_LLM_PROVIDER select was inert. From
-- B0-899 the resolver is resolveModel (~/lib/llm/resolve-model.ts):
--   BEX_LLM_PROVIDER = openai    → `preview` → BEX_RESPONSES_MODEL  (OpenAI tags only)
--   BEX_LLM_PROVIDER = anthropic → `preview` → BEX_ANTHROPIC_MODEL  (Anthropic tags only)
-- An explicit tag (gpt-4.1, claude-sonnet-5, …) bypasses the provider row: the vendor is implied by
-- the tag (modelProviderFor), never by the flag.
--
-- BEHAVIOUR-PRESERVING BY CONSTRUCTION. Step (a) seeds BEX_ANTHROPIC_MODEL with the claude-* value
-- BEX_RESPONSES_MODEL currently holds, if it holds one (live on 2026-09-08: claude-opus-5 with
-- BEX_LLM_PROVIDER already 'anthropic'), else the B0-899 code default claude-sonnet-5. Step (b) then
-- moves BEX_RESPONSES_MODEL back to an OpenAI tag. With provider=anthropic `preview` therefore still
-- resolves to the same claude id after the migration as before it; with provider=openai it resolves
-- to gpt-4.1-mini exactly as it did before B0-908 widened the row. Idempotent: the insert is
-- `on conflict do nothing`, the value reset only fires on a claude-* value, and the description /
-- allowed_values updates are plain overwrites.
--
-- The claude-sonnet-5 default is the B0-899 ticket's choice pending Tom Bird's sonnet-vs-opus
-- decision (B0-898 left it open); it is the gpt-4.1 tier equivalent and the cheaper of the two.
-- ANTHROPIC_API_KEY stays in env because it is a secret (B0-638); a claude-* default without the key
-- fails the first Claude call outright — there is no fallback provider.
--
-- `allowed_values` is advisory metadata POST /api/admin/settings validates writes against and
-- /admin/settings renders as a select — NOT a DB constraint. Each reader re-validates against its own
-- enum (isAnthropicModelTag / isOpenAiModelTag in ~/lib/constants/models.ts) and falls back to its
-- code default on an unrecognised value, so a stray value can never reach a provider as a model id.

-- (a) Seed the Anthropic default row, carrying over a claude-* value from BEX_RESPONSES_MODEL.
insert into public.settings (key, value, value_type, description, allowed_values)
select
  'BEX_ANTHROPIC_MODEL',
  coalesce(
    (
      select s.value
      from public.settings s
      where s.key = 'BEX_RESPONSES_MODEL'
        and s.value in ('claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5')
    ),
    'claude-sonnet-5'
  ),
  'string',
  'The ANTHROPIC_MODEL_TAGS tag that the "preview" tag (and any missing/empty modelTag) resolves to when BEX_LLM_PROVIDER is ''anthropic'' — the Anthropic counterpart of BEX_RESPONSES_MODEL (B0-899). Read by resolveModel (~/lib/llm/resolve-model.ts) via resolveAnthropicModelDefaultTag and re-resolved through resolveResponsesModel so a BEX_MODEL_CLAUDE_* env pin applies to preview too. Must be one of the Anthropic tags (B0-908 tiers: claude-haiku-4-5 ≈ gpt-4.1-mini, claude-sonnet-4-6 ≈ gpt-4o, claude-sonnet-5 ≈ gpt-4.1, claude-opus-4-8 ≈ gpt-5.5, claude-opus-5 ≈ gpt-5.6); an unrecognised value falls back to the code default claude-sonnet-5 (the B0-899 choice pending the sonnet-vs-opus decision). Ignored while BEX_LLM_PROVIDER is ''openai''; an explicit model tag on a chat or test run bypasses this row entirely. Chat runs on the AI SDK Anthropic provider (@ai-sdk/anthropic), single-shot calls on the Anthropic Messages API — both require ANTHROPIC_API_KEY in env, with no fallback provider.',
  array['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5']
on conflict (key) do nothing;

-- (b) BEX_RESPONSES_MODEL becomes the OpenAI default only: no preview, no claude-* tags.
update public.settings
set value = case when value like 'claude-%' then 'gpt-4.1-mini' else value end,
    allowed_values = array['gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6'],
    description = 'The OPENAI_MODEL_TAGS tag that the "preview" tag (and any missing/empty modelTag) resolves to when BEX_LLM_PROVIDER is ''openai'' — the OpenAI default ONLY (B0-899); the Anthropic default lives in BEX_ANTHROPIC_MODEL and BEX_LLM_PROVIDER picks which row preview reads. Read by resolveModel (~/lib/llm/resolve-model.ts) through resolveResponsesModel / resolveGenerationModelDefaultTag (~/lib/openai/client.ts), so the BEX_MODEL_GPT* env pins apply to preview too (B0-831). Must be one of gpt-4o, gpt-4.1-mini, gpt-4.1, gpt-5.5, gpt-5.6 — never preview itself, and since B0-899 never a claude-* tag: a claude value stored here is ignored and falls back to gpt-4.1-mini. Also the validator''s preview default and the grader fallbacks. An explicit model tag on a chat or test run bypasses this row entirely. Was free text under B0-757; moved off the BEX_RESPONSES_MODEL / OPENAI_BEX_MODEL env vars per B0-638/B0-757.',
    updated_at = now()
where key = 'BEX_RESPONSES_MODEL';

-- (c) BEX_LLM_PROVIDER is wired now — drop the "NOT YET WIRED" wording.
update public.settings
set description = 'Preferred LLM vendor for Bex: ''openai'' or ''anthropic''. Read by resolveModel (~/lib/llm/resolve-model.ts) to pick which default row the "preview" model tag (and any missing/empty modelTag) resolves to: BEX_RESPONSES_MODEL for ''openai'', BEX_ANTHROPIC_MODEL for ''anthropic'' (B0-899). That is its only effect — an explicit model tag (gpt-4.1, claude-sonnet-5, …) on a chat or test run bypasses it, because the vendor is implied by the tag, never by this flag. ''anthropic'' requires ANTHROPIC_API_KEY in env (a secret, so env not settings per B0-638). Read via getLlmProvider() (~/lib/settings/settings-service.ts); an unrecognized value is treated as ''openai''.',
    updated_at = now()
where key = 'BEX_LLM_PROVIDER';
