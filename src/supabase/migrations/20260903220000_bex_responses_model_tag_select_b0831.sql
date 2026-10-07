-- B0-831 — make BEX_RESPONSES_MODEL operate the same as BEX_ROUTER_MODEL: a BEX_MODEL_TAGS tag
-- rendered as a select, not free text.
--
-- B0-757 seeded this row with `allowed_values` NULL on purpose, so /admin/settings rendered a free
-- text field and `resolveGenerationModelDefaultTag` (~/lib/openai/client.ts) handed whatever string
-- was stored straight to the OpenAI API, guarding only against the literal string 'preview'. That
-- meant a typo saved at /admin/settings reached OpenAI as a non-existent model id and broke every
-- `preview` caller at once — live Bex chat's default picker value, the validator's `preview`
-- default, and the grader / failure-root-cause / category-classifier / competitor-extraction
-- fallbacks. BEX_ROUTER_MODEL (B0-786) and BEX_VALIDATOR_MODEL (B0-603) never had that hazard:
-- their allowed lists mirror BEX_MODEL_TAGS and their readers re-validate with isBexModelTag,
-- falling back to the default tag on anything else.
--
-- This migration brings BEX_RESPONSES_MODEL onto that same pattern. The reader now re-validates
-- the stored value against BEX_MODEL_TAGS and resolves the tag through resolveResponsesModel, so
-- the BEX_MODEL_GPT4O / GPT41 / GPT55 / GPT56 env pins apply to `preview` exactly as they do to
-- the router. "Pin an exact id without a deploy" is therefore still available — through those env
-- overrides, which is what they exist for — rather than by typing a raw id into this row.
--
-- `preview` is deliberately absent from allowed_values: this row is what `preview` resolves TO, so
-- storing it here would make resolveResponsesModel('preview') resolve to itself. The list is
-- BEX_MODEL_TAGS (~/lib/constants/models.ts) minus 'preview'.
--
-- Behaviour-preserving: the live value on 2026-09-03 is 'gpt-4.1-mini', which is a valid tag, so
-- nothing changes here. The first statement only fires where a row holds a value outside the list
-- (a dated snapshot, a typo) — a value the reader would now ignore in favour of the same
-- 'gpt-4.1-mini' default anyway — so it keeps the stored row honest with what actually runs rather
-- than changing behaviour further. As with every allowed_values list, this is advisory metadata the
-- admin API validates writes against and /admin/settings renders as a select — NOT a DB constraint
-- (only value_type has a CHECK), so the reader still re-validates the stored tag.
update public.settings
set value = 'gpt-4.1-mini', updated_at = now()
where key = 'BEX_RESPONSES_MODEL'
  and value not in ('gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6');

update public.settings
set allowed_values = array['gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5.5', 'gpt-5.6'],
    description = 'The BEX_MODEL_TAGS tag that the "preview" tag (and any missing/empty modelTag) resolves to via resolveResponsesModel (~/lib/openai/client.ts) — the fleet-wide default for live Bex chat, the validator''s preview default and the grader fallbacks. Must be one of BEX_MODEL_TAGS (~/lib/constants/models.ts) other than preview itself; resolved to a concrete OpenAI model id the same way BEX_ROUTER_MODEL is, so the BEX_MODEL_* env pins apply (B0-831). Was free text under B0-757; moved off the BEX_RESPONSES_MODEL / OPENAI_BEX_MODEL env vars per B0-638/B0-757.',
    updated_at = now()
where key = 'BEX_RESPONSES_MODEL';
